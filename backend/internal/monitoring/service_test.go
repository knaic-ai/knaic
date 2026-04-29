package monitoring

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPromQLAddsNamespaceTargetForUsage(t *testing.T) {
	query, unit, err := PromQL(QueryRequest{
		Scope:    ScopeNamespace,
		Target:   "team-ml",
		Resource: ResourceCPU,
		Kind:     KindUsage,
	})
	if err != nil {
		t.Fatalf("promql: %v", err)
	}
	if unit != "cores" {
		t.Fatalf("unit = %q, want cores", unit)
	}
	if !strings.Contains(query, `namespace="team-ml"`) {
		t.Fatalf("query did not include namespace target: %s", query)
	}
	if !strings.Contains(query, "container_cpu_usage_seconds_total") {
		t.Fatalf("query did not use cpu usage metric: %s", query)
	}
}

func TestQueryRangeParsesPrometheusMatrix(t *testing.T) {
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if r.URL.Query().Get("query") == "" {
			t.Fatalf("missing query parameter")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"status": "success",
			"data": {
				"resultType": "matrix",
				"result": [
					{"metric": {}, "values": [[1714280000, "1.5"], [1714280300, "2.25"]]}
				]
			}
		}`))
	}))
	defer server.Close()

	svc := NewService(server.URL, server.Client())
	series, err := svc.QueryRange(context.Background(), QueryRequest{
		Scope:    ScopeCluster,
		Target:   "cluster",
		Resource: ResourceCPU,
		Kind:     KindUsage,
		Start:    time.Unix(1714280000, 0),
		End:      time.Unix(1714280300, 0),
		Step:     5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("query range: %v", err)
	}
	if gotPath != "/api/v1/query_range" {
		t.Fatalf("path = %q, want /api/v1/query_range", gotPath)
	}
	if series.Source != SourcePrometheus || series.Unit != "cores" {
		t.Fatalf("unexpected metadata: %#v", series)
	}
	if len(series.Points) != 2 || series.Points[1].Value != 2.25 {
		t.Fatalf("unexpected points: %#v", series.Points)
	}
}
