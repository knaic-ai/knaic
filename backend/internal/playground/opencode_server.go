package playground

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// OpenCodeServerRunner talks to a long-lived `opencode serve` sidecar over
// HTTP instead of forking a fresh CLI per agent turn. Compared to the CLI
// runner it removes the bun cold-start latency (~1-2s) and gives us a real
// server-side session id so consecutive turns share LLM context inside one
// opencode session.
//
// The sidecar's config (provider catalog + agent definition) is STATIC for
// the lifetime of the process: opencode 1.14.41 does NOT hot-reload
// opencode.json from disk and PATCH /config does not persist provider
// additions. To accommodate runtime provider changes we:
//
//   - Pre-register a single opencode provider named "knaic" whose baseURL
//     points at this same knaic-api process at /api/v1/internal/openai/v1.
//     The knaic OpenAIProxy then dispatches to the actual upstream by
//     parsing the model id ("<knaic-provider-id>/<upstream-model>").
//   - Re-render opencode.json on every provider snapshot change and bounce
//     the sidecar via SIGTERM. shareProcessNamespace:true on the pod makes
//     the sidecar pid visible from this container; kubelet restarts it.
//
// Provider snapshot changes are rare (admin adds a model, cluster discovery
// resyncs); per-turn cost is one HTTP round trip to /session/:id/message.
type OpenCodeServerRunner struct {
	url           string
	configPath    string // opencode.json on shared volume; empty disables writes
	proxyURL      string // baseURL knaic-api advertises to opencode
	internalToken string // shared bearer the sidecar will send back to /internal/openai/v1
	agentName     string
	httpClient    *http.Client

	// SetOpenCodeSession is called once per knaic AgentSession to persist
	// the opencode-assigned session id. Empty means the caller manages
	// persistence elsewhere.
	persistSession func(ctx context.Context, knaicSessionID, openCodeSessionID string) error

	// providerSnapshot pulls the current knaic provider list so we can
	// rebuild opencode.json. Set by NewOpenCodeServerRunner.
	providerSnapshot func() []Provider

	mu       sync.Mutex
	snapHash string // sha256 of the last-written providers payload
}

type OpenCodeServerOptions struct {
	URL              string // e.g. http://127.0.0.1:4096
	ConfigPath       string // e.g. /etc/oc/opencode.json (shared with sidecar)
	ProxyURL         string // e.g. http://127.0.0.1:8080/api/v1/internal/openai/v1
	InternalToken    string // matches the token gating mountInternalOpenAI
	AgentName        string // defaults to "knaic-readonly"
	HTTPClient       *http.Client
	PersistSession   func(ctx context.Context, knaicSessionID, openCodeSessionID string) error
	ProviderSnapshot func() []Provider
}

func NewOpenCodeServerRunner(opts OpenCodeServerOptions) *OpenCodeServerRunner {
	if opts.AgentName == "" {
		opts.AgentName = defaultAgentName
	}
	if opts.HTTPClient == nil {
		// No global timeout: streaming /session/:id/message holds for the
		// length of the LLM response. Per-request deadlines flow via ctx.
		opts.HTTPClient = &http.Client{}
	}
	return &OpenCodeServerRunner{
		url:              strings.TrimRight(opts.URL, "/"),
		configPath:       opts.ConfigPath,
		proxyURL:         strings.TrimRight(opts.ProxyURL, "/"),
		internalToken:    opts.InternalToken,
		agentName:        opts.AgentName,
		httpClient:       opts.HTTPClient,
		persistSession:   opts.PersistSession,
		providerSnapshot: opts.ProviderSnapshot,
	}
}

// AttachService wires the runner into the live playground service so it can
// pull a provider snapshot and persist opencode session ids. Called from
// main.go after the service is constructed; safe to call once.
func (r *OpenCodeServerRunner) AttachService(svc *Service, store AgentStore) {
	if svc != nil {
		r.providerSnapshot = svc.snapshotProviders
	}
	if store != nil {
		r.persistSession = func(ctx context.Context, sessionID, openCodeSessionID string) error {
			return store.SetOpenCodeSession(ctx, sessionID, openCodeSessionID)
		}
	}
}

// EnsureConfig writes opencode.json reflecting the current provider snapshot.
// Idempotent — only touches disk + bounces the sidecar when the snapshot
// content actually changes. Safe to call at startup before the sidecar's
// first reachability check.
func (r *OpenCodeServerRunner) EnsureConfig() error {
	if r.configPath == "" {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.writeConfigLocked()
}

// Run implements AgentRunner.
func (r *OpenCodeServerRunner) Run(ctx context.Context, req AgentRunnerRequest, emit func(AgentEvent)) error {
	if req.Provider.ID == "" || req.Provider.Model == "" {
		return errors.New("provider id and model are required")
	}
	if err := r.ensureSnapshotCovers(req.Provider); err != nil {
		return err
	}
	sessionID, err := r.ensureOpenCodeSession(ctx, req)
	if err != nil {
		return err
	}
	return r.postMessage(ctx, sessionID, req, emit)
}

func (r *OpenCodeServerRunner) ensureSnapshotCovers(p Provider) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	// Rewrite unconditionally when we have a snapshot source; the hash
	// dedup avoids unnecessary bounces. We don't ONLY check if `p` is in
	// the snapshot because deletions and api-key rotations matter too.
	return r.writeConfigLocked()
}

// writeConfigLocked must be called with r.mu held.
func (r *OpenCodeServerRunner) writeConfigLocked() error {
	if r.providerSnapshot == nil || r.configPath == "" {
		return nil
	}
	providers := r.providerSnapshot()
	cfg := r.buildConfig(providers)
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	sum := sha256.Sum256(raw)
	hash := hex.EncodeToString(sum[:])
	if hash == r.snapHash {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(r.configPath), 0o755); err != nil {
		return err
	}
	tmp := r.configPath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, r.configPath); err != nil {
		return err
	}
	r.snapHash = hash
	slog.Info("opencode config written", "path", r.configPath, "bytes", len(raw), "providers", len(providers), "hash", hash[:12])
	if err := bounceOpenCodeSidecar(); err != nil {
		if errors.Is(err, errSidecarNotRunning) {
			// First-startup case: kubelet hasn't started the sidecar yet.
			// The new config will be picked up when it boots.
			slog.Info("opencode sidecar not running yet; will pick up config on boot")
			return nil
		}
		return fmt.Errorf("bounce opencode sidecar: %w", err)
	}
	slog.Info("opencode sidecar bounced for config reload")
	return nil
}

// buildConfig returns the static opencode config. Provider list is captured
// at write time; the sidecar gets a new copy on each rewrite.
//
// All knaic providers become entries under ONE opencode provider ("knaic")
// keyed by "<knaic-provider-id>/<upstream-model>". opencode's openai-
// compatible client will POST to ${proxyURL}/chat/completions with that
// composite as the model — the proxy then routes by id back to the actual
// upstream. tool_call:false suppresses the upstream tools/tool_choice that
// vLLM-without-`--enable-auto-tool-choice` rejects; we'll lift it once the
// platform standardises on tool-call-capable serving runtimes.
func (r *OpenCodeServerRunner) buildConfig(providers []Provider) map[string]any {
	// Sort by id so json.Marshal — which iterates map keys in sorted order
	// for top-level maps but not nested ones — produces a stable byte image
	// across calls. We need that for the snapshot-hash dedup to work.
	sort.Slice(providers, func(i, j int) bool { return providers[i].ID < providers[j].ID })
	models := map[string]any{}
	for _, p := range providers {
		key := p.ID + "/" + p.Model
		models[key] = map[string]any{
			"name":      p.Name + " — " + p.Model,
			"tool_call": false,
		}
	}
	// If no providers exist yet we still write a placeholder so opencode
	// loads the agent section cleanly. The placeholder model can't be
	// selected from the UI because we never list "knaic-placeholder" as a
	// knaic provider.
	if len(models) == 0 {
		models["placeholder/none"] = map[string]any{"name": "no providers configured", "tool_call": false}
	}
	return map[string]any{
		"$schema": "https://opencode.ai/config.json",
		"provider": map[string]any{
			"knaic": map[string]any{
				"npm":  "@ai-sdk/openai-compatible",
				"name": "Knaic",
				"options": map[string]any{
					"baseURL": r.proxyURL,
					"apiKey":  r.internalToken,
				},
				"models": models,
			},
		},
		"agent": map[string]any{
			r.agentName: map[string]any{
				"description": "Read-only chat agent for knaic LLM playground.",
				"mode":        "primary",
				"prompt":      agentPrompt(nil),
				// Disable EVERY tool. The `permission` field only gates whether
				// opencode lets a tool run; it still advertises them to the
				// LLM in the request's `tools` array, which the vLLM/SGLang
				// dev clusters reject without --enable-auto-tool-choice.
				// `tools: {"*": false}` is the legacy switch that actually
				// removes them from the request payload. We layer permission
				// on top so even a misconfigured runtime can't slip past.
				"tools": map[string]any{
					"*": false,
				},
				"permission": map[string]any{
					"bash":      "deny",
					"edit":      "deny",
					"write":     "deny",
					"webfetch":  "deny",
					"websearch": "deny",
					"read":      "deny",
					"list":      "deny",
					"glob":      "deny",
					"grep":      "deny",
					"todowrite": "deny",
				},
			},
		},
	}
}

func (r *OpenCodeServerRunner) ensureOpenCodeSession(ctx context.Context, req AgentRunnerRequest) (string, error) {
	if strings.HasPrefix(req.OpenCodeSession, "ses_") {
		return req.OpenCodeSession, nil
	}
	body, err := r.do(ctx, http.MethodPost, "/session", map[string]any{}, false)
	if err != nil {
		return "", fmt.Errorf("create opencode session: %w", err)
	}
	defer body.Close()
	var resp struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(body).Decode(&resp); err != nil {
		return "", fmt.Errorf("decode opencode session: %w", err)
	}
	if resp.ID == "" {
		return "", errors.New("opencode session created without an id")
	}
	if r.persistSession != nil && req.SessionID != "" {
		// Best-effort: session is usable even if persistence fails (next turn
		// will allocate a fresh one). We key by req.SessionID which is the
		// KNAIC AgentSession id — what AgentStore can look up.
		if err := r.persistSession(ctx, req.SessionID, resp.ID); err != nil {
			slog.Warn("persist opencode session id failed", "knaicSession", req.SessionID, "opencodeSession", resp.ID, "err", err)
		}
	}
	return resp.ID, nil
}

func (r *OpenCodeServerRunner) postMessage(ctx context.Context, openCodeSessionID string, req AgentRunnerRequest, emit func(AgentEvent)) error {
	body := map[string]any{
		"agent": r.agentName,
		"model": map[string]any{
			"providerID": "knaic",
			"modelID":    req.Provider.ID + "/" + req.Provider.Model,
		},
		"parts": []map[string]any{
			{"type": "text", "text": req.Message},
		},
	}
	resp, err := r.do(ctx, http.MethodPost, "/session/"+openCodeSessionID+"/message", body, false)
	if err != nil {
		return fmt.Errorf("opencode message: %w", err)
	}
	defer resp.Close()
	raw, err := io.ReadAll(resp)
	if err != nil {
		return fmt.Errorf("read opencode response: %w", err)
	}
	return emitFromMessageResponse(raw, emit)
}

// emitFromMessageResponse decodes the {info, parts} envelope opencode returns
// from POST /session/:id/message and translates each interesting part into an
// AgentEvent for the chat UI. We deliberately keep this lenient about field
// names because the message-part schema evolves across opencode point
// releases; anything we don't recognise becomes a "thought" event so the
// user still sees the trace.
func emitFromMessageResponse(raw []byte, emit func(AgentEvent)) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		emit(AgentEvent{Kind: "final", Text: "agent returned no output"})
		return nil
	}
	var env struct {
		Info  map[string]any   `json:"info"`
		Parts []map[string]any `json:"parts"`
		// Some opencode versions surface errors in info.error rather than
		// raising a non-2xx; we sweep both.
		Error any `json:"error"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		// Wasn't JSON. Surface the body verbatim so the user sees the
		// real failure mode (e.g. opencode crashed mid-stream).
		emit(AgentEvent{Kind: "error", Text: strings.TrimSpace(string(raw))})
		return nil
	}
	if env.Error != nil {
		emit(AgentEvent{Kind: "error", Text: fmt.Sprintf("%v", env.Error)})
	}
	if info := env.Info; info != nil {
		if e, ok := info["error"]; ok && e != nil {
			emit(AgentEvent{Kind: "error", Text: fmt.Sprintf("%v", e)})
		}
	}
	saw := 0
	for _, part := range env.Parts {
		kind, _ := part["type"].(string)
		switch kind {
		case "text":
			text, _ := part["text"].(string)
			if strings.TrimSpace(text) == "" {
				continue
			}
			emit(AgentEvent{Kind: "final", Text: text})
			saw++
		case "reasoning":
			text, _ := part["text"].(string)
			if strings.TrimSpace(text) != "" {
				emit(AgentEvent{Kind: "thought", Text: text})
			}
		case "tool":
			// Tool-call parts in opencode's schema. Surface as thought so
			// the UI shows the agent considered using a tool, even when
			// our config has them denied.
			name, _ := part["tool"].(string)
			emit(AgentEvent{Kind: "thought", ToolName: name, Text: "tool: " + name})
		case "error":
			text, _ := part["text"].(string)
			emit(AgentEvent{Kind: "error", Text: text})
		}
	}
	if saw == 0 && env.Error == nil {
		emit(AgentEvent{Kind: "final", Text: "agent produced no assistant text"})
	}
	return nil
}

// do builds the request, adds the internal bearer (opencode serve enables
// basic auth only when OPENCODE_SERVER_PASSWORD is set; we leave it off and
// rely on the sidecar binding 127.0.0.1 only), and returns the raw body.
func (r *OpenCodeServerRunner) do(ctx context.Context, method, path string, body any, stream bool) (io.ReadCloser, error) {
	var rdr io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, r.url+path, rdr)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if stream {
		req.Header.Set("Accept", "text/event-stream")
	}
	res, err := r.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		raw, _ := io.ReadAll(res.Body)
		res.Body.Close()
		return nil, fmt.Errorf("HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(raw)))
	}
	return res.Body, nil
}

// errSidecarNotRunning signals "nothing to signal" — distinct from a real
// failure to send the signal — so the first-write-before-sidecar-boots case
// in writeConfigLocked stays quiet.
var errSidecarNotRunning = errors.New("opencode sidecar not running")

// bounceOpenCodeSidecar walks /proc looking for a process whose argv starts
// with the opencode binary AND includes "serve". With shareProcessNamespace
// true on the pod this finds the sidecar; kubelet restarts the container
// when it exits (restartPolicy=Always at the pod level applies per
// container).
//
// We avoid pgrep / pidof — they aren't in distroless — and instead read
// /proc directly. The current process is skipped so a stray cmdline match
// (e.g. agent-mcp passing "opencode" in argv) never kills knaic-api itself.
func bounceOpenCodeSidecar() error {
	self := os.Getpid()
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return err
	}
	var candidates []string
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == self {
			continue
		}
		raw, err := os.ReadFile("/proc/" + e.Name() + "/cmdline")
		if err != nil {
			continue
		}
		// /proc/<pid>/cmdline is NUL-separated argv.
		args := strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")
		candidates = append(candidates, fmt.Sprintf("pid=%d argv0=%q", pid, firstOrEmpty(args)))
		if !looksLikeOpenCodeServe(args) {
			continue
		}
		slog.Info("opencode sidecar SIGTERM", "pid", pid, "argv0", firstOrEmpty(args))
		if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
			return fmt.Errorf("SIGTERM pid %d: %w", pid, err)
		}
		return nil
	}
	slog.Debug("opencode sidecar not in /proc", "scanned", len(candidates), "first10", candidates[:min(len(candidates), 10)])
	return errSidecarNotRunning
}

func firstOrEmpty(s []string) string {
	if len(s) == 0 {
		return ""
	}
	return s[0]
}

func looksLikeOpenCodeServe(argv []string) bool {
	if len(argv) < 2 {
		return false
	}
	if !strings.Contains(filepath.Base(argv[0]), "opencode") {
		return false
	}
	for _, a := range argv[1:] {
		if a == "serve" {
			return true
		}
	}
	return false
}

// Ready blocks until the sidecar answers GET /config or the deadline lapses.
// Useful at startup so the first user-facing request doesn't race the
// sidecar's bun bootstrap (~3-5s cold).
func (r *OpenCodeServerRunner) Ready(ctx context.Context) error {
	deadline := time.Now().Add(20 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		body, err := r.do(probeCtx, http.MethodGet, "/config", nil, false)
		cancel()
		if err == nil {
			body.Close()
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("opencode sidecar not ready: %w", err)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

