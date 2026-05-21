package playground

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const defaultAgentName = "knaic-readonly"

type OpenCodeOptions struct {
	Binary     string
	WorkDir    string
	APIBaseURL string
	MCPCommand []string
}

type OpenCodeRunner struct {
	opts OpenCodeOptions
}

func NewOpenCodeRunner(opts OpenCodeOptions) *OpenCodeRunner {
	if opts.Binary == "" {
		opts.Binary = "opencode"
	}
	if opts.WorkDir == "" {
		opts.WorkDir = filepath.Join(os.TempDir(), "knaic-agent")
	}
	if len(opts.MCPCommand) == 0 {
		if exe, err := os.Executable(); err == nil {
			opts.MCPCommand = []string{exe, "agent-mcp"}
		}
	}
	return &OpenCodeRunner{opts: opts}
}

func (r *OpenCodeRunner) Run(ctx context.Context, req AgentRunnerRequest, emit func(AgentEvent)) error {
	cmd, err := r.PrepareCommand(ctx, req)
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	var rawOut strings.Builder
	var rawErr strings.Builder
	finals := 0
	stdoutDone := make(chan error, 1)
	stderrDone := make(chan struct{}, 1)
	go func() {
		stdoutDone <- streamOpenCodeStdout(stdout, &rawOut, func(ev AgentEvent) {
			if ev.Kind == "final" {
				finals++
			}
			emit(ev)
		})
	}()
	go func() {
		streamOpenCodeStderr(stderr, &rawErr, emit)
		stderrDone <- struct{}{}
	}()
	parseErr := <-stdoutDone
	<-stderrDone
	waitErr := cmd.Wait()
	if parseErr != nil {
		return parseErr
	}
	if waitErr != nil {
		// Non-zero exit: bubble up stderr (and a stdout tail when stderr is
		// silent — bun/Node tools sometimes log to stdout under some flags).
		return errors.New(strings.TrimSpace(firstNonEmpty(tail(rawErr.String(), 2048), tail(rawOut.String(), 2048))) + ": " + waitErr.Error())
	}
	// Exit 0 but no assistant text emitted. Show whatever opencode wrote
	// (stderr warnings / stdout tail) so the user can see what happened
	// instead of a blank chat bubble. The streamOpenCodeStderr path
	// already surfaces WARN/ERROR lines, so this only fires when opencode
	// is completely silent.
	if finals == 0 {
		body := strings.TrimSpace(tail(rawOut.String(), 2048) + "\n" + tail(rawErr.String(), 2048))
		if body == "" {
			body = "agent produced no output (opencode exit 0, empty stdout/stderr)"
		}
		emit(AgentEvent{Kind: "final", Text: body})
	}
	return nil
}

// tail returns the last n bytes of s, prefixed with an ellipsis when
// truncated. Used to keep error / fallback output readable in the UI.
func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}

func (r *OpenCodeRunner) PrepareCommand(ctx context.Context, req AgentRunnerRequest) (*exec.Cmd, error) {
	if req.SessionID == "" {
		return nil, errors.New("session id is required")
	}
	if req.Message == "" {
		return nil, errors.New("message is required")
	}
	if req.Provider.Endpoint == "" || req.Provider.Model == "" {
		return nil, errors.New("provider endpoint and model are required")
	}
	sessionDir := filepath.Join(r.opts.WorkDir, safePathPart(req.SessionID))
	if err := os.MkdirAll(sessionDir, 0o700); err != nil {
		return nil, err
	}
	if err := r.writeConfig(sessionDir, req); err != nil {
		return nil, err
	}

	model := "knaic/" + req.Provider.Model
	// We use --format default rather than --format json because opencode
	// 1.14's JSON event shape (nested {part:{...}}) varies across point
	// releases and previously slipped past our decoder, leaving the chat
	// bubble blank. In default mode under non-TTY (our exec.Cmd case)
	// opencode writes the assistant's finished text directly to stdout
	// — one chunk per completed message — which is unambiguous to parse.
	// --print-logs + --log-level INFO routes opencode's internal
	// stage-by-stage logs to stderr so we can surface them as visible
	// thoughts (provider getSDK, llm request, mcp register, session
	// prompt loop, etc.). WARN-level wasn't enough: opencode can
	// successfully complete a run that produces no assistant text
	// (e.g. tool-only turn, empty completion) and emit nothing at WARN.
	// INFO is noisy but gives us — and the user — a real trace.
	// We intentionally do NOT pass --session. opencode's CLI uses the
	// session id verbatim if provided (it does NOT auto-create) and
	// then POSTs the message to a session its SQLite has never seen.
	// The server returns 200, the session status is immediately
	// "idle" (because there's no work queued for it), the event
	// stream closes, and opencode exits 0 with empty stdout — the
	// silent-failure mode we were debugging. Letting opencode create
	// its own session each turn fixes that. Conversation continuity
	// across turns lives in our agentStore (we render history in the
	// chat UI from there); cross-turn LLM context within a single
	// opencode invocation is a separate concern that the planned
	// `opencode serve` sidecar will solve properly.
	args := []string{
		"run",
		"--format", "default",
		"--print-logs",
		"--log-level", "INFO",
		"--agent", defaultAgentName,
		"--model", model,
		"--dir", sessionDir,
		req.Message,
	}
	cmd := exec.CommandContext(ctx, r.opts.Binary, args...)
	cmd.Dir = sessionDir
	env := cmd.Environ()
	env = append(env,
		"XDG_CONFIG_HOME="+filepath.Join(sessionDir, "config"),
		"XDG_DATA_HOME="+filepath.Join(sessionDir, "data"),
		"XDG_STATE_HOME="+filepath.Join(sessionDir, "state"),
		"KNAIC_AGENT_API_BASE="+firstNonEmpty(req.APIBaseURL, r.opts.APIBaseURL),
		"KNAIC_AGENT_TOKEN="+req.UserToken,
		"KNAIC_AGENT_NAMESPACE="+req.Namespace,
		"KNAIC_AGENT_SKILLS="+strings.Join(req.Skills, ","),
	)
	cmd.Env = env
	return cmd, nil
}

func (r *OpenCodeRunner) writeConfig(sessionDir string, req AgentRunnerRequest) error {
	if len(r.opts.MCPCommand) == 0 {
		return errors.New("mcp command is required")
	}
	cfg := map[string]any{
		"$schema": "https://opencode.ai/config.json",
		"provider": map[string]any{
			"knaic": map[string]any{
				"npm":  "@ai-sdk/openai-compatible",
				"name": req.Provider.Name,
				"options": map[string]any{
					"baseURL": req.Provider.Endpoint,
					"apiKey":  req.Provider.APIKey,
				},
				"models": map[string]any{
					req.Provider.Model: map[string]any{
						"name":      req.Provider.Model,
						"tool_call": true,
					},
				},
			},
		},
		"model": "knaic/" + req.Provider.Model,
		"agent": map[string]any{
			defaultAgentName: map[string]any{
				"description": "Read-only Kubernetes and AI platform operations agent for knaic.",
				"mode":        "primary",
				"prompt":      agentPrompt(req.Skills),
				"permission": map[string]any{
					"bash":               "deny",
					"edit":               "deny",
					"write":              "deny",
					"webfetch":           "deny",
					"websearch":          "deny",
					"read":               "allow",
					"list":               "allow",
					"glob":               "allow",
					"grep":               "allow",
					"todowrite":          "allow",
					"external_directory": "deny",
				},
			},
		},
		"mcp": map[string]any{
			"knaic-tools": map[string]any{
				"type":    "local",
				"command": r.opts.MCPCommand,
				"enabled": true,
				"timeout": 15000,
			},
		},
		"enabled_providers": []string{"knaic"},
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(sessionDir, "opencode.jsonc"), raw, 0o600)
}

// streamOpenCodeStdout reads opencode's --format default stdout: under a
// non-TTY parent (our exec.Cmd case) opencode writes each completed
// assistant text chunk to stdout, one per line. We forward each
// non-empty line as a "final" event so the chat UI streams them in.
func streamOpenCodeStdout(r io.Reader, raw *strings.Builder, emit func(AgentEvent)) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if raw != nil {
			raw.WriteString(line)
			raw.WriteByte('\n')
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		emit(AgentEvent{Kind: "final", Text: line})
	}
	return scanner.Err()
}

// streamOpenCodeStderr reads opencode's --print-logs --log-level WARN
// stream and surfaces ERROR / WARN lines so the user can see what
// opencode is doing instead of getting a silent blank bubble. Migration
// banners and known-benign warnings are dropped to keep the trace
// tidy.
func streamOpenCodeStderr(r io.Reader, raw *strings.Builder, emit func(AgentEvent)) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if raw != nil {
			raw.WriteString(line)
			raw.WriteByte('\n')
		}
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if isBenignOpenCodeNoise(trimmed) {
			continue
		}
		kind := classifyOpenCodeLog(trimmed)
		if kind == "" {
			continue
		}
		emit(AgentEvent{Kind: kind, Text: trimmed})
	}
}

func isBenignOpenCodeNoise(line string) bool {
	switch {
	// One-time SQLite migration on first run — already done before
	// any real work and not actionable.
	case strings.HasPrefix(line, "Performing one time database migration"),
		line == "sqlite-migration:done",
		line == "Database migration complete.":
		return true
	// background install of @opencode-ai/plugin is forkDetached and does
	// not block the main flow; the warning is just noise for the user.
	case strings.Contains(line, "background dependency install failed"):
		return true
	// Per-tool registry init logs ("tool.registry status=started/completed
	// duration=0 grep" etc.) fire ~20× per call and obscure the actually
	// interesting steps. Same for the internal event bus heartbeat.
	case strings.Contains(line, "service=tool.registry"),
		strings.Contains(line, "service=bus"):
		return true
	}
	return false
}

func classifyOpenCodeLog(line string) string {
	switch {
	case strings.HasPrefix(line, "ERROR"),
		strings.Contains(line, " ERROR "),
		strings.HasPrefix(line, "FATAL"):
		return "error"
	case strings.HasPrefix(line, "WARN"),
		strings.Contains(line, " WARN "):
		return "thought"
	case strings.HasPrefix(line, "INFO"),
		strings.HasPrefix(line, "DEBUG"):
		// We run with --log-level INFO so opencode's stage-by-stage
		// progress (provider getSDK, llm request, session.prompt loop)
		// shows in the trace as thoughts.
		return "thought"
	}
	// Unstructured stderr lines (banners, stack traces, etc.) — surface
	// as thoughts so the user has visibility.
	return "thought"
}

func agentPrompt(skills []string) string {
	return fmt.Sprintf(`You are the knaic Playground Agent.
You may inspect Kubernetes and AI platform state with the knaic MCP tools.
You must stay read-only: do not create, update, patch, delete, scale, restart, or mutate resources.
When using tools, explain what you checked and summarize the evidence.
Enabled skills: %s`, strings.Join(skills, ", "))
}

func safePathPart(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "session"
	}
	replacer := strings.NewReplacer("/", "_", "\\", "_", ":", "_", "..", "_")
	return replacer.Replace(s)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
