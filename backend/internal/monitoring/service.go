package monitoring

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Service struct {
	baseURL string
	client  *http.Client
	now     func() time.Time
}

func NewService(baseURL string, client *http.Client) *Service {
	if client == nil {
		client = http.DefaultClient
	}
	return &Service{
		baseURL: strings.TrimRight(baseURL, "/"),
		client:  client,
		now:     func() time.Time { return time.Now().UTC() },
	}
}

func (s *Service) QueryRange(ctx context.Context, req QueryRequest) (Series, error) {
	query, unit, err := PromQL(req)
	if err != nil {
		return Series{}, err
	}
	if req.End.IsZero() {
		req.End = s.now()
	}
	if req.Start.IsZero() {
		req.Start = req.End.Add(-3 * time.Hour)
	}
	if req.Step == 0 {
		req.Step = 5 * time.Minute
	}
	if s.baseURL == "" {
		series := synthetic(req, unit)
		series.Query = query
		return series, nil
	}
	u, err := url.Parse(s.baseURL + "/api/v1/query_range")
	if err != nil {
		return Series{}, err
	}
	q := u.Query()
	q.Set("query", query)
	q.Set("start", strconv.FormatInt(req.Start.Unix(), 10))
	q.Set("end", strconv.FormatInt(req.End.Unix(), 10))
	q.Set("step", strconv.FormatInt(int64(req.Step.Seconds()), 10))
	u.RawQuery = q.Encode()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return Series{}, err
	}
	res, err := s.client.Do(httpReq)
	if err != nil {
		return Series{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return Series{}, fmt.Errorf("prometheus query_range: HTTP %d", res.StatusCode)
	}
	points, err := decodePrometheusPoints(res)
	if err != nil {
		return Series{}, err
	}
	return Series{Points: points, Unit: unit, Source: SourcePrometheus, Query: query}, nil
}

func PromQL(req QueryRequest) (string, string, error) {
	unit, ok := units[req.Resource]
	if !ok {
		return "", "", fmt.Errorf("unknown resource %q", req.Resource)
	}
	filter, err := scopeFilter(req.Scope, req.Target)
	if err != nil {
		return "", "", err
	}
	switch req.Kind {
	case KindUsage:
		return usageQuery(req.Resource, filter), unit, nil
	case KindRequests:
		return quotaQuery("kube_pod_container_resource_requests", req.Resource, filter), unit, nil
	case KindLimits:
		return quotaQuery("kube_pod_container_resource_limits", req.Resource, filter), unit, nil
	default:
		return "", "", fmt.Errorf("unknown metric kind %q", req.Kind)
	}
}

var units = map[Resource]string{
	ResourceCPU:     "cores",
	ResourceMemory:  "GiB",
	ResourceGPU:     "GPUs",
	ResourceDisk:    "GiB",
	ResourceNetwork: "MiB/s",
}

func scopeFilter(scope Scope, target string) (string, error) {
	switch scope {
	case ScopeCluster:
		return "", nil
	case ScopeNode:
		if target == "" {
			return "", errors.New("target is required for node scope")
		}
		return `node="` + escapeLabel(target) + `"`, nil
	case ScopeNamespace:
		if target == "" {
			return "", errors.New("target is required for namespace scope")
		}
		return `namespace="` + escapeLabel(target) + `"`, nil
	case ScopePod:
		if target == "" {
			return "", errors.New("target is required for pod scope")
		}
		return `pod="` + escapeLabel(target) + `"`, nil
	default:
		return "", fmt.Errorf("unknown scope %q", scope)
	}
}

func usageQuery(resource Resource, filter string) string {
	f := joinFilters(filter, `container!=""`, `image!=""`)
	switch resource {
	case ResourceCPU:
		return "sum(rate(container_cpu_usage_seconds_total{" + f + "}[5m]))"
	case ResourceMemory:
		return "sum(container_memory_working_set_bytes{" + f + "}) / 1024 / 1024 / 1024"
	case ResourceGPU:
		return "sum(DCGM_FI_DEV_GPU_UTIL{" + filter + "}) / 100"
	case ResourceDisk:
		return "sum(container_fs_usage_bytes{" + f + "}) / 1024 / 1024 / 1024"
	case ResourceNetwork:
		return "sum(rate(container_network_receive_bytes_total{" + filter + "}[5m]) + rate(container_network_transmit_bytes_total{" + filter + "}[5m])) / 1024 / 1024"
	default:
		return ""
	}
}

func quotaQuery(metric string, resource Resource, filter string) string {
	resourceFilter := map[Resource]string{
		ResourceCPU:    `resource="cpu"`,
		ResourceMemory: `resource="memory"`,
		ResourceGPU:    `resource=~"nvidia_com_gpu|gpu"`,
		ResourceDisk:   `resource=~"ephemeral_storage|storage"`,
	}[resource]
	if resource == ResourceNetwork {
		return "0"
	}
	query := "sum(" + metric + "{" + joinFilters(filter, resourceFilter) + "})"
	if resource == ResourceMemory || resource == ResourceDisk {
		query += " / 1024 / 1024 / 1024"
	}
	return query
}

func joinFilters(parts ...string) string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, ",")
}

func escapeLabel(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`)
}

type promResponse struct {
	Status string `json:"status"`
	Data   struct {
		Result []struct {
			Values [][]any `json:"values"`
			Value  []any   `json:"value"`
		} `json:"result"`
	} `json:"data"`
	Error string `json:"error"`
}

func decodePrometheusPoints(res *http.Response) ([]Point, error) {
	var body promResponse
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, err
	}
	if body.Status != "success" {
		if body.Error == "" {
			body.Error = "prometheus query failed"
		}
		return nil, errors.New(body.Error)
	}
	if len(body.Data.Result) == 0 {
		return []Point{}, nil
	}
	raw := body.Data.Result[0].Values
	if len(raw) == 0 && len(body.Data.Result[0].Value) > 0 {
		raw = [][]any{body.Data.Result[0].Value}
	}
	points := make([]Point, 0, len(raw))
	for _, pair := range raw {
		if len(pair) != 2 {
			continue
		}
		ts, ok := numberFromAny(pair[0])
		if !ok {
			continue
		}
		val, ok := numberFromAny(pair[1])
		if !ok {
			continue
		}
		points = append(points, Point{
			Time:  time.Unix(int64(ts), 0).UTC().Format("15:04"),
			Value: val,
		})
	}
	return points, nil
}

func numberFromAny(v any) (float64, bool) {
	switch tv := v.(type) {
	case float64:
		return tv, true
	case string:
		f, err := strconv.ParseFloat(tv, 64)
		return f, err == nil
	default:
		return 0, false
	}
}

func synthetic(req QueryRequest, unit string) Series {
	points := 36
	if !req.Start.IsZero() && !req.End.IsZero() && req.Step > 0 {
		points = int(req.End.Sub(req.Start)/req.Step) + 1
	}
	if points <= 0 {
		points = 36
	}
	total := scale(req.Resource)
	rand := seededRand(string(req.Scope) + ":" + req.Target + ":" + string(req.Resource) + ":" + string(req.Kind))
	out := make([]Point, 0, points)
	start := req.Start
	if start.IsZero() {
		start = time.Now().UTC().Add(-time.Duration(points-1) * 5 * time.Minute)
	}
	step := req.Step
	if step == 0 {
		step = 5 * time.Minute
	}
	for i := 0; i < points; i++ {
		base := total * 0.5
		if req.Kind == KindRequests {
			base = total * 0.65
		}
		if req.Kind == KindLimits {
			base = total * 0.9
		}
		wiggle := (rand() - 0.5) * 0.3 * base
		pulse := math.Sin(float64(i)/3) * 0.08 * base
		v := math.Max(0, base+wiggle+pulse)
		out = append(out, Point{Time: start.Add(time.Duration(i) * step).UTC().Format("15:04"), Value: round2(v)})
	}
	return Series{Points: out, Unit: unit, Total: total, Source: SourceSynthetic}
}

func scale(resource Resource) float64 {
	switch resource {
	case ResourceCPU:
		return 64
	case ResourceMemory:
		return 512
	case ResourceGPU:
		return 16
	case ResourceDisk:
		return 4096
	case ResourceNetwork:
		return 200
	default:
		return 1
	}
}

func seededRand(seed string) func() float64 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(seed))
	state := h.Sum32()
	return func() float64 {
		state = state*1103515245 + 12345
		return float64((state>>16)&0x7fff) / 0x7fff
	}
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}
