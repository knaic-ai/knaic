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
		"--format default",
		"--print-logs",
		"--log-level INFO",
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

func TestStreamOpenCodeStdoutEmitsAssistantTextAsFinals(t *testing.T) {
	stdout := strings.Join([]string{
		"",
		"Hello from the agent.",
		"",
		"Cluster health is OK.",
	}, "\n")
	var raw strings.Builder
	var events []AgentEvent
	if err := streamOpenCodeStdout(strings.NewReader(stdout), &raw, func(ev AgentEvent) {
		events = append(events, ev)
	}); err != nil {
		t.Fatalf("streamOpenCodeStdout: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2: %#v", len(events), events)
	}
	for _, ev := range events {
		if ev.Kind != "final" {
			t.Fatalf("got %s event, want final: %#v", ev.Kind, ev)
		}
	}
	if events[0].Text != "Hello from the agent." || events[1].Text != "Cluster health is OK." {
		t.Fatalf("events = %#v", events)
	}
}

func TestStreamOpenCodeStderrSurfacesErrorsAndFiltersNoise(t *testing.T) {
	stderr := strings.Join([]string{
		"Performing one time database migration, may take a few minutes...",
		"sqlite-migration:done",
		"Database migration complete.",
		"INFO  2026-05-11T00:00:00 +0ms service=tool.registry status=completed duration=0 grep",
		"INFO  2026-05-11T00:00:00 +0ms service=bus type=session.status publishing",
		"INFO  2026-05-11T00:00:01 +1ms service=llm providerID=knaic modelID=x small=false stream",
		"WARN  2026-05-11T00:00:02 +2ms service=config background dependency install failed",
		"WARN  2026-05-11T00:00:03 +3ms service=session prompt rejected: upstream 404",
		"ERROR 2026-05-11T00:00:04 +4ms service=provider getSDK failed",
	}, "\n")
	var raw strings.Builder
	var events []AgentEvent
	streamOpenCodeStderr(strings.NewReader(stderr), &raw, func(ev AgentEvent) {
		events = append(events, ev)
	})
	// Expect: migration trio dropped, tool.registry + bus dropped, npm-install
	// WARN dropped, INFO llm + WARN session prompt + ERROR getSDK kept.
	if len(events) != 3 {
		t.Fatalf("got %d events, want 3: %#v", len(events), events)
	}
	if events[0].Kind != "thought" || !strings.Contains(events[0].Text, "service=llm") {
		t.Fatalf("events[0] = %#v, want thought with service=llm", events[0])
	}
	if events[1].Kind != "thought" || !strings.Contains(events[1].Text, "upstream 404") {
		t.Fatalf("events[1] = %#v, want thought with upstream 404", events[1])
	}
	if events[2].Kind != "error" || !strings.Contains(events[2].Text, "getSDK failed") {
		t.Fatalf("events[2] = %#v, want error with getSDK failed", events[2])
	}
}
