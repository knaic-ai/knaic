package monitoring

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Empty PROM URL → both bundle endpoints return synthetic data with the
// expected named series populated. Guards against regressions in the
// dev-mode fallback the prototype frontends used to render locally.
func TestQueryLLMSyntheticFallback(t *testing.T) {
	svc := NewService("", nil)
	bundle, err := svc.QueryLLM(context.Background(), LLMRequest{Namespace: "team-ml", Service: "qwen3-5-7b"})
	if err != nil {
		t.Fatalf("QueryLLM: %v", err)
	}
	if bundle.Source != SourceSynthetic {
		t.Fatalf("source = %q, want synthetic", bundle.Source)
	}
	for _, name := range []string{"tokensPerSec", "promptTokens", "completionTokens", "rps", "p50", "p95", "p99"} {
		s, ok := bundle.Series[name]
		if !ok {
			t.Fatalf("missing series %q", name)
		}
		if len(s.Points) == 0 {
			t.Fatalf("series %q has no points", name)
		}
		if s.Source != SourceSynthetic {
			t.Fatalf("series %q source = %q, want synthetic", name, s.Source)
		}
	}
}

func TestQueryTrainingSyntheticFallback(t *testing.T) {
	svc := NewService("", nil)
	bundle, err := svc.QueryTraining(context.Background(), TrainRequest{Namespace: "team-ml", Job: "llama3-finetune"})
	if err != nil {
		t.Fatalf("QueryTraining: %v", err)
	}
	if bundle.Source != SourceSynthetic {
		t.Fatalf("source = %q, want synthetic", bundle.Source)
	}
	for _, name := range []string{"gpuUtil", "gpuMemGiB", "hostCpu", "hostMemGiB", "netRxMiB", "netTxMiB"} {
		s, ok := bundle.Series[name]
		if !ok {
			t.Fatalf("missing series %q", name)
		}
		if len(s.Points) == 0 {
			t.Fatalf("series %q has no points", name)
		}
	}
}

// QueryLLM should reject a missing namespace/service rather than returning
// an empty bundle that masks the bad request.
func TestQueryLLMRequiresIdentifiers(t *testing.T) {
	svc := NewService("", nil)
	if _, err := svc.QueryLLM(context.Background(), LLMRequest{Namespace: "", Service: "foo"}); err == nil {
		t.Fatalf("expected error on missing namespace")
	}
	if _, err := svc.QueryLLM(context.Background(), LLMRequest{Namespace: "ns", Service: ""}); err == nil {
		t.Fatalf("expected error on missing service")
	}
}

// With a backend URL set, QueryLLM issues one Prometheus call per metric
// (seven today). Verifies that PromQL gets emitted and the responses get
// stitched into the named series map.
func TestQueryLLMHitsPrometheus(t *testing.T) {
	hits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		q := r.URL.Query().Get("query")
		if !strings.Contains(q, `namespace="team-ml"`) {
			t.Fatalf("namespace filter missing: %s", q)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[[1714280000,"1.5"]]}]}}`))
	}))
	defer server.Close()
	svc := NewService(server.URL, server.Client())
	bundle, err := svc.QueryLLM(context.Background(), LLMRequest{Namespace: "team-ml", Service: "qwen"})
	if err != nil {
		t.Fatalf("QueryLLM: %v", err)
	}
	if bundle.Source != SourcePrometheus {
		t.Fatalf("source = %q, want prometheus", bundle.Source)
	}
	if hits != len(llmSpecs) {
		t.Fatalf("upstream hits = %d, want %d", hits, len(llmSpecs))
	}
	if got := bundle.Series["tokensPerSec"].Points[0].Value; got != 1.5 {
		t.Fatalf("tokensPerSec[0] = %v, want 1.5", got)
	}
}
