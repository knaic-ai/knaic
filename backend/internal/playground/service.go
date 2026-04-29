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
)

var ErrNotFound = errors.New("provider not found")

type Service struct {
	mu        sync.RWMutex
	providers map[string]Provider
	counter   int64
	client    *http.Client
}

func NewService() *Service {
	return &Service{
		providers: map[string]Provider{},
		client:    &http.Client{Timeout: 60 * time.Second},
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
	defer s.mu.Unlock()
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
	return redactProvider(p), nil
}

func (s *Service) PatchProvider(_ context.Context, id string, patch ProviderPatch) (Provider, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.providers[id]
	if !ok {
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
	return redactProvider(p), nil
}

func (s *Service) DeleteProvider(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.providers[id]; !ok {
		return ErrNotFound
	}
	delete(s.providers, id)
	return nil
}

func (s *Service) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	provider, client, err := s.providerForChat(req.ProviderID)
	if err != nil {
		return ChatResponse{}, err
	}
	httpReq, err := newChatHTTPRequest(ctx, provider, req, false)
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
	httpReq, err := newChatHTTPRequest(ctx, provider, req, true)
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

func newChatHTTPRequest(ctx context.Context, provider Provider, req ChatRequest, stream bool) (*http.Request, error) {
	if len(req.Messages) == 0 {
		return nil, errors.New("messages are required")
	}
	body := map[string]any{
		"model":    provider.Model,
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

type openAIResponse struct {
	Choices []struct {
		Message struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}
