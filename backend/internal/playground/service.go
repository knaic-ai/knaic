package playground

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/knaic/knaic-backend/internal/auth"
)

var ErrNotFound = errors.New("provider not found")

type Service struct {
	mu          sync.RWMutex
	providers   map[string]Provider
	counter     int64
	client      *http.Client
	agentStore  AgentStore
	agentRunner AgentRunner
	// onProvidersChanged fires after every mutation to the provider set so
	// the OpenCodeServerRunner can rewrite opencode.json and bounce the
	// sidecar. Optional: nil means no subscriber, mutations proceed
	// normally.
	onProvidersChanged func()

	// modelCache holds the result of GET ${endpoint}/v1/models per provider
	// so we don't hammer the upstream on every chat. Invalidated on Patch /
	// Delete; entries also expire after modelCacheTTL so a redeploy of the
	// served model gets picked up without a backend restart.
	modelCacheMu sync.Mutex
	modelCache   map[string]modelCacheEntry
}

type modelCacheEntry struct {
	models  []string
	fetched time.Time
}

const modelCacheTTL = 5 * time.Minute

func NewService() *Service {
	return NewServiceWithAgentStore(NewMemoryAgentStore(), NewOpenCodeRunner(OpenCodeOptions{}))
}

func NewServiceWithAgentStore(store AgentStore, runner AgentRunner) *Service {
	if store == nil {
		store = NewMemoryAgentStore()
	}
	if runner == nil {
		runner = NewOpenCodeRunner(OpenCodeOptions{})
	}
	return &Service{
		providers:   map[string]Provider{},
		client:      &http.Client{Timeout: 60 * time.Second},
		agentStore:  store,
		agentRunner: runner,
		modelCache:  map[string]modelCacheEntry{},
	}
}

func (s *Service) SetHTTPClient(client *http.Client) {
	if client == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.client = client
}

// SetProvidersChangedHook registers a callback fired after every mutation to
// the provider set. The hook runs synchronously on the mutator's goroutine
// so it must be fast (or push to a channel); see OpenCodeServerRunner for
// the usage that motivated this.
func (s *Service) SetProvidersChangedHook(fn func()) {
	s.mu.Lock()
	s.onProvidersChanged = fn
	s.mu.Unlock()
}

// notifyProvidersChanged is called by mutation methods with s.mu UNLOCKED so
// the hook can take its own locks (e.g. snapshotProviders) without
// deadlocking against the writer.
func (s *Service) notifyProvidersChanged() {
	s.mu.RLock()
	fn := s.onProvidersChanged
	s.mu.RUnlock()
	if fn != nil {
		fn()
	}
}

func (s *Service) ListProviders(_ context.Context, namespace string) []Provider {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Provider, 0, len(s.providers))
	for _, p := range s.providers {
		if namespace != "" && p.Source == SourceCluster && p.Namespace != namespace {
			continue
		}
		out = append(out, redactProvider(p))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (s *Service) CreateProvider(_ context.Context, req ProviderRequest) (Provider, error) {
	if req.Name == "" || req.Endpoint == "" || req.Model == "" {
		return Provider{}, errors.New("name, endpoint and model are required")
	}
	if req.Source == "" {
		req.Source = SourceExternal
	}
	if req.Status == "" {
		req.Status = StatusReady
	}
	if _, err := url.ParseRequestURI(req.Endpoint); err != nil {
		return Provider{}, fmt.Errorf("invalid endpoint: %w", err)
	}
	s.mu.Lock()
	s.counter++
	p := Provider{
		ID:          fmt.Sprintf("llm-%06d", s.counter),
		Name:        req.Name,
		Source:      req.Source,
		Namespace:   req.Namespace,
		Endpoint:    strings.TrimRight(req.Endpoint, "/"),
		APIKey:      req.APIKey,
		Model:       req.Model,
		Description: req.Description,
		Status:      req.Status,
	}
	s.providers[p.ID] = p
	s.mu.Unlock()
	s.notifyProvidersChanged()
	return redactProvider(p), nil
}

func (s *Service) PatchProvider(_ context.Context, id string, patch ProviderPatch) (Provider, error) {
	s.mu.Lock()
	p, ok := s.providers[id]
	if !ok {
		s.mu.Unlock()
		return Provider{}, ErrNotFound
	}
	if patch.Name != nil {
		p.Name = *patch.Name
	}
	if patch.Source != nil {
		p.Source = *patch.Source
	}
	if patch.Namespace != nil {
		p.Namespace = *patch.Namespace
	}
	if patch.Endpoint != nil {
		if _, err := url.ParseRequestURI(*patch.Endpoint); err != nil {
			s.mu.Unlock()
			return Provider{}, fmt.Errorf("invalid endpoint: %w", err)
		}
		p.Endpoint = strings.TrimRight(*patch.Endpoint, "/")
	}
	if patch.APIKey != nil {
		p.APIKey = *patch.APIKey
	}
	if patch.Model != nil {
		p.Model = *patch.Model
	}
	if patch.Description != nil {
		p.Description = *patch.Description
	}
	if patch.Status != nil {
		p.Status = *patch.Status
	}
	s.providers[id] = p
	s.invalidateModelCache(id)
	s.mu.Unlock()
	s.notifyProvidersChanged()
	return redactProvider(p), nil
}

func (s *Service) DeleteProvider(_ context.Context, id string) error {
	s.mu.Lock()
	if _, ok := s.providers[id]; !ok {
		s.mu.Unlock()
		return ErrNotFound
	}
	delete(s.providers, id)
	s.invalidateModelCache(id)
	s.mu.Unlock()
	s.notifyProvidersChanged()
	return nil
}

func (s *Service) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	provider, client, err := s.providerForChat(req.ProviderID)
	if err != nil {
		return ChatResponse{}, err
	}
	model := s.resolveModel(ctx, provider, client)
	httpReq, err := newChatHTTPRequest(ctx, provider, model, req, false)
	if err != nil {
		return ChatResponse{}, err
	}
	res, err := client.Do(httpReq)
	if err != nil {
		return ChatResponse{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return ChatResponse{}, fmt.Errorf("llm provider %s: HTTP %d", provider.Name, res.StatusCode)
	}
	var parsed openAIResponse
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return ChatResponse{}, err
	}
	if len(parsed.Choices) == 0 {
		return ChatResponse{}, errors.New("llm provider returned no choices")
	}
	msg := parsed.Choices[0].Message
	return ChatResponse{
		Message: Message{Role: msg.Role, Content: msg.Content},
		Raw:     parsed,
	}, nil
}

func (s *Service) StreamChat(ctx context.Context, req ChatRequest) (ChatStream, error) {
	provider, client, err := s.providerForChat(req.ProviderID)
	if err != nil {
		return ChatStream{}, err
	}
	model := s.resolveModel(ctx, provider, client)
	httpReq, err := newChatHTTPRequest(ctx, provider, model, req, true)
	if err != nil {
		return ChatStream{}, err
	}
	res, err := client.Do(httpReq)
	if err != nil {
		return ChatStream{}, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		res.Body.Close()
		return ChatStream{}, fmt.Errorf("llm provider %s: HTTP %d", provider.Name, res.StatusCode)
	}
	ct := res.Header.Get("Content-Type")
	if ct == "" {
		ct = "text/event-stream"
	}
	return ChatStream{Body: res.Body, ContentType: ct}, nil
}

func (s *Service) providerForChat(id string) (Provider, *http.Client, error) {
	if id == "" {
		return Provider{}, nil, errors.New("providerId is required")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.providers[id]
	if !ok {
		return Provider{}, nil, ErrNotFound
	}
	if p.Status != "" && p.Status != StatusReady {
		return Provider{}, nil, fmt.Errorf("provider %q is not ready", p.Name)
	}
	return p, s.client, nil
}

func (s *Service) ListAgentSessions(ctx context.Context, u *auth.User, namespace string) ([]AgentSession, error) {
	return s.agentStore.ListSessions(ctx, ownerFromUser(u), namespace)
}

func (s *Service) CreateAgentSession(ctx context.Context, u *auth.User, req CreateAgentSessionRequest) (AgentSession, error) {
	if req.ProviderID == "" {
		return AgentSession{}, errors.New("providerId is required")
	}
	if _, _, err := s.providerForChat(req.ProviderID); err != nil {
		return AgentSession{}, err
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = "New agent session"
	}
	return s.agentStore.CreateSession(ctx, AgentSession{
		Owner:      ownerFromUser(u),
		Namespace:  req.Namespace,
		ProviderID: req.ProviderID,
		Title:      title,
		Skills:     req.Skills,
	})
}

func (s *Service) GetAgentSession(ctx context.Context, u *auth.User, id string) (AgentSession, error) {
	return s.agentStore.GetSession(ctx, ownerFromUser(u), id)
}

func (s *Service) DeleteAgentSession(ctx context.Context, u *auth.User, id string) error {
	return s.agentStore.DeleteSession(ctx, ownerFromUser(u), id)
}

func (s *Service) RunAgent(ctx context.Context, u *auth.User, sessionID string, req AgentRunRequest, runCtx AgentRunContext, emit func(AgentEvent)) error {
	msg := strings.TrimSpace(req.Message)
	if msg == "" {
		return errors.New("message is required")
	}
	session, err := s.agentStore.GetSession(ctx, ownerFromUser(u), sessionID)
	if err != nil {
		return err
	}
	provider, _, err := s.providerForChat(session.ProviderID)
	if err != nil {
		return err
	}
	if err := s.agentStore.AppendMessage(ctx, session.ID, AgentMessage{Role: "user", Content: msg}); err != nil {
		return err
	}
	namespace := firstNonEmpty(runCtx.Namespace, session.Namespace)
	var final strings.Builder
	err = s.agentRunner.Run(ctx, AgentRunnerRequest{
		SessionID:       session.ID,
		OpenCodeSession: session.OpenCodeSession,
		Message:         msg,
		Provider:        provider,
		UserToken:       runCtx.UserToken,
		Namespace:       namespace,
		Skills:          session.Skills,
		APIBaseURL:      runCtx.APIBaseURL,
	}, func(ev AgentEvent) {
		if ev.Kind == "final" {
			final.WriteString(ev.Text)
		}
		emit(ev)
	})
	if err != nil {
		return err
	}
	if strings.TrimSpace(final.String()) != "" {
		if err := s.agentStore.AppendMessage(ctx, session.ID, AgentMessage{Role: "assistant", Content: final.String()}); err != nil {
			return err
		}
	}
	return nil
}

func newChatHTTPRequest(ctx context.Context, provider Provider, model string, req ChatRequest, stream bool) (*http.Request, error) {
	if len(req.Messages) == 0 {
		return nil, errors.New("messages are required")
	}
	if model == "" {
		model = provider.Model
	}
	body := map[string]any{
		"model":    model,
		"messages": req.Messages,
	}
	if stream {
		body["stream"] = true
	}
	if req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}
	if req.MaxTokens != nil {
		body["max_tokens"] = *req.MaxTokens
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, provider.Endpoint+"/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if stream {
		httpReq.Header.Set("Accept", "text/event-stream")
	}
	if provider.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+provider.APIKey)
	}
	return httpReq, nil
}

func redactProvider(p Provider) Provider {
	p.APIKey = ""
	return p
}

// resolveModel decides which model id to put in the request body.
//
// The configured provider.Model is the user's stated preference (the
// InferenceService name in the discover() flow), but vLLM / SGLang only
// accept whatever was passed to --served-model-name at boot. When the two
// don't match the upstream returns 404. resolveModel asks the upstream
// what it actually serves via GET /v1/models and substitutes when needed.
//
// Failures (network / 404 / no models) fall back to the configured value
// — single-model deployments without /v1/models still work, and the
// caller still sees the upstream's original error rather than a confusing
// resolver-side one.
func (s *Service) resolveModel(ctx context.Context, provider Provider, client *http.Client) string {
	models := s.modelsFor(ctx, provider, client)
	if len(models) == 0 {
		return provider.Model
	}
	for _, m := range models {
		if m == provider.Model {
			return provider.Model
		}
	}
	return models[0]
}

func (s *Service) modelsFor(ctx context.Context, provider Provider, client *http.Client) []string {
	s.modelCacheMu.Lock()
	if entry, ok := s.modelCache[provider.ID]; ok && time.Since(entry.fetched) < modelCacheTTL {
		s.modelCacheMu.Unlock()
		return entry.models
	}
	s.modelCacheMu.Unlock()

	// Use a tighter timeout for the discovery hop than the chat client's
	// 60s — model listing is dirt cheap when it works, and we don't want
	// to stall the chat path on a hung upstream.
	discoveryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	models, err := fetchUpstreamModels(discoveryCtx, provider, client)
	if err != nil || len(models) == 0 {
		return nil
	}

	s.modelCacheMu.Lock()
	s.modelCache[provider.ID] = modelCacheEntry{models: models, fetched: time.Now()}
	s.modelCacheMu.Unlock()
	return models
}

func (s *Service) invalidateModelCache(id string) {
	s.modelCacheMu.Lock()
	delete(s.modelCache, id)
	s.modelCacheMu.Unlock()
}

// fetchUpstreamModels does a GET ${endpoint}/models. The OpenAI / vLLM /
// SGLang / TGI shape is `{"data": [{"id": "..."}, ...]}` — we accept the
// minimum required to extract ids and ignore the rest.
func fetchUpstreamModels(ctx context.Context, provider Provider, client *http.Client) ([]string, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, provider.Endpoint+"/models", nil)
	if err != nil {
		return nil, err
	}
	if provider.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+provider.APIKey)
	}
	res, err := client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("/v1/models: HTTP %d", res.StatusCode)
	}
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(body.Data))
	for _, m := range body.Data {
		if m.ID != "" {
			out = append(out, m.ID)
		}
	}
	return out, nil
}

type openAIResponse struct {
	Choices []struct {
		Message struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}
