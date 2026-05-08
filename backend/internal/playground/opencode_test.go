package playground

import (
	"context"
	"os"
	"strings"
	"testing"
)

func TestOpenCodeRunnerBuildsReadOnlyAgentCommandAndConfig(t *testing.T) {
	workDir := t.TempDir()
	r := NewOpenCodeRunner(OpenCodeOptions{
		Binary:     "opencode",
		WorkDir:    workDir,
		APIBaseURL: "http://127.0.0.1:8080",
		MCPCommand: []string{"/usr/local/bin/knaic-api", "agent-mcp"},
	})

	cmd, err := r.PrepareCommand(context.Background(), AgentRunnerRequest{
		SessionID: "agent-session-1",
		Message:   "summarize cluster health",
		Provider: Provider{
			ID:       "llm-1",
			Name:     "cluster-qwen",
			Endpoint: "http://qwen.team-ml.svc/v1",
			APIKey:   "secret",
			Model:    "Qwen/Qwen3.5-7B-Instruct",
			Status:   StatusReady,
		},
		UserToken: "bearer-token",
		Namespace: "team-ml",
		Skills:    []string{"cluster-health"},
	})
	if err != nil {
		t.Fatalf("PrepareCommand: %v", err)
	}

	joined := strings.Join(cmd.Args, " ")
	for _, want := range []string{
		"opencode",
		"run",
		"--format json",
		"--session agent-session-1",
		"--agent knaic-readonly",
		"--model knaic/Qwen/Qwen3.5-7B-Instruct",
		"summarize cluster health",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("command %q missing %q", joined, want)
		}
	}

	cfgPath := cmd.Dir + "/opencode.jsonc"
	cfg, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read generated config: %v", err)
	}
	config := string(cfg)
	for _, want := range []string{
		`"baseURL": "http://qwen.team-ml.svc/v1"`,
		`"apiKey": "secret"`,
		`"knaic-readonly"`,
		`"bash": "deny"`,
		`"knaic-tools"`,
		`"/usr/local/bin/knaic-api"`,
		`"agent-mcp"`,
	} {
		if !strings.Contains(config, want) {
			t.Fatalf("config missing %q:\n%s", want, config)
		}
	}
	env := strings.Join(cmd.Env, "\n")
	for _, want := range []string{
		"XDG_DATA_HOME=" + cmd.Dir + "/data",
		"KNAIC_AGENT_API_BASE=http://127.0.0.1:8080",
		"KNAIC_AGENT_TOKEN=bearer-token",
		"KNAIC_AGENT_NAMESPACE=team-ml",
		"KNAIC_AGENT_SKILLS=cluster-health",
	} {
		if !strings.Contains(env, want) {
			t.Fatalf("env missing %q:\n%s", want, env)
		}
	}
}

func TestDecodeOpenCodeEventEmitsNestedError(t *testing.T) {
	ev := decodeOpenCodeEvent(`{"type":"error","error":{"name":"UnknownError","data":{"message":"Command not found"}}}`)
	if ev.Kind != "error" || ev.Text != "Command not found" {
		t.Fatalf("event = %#v, want nested error text", ev)
	}
}
