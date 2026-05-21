package monitoring

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/knaic/knaic-backend/internal/auth"
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

// fakeUpstream records the Authorization header from each request and
// returns an empty Prometheus matrix.
func fakeUpstream() (*httptest.Server, *string) {
	captured := new(string)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*captured = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`))
	}))
	return server, captured
}

func makeReq() QueryRequest {
	return QueryRequest{
		Scope:    ScopeCluster,
		Target:   "cluster",
		Resource: ResourceCPU,
		Kind:     KindUsage,
		Start:    time.Unix(1714280000, 0),
		End:      time.Unix(1714280300, 0),
		Step:     5 * time.Minute,
	}
}

// Default = no auth — knaic must not invent an Authorization header when
// the upstream is open (e.g. in-cluster Prometheus).
func TestQueryRangeAuthNoneOmitsHeader(t *testing.T) {
	server, captured := fakeUpstream()
	defer server.Close()
	svc := NewService(server.URL, server.Client())
	if _, err := svc.QueryRange(context.Background(), makeReq()); err != nil {
		t.Fatalf("query: %v", err)
	}
	if *captured != "" {
		t.Fatalf("Authorization should be empty, got %q", *captured)
	}
}

// AuthForwardOIDC reads the bearer that auth.Verifier.Middleware stashed in
// the request context and forwards it to the upstream — that's how the
// query reaches an oauth2-proxy-fronted vmselect.
func TestQueryRangeAuthForwardOIDC(t *testing.T) {
	server, captured := fakeUpstream()
	defer server.Close()
	svc := NewServiceWithOptions(server.URL, server.Client(), Options{AuthMode: AuthForwardOIDC})
	ctx := auth.WithBearer(context.Background(), "user-jwt-abc")
	if _, err := svc.QueryRange(ctx, makeReq()); err != nil {
		t.Fatalf("query: %v", err)
	}
	if *captured != "Bearer user-jwt-abc" {
		t.Fatalf("Authorization = %q, want Bearer user-jwt-abc", *captured)
	}
}

// When AuthForwardOIDC is configured but the caller didn't supply a token
// (e.g. background sweep, non-authenticated route), the static fallback
// kicks in so the upstream call still authenticates.
func TestQueryRangeAuthForwardOIDCFallsBackToStatic(t *testing.T) {
	server, captured := fakeUpstream()
	defer server.Close()
	svc := NewServiceWithOptions(server.URL, server.Client(), Options{
		AuthMode:     AuthForwardOIDC,
		StaticBearer: "fallback-sa-token",
	})
	if _, err := svc.QueryRange(context.Background(), makeReq()); err != nil {
		t.Fatalf("query: %v", err)
	}
	if *captured != "Bearer fallback-sa-token" {
		t.Fatalf("Authorization = %q, want Bearer fallback-sa-token", *captured)
	}
}

// AuthStaticBearer always sends the configured token, even when the caller
// has their own — used for service-account-style upstreams.
func TestQueryRangeAuthStaticBearerIgnoresCallerToken(t *testing.T) {
	server, captured := fakeUpstream()
	defer server.Close()
	svc := NewServiceWithOptions(server.URL, server.Client(), Options{
		AuthMode:     AuthStaticBearer,
		StaticBearer: "fixed-sa-token",
	})
	ctx := auth.WithBearer(context.Background(), "user-jwt-abc")
	if _, err := svc.QueryRange(ctx, makeReq()); err != nil {
		t.Fatalf("query: %v", err)
	}
	if *captured != "Bearer fixed-sa-token" {
		t.Fatalf("Authorization = %q, want Bearer fixed-sa-token", *captured)
	}
}
