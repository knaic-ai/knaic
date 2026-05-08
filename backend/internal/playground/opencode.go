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
	var finalText strings.Builder
	parseDone := make(chan error, 1)
	go func() {
		parseDone <- parseOpenCodeEvents(stdout, emit, &finalText)
	}()
	errText, _ := io.ReadAll(stderr)
	parseErr := <-parseDone
	waitErr := cmd.Wait()
	if parseErr != nil {
		return parseErr
	}
	if waitErr != nil {
		return errors.New(strings.TrimSpace(string(errText)) + ": " + waitErr.Error())
	}
	if strings.TrimSpace(finalText.String()) == "" {
		return nil
	}
	return nil
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
	args := []string{
		"run",
		"--format", "json",
		"--session", req.SessionID,
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

func parseOpenCodeEvents(r io.Reader, emit func(AgentEvent), finalText *strings.Builder) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		ev := decodeOpenCodeEvent(line)
		if ev.Kind == "" {
			continue
		}
		if ev.Kind == "final" {
			finalText.WriteString(ev.Text)
		}
		emit(ev)
	}
	return scanner.Err()
}

func decodeOpenCodeEvent(line string) AgentEvent {
	var raw map[string]any
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return AgentEvent{Kind: "final", Text: line}
	}
	text := firstString(raw, "content", "message", "text", "summary")
	eventType := strings.ToLower(firstString(raw, "type", "event", "kind"))
	toolName := firstString(raw, "tool", "toolName", "name")
	switch {
	case strings.Contains(eventType, "error"):
		return AgentEvent{
			Kind: "error",
			Text: firstNonEmpty(
				text,
				nestedString(raw, "error", "data", "message"),
				nestedString(raw, "error", "message"),
				nestedString(raw, "error", "name"),
			),
		}
	case strings.Contains(eventType, "tool") && strings.Contains(eventType, "result"):
		return AgentEvent{Kind: "observation", Text: text, ToolName: toolName}
	case strings.Contains(eventType, "tool"):
		return AgentEvent{Kind: "action", Text: text, ToolName: toolName}
	case strings.Contains(eventType, "assistant") || strings.Contains(eventType, "message") || text != "":
		return AgentEvent{Kind: "final", Text: text}
	default:
		return AgentEvent{}
	}
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

func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok {
			return v
		}
	}
	return ""
}

func nestedString(m map[string]any, path ...string) string {
	var cur any = m
	for _, key := range path {
		next, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		cur = next[key]
	}
	if s, ok := cur.(string); ok {
		return s
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
