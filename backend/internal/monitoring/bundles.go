package monitoring

import (
	"context"
	"errors"
	"math"
	"strconv"
	"time"
)

// Bundle is the response shape for the LLM and TrainJob monitoring endpoints.
// Each named series shares the time axis and step but has its own unit.
type Bundle struct {
	Namespace string            `json:"namespace"`
	Target    string            `json:"target"`
	Source    Source            `json:"source"`
	Series    map[string]Series `json:"series"`
}

// LLMRequest selects an InferenceService / LLMInferenceService for the LLM
// monitoring bundle. PodSelector is the pod-label selector that the
// underlying KServe / vLLM exporter uses; when empty the handler builds a
// reasonable default from {Namespace, Service}.
type LLMRequest struct {
	Namespace string
	Service   string
	Start     time.Time
	End       time.Time
	Step      time.Duration
}

// TrainRequest selects a TrainJob for the training bundle.
type TrainRequest struct {
	Namespace string
	Job       string
	Start     time.Time
	End       time.Time
	Step      time.Duration
}

// llmSeriesSpec is one named series in the LLM bundle: a PromQL query plus
// the unit shown in the UI and the synthetic-fallback shape.
type llmSeriesSpec struct {
	Name      string
	Unit      string
	PromQL    func(ns, svc string) string
	Synthetic func(rand func() float64, i int) float64
}

// trainSeriesSpec is the analogous spec for the training bundle.
type trainSeriesSpec struct {
	Name      string
	Unit      string
	PromQL    func(ns, job string) string
	Synthetic func(rand func() float64, i int) float64
}

// llmSpecs lists the metrics surfaced on the LLM monitoring page. Default
// PromQL targets vLLM's openmetrics export (`vllm:` prefix) labelled by
// namespace + model_name; the Synthetic generators reproduce the prior
// in-frontend mock so dev mode looks identical to before.
var llmSpecs = []llmSeriesSpec{
	{
		Name: "tokensPerSec",
		Unit: "tok/s",
		PromQL: func(ns, svc string) string {
			f := joinFilters(`namespace="`+escapeLabel(ns)+`"`, `model_name="`+escapeLabel(svc)+`"`)
			return "sum(rate(vllm:generation_tokens_total{" + f + "}[5m]))"
		},
		Synthetic: func(rand func() float64, i int) float64 {
			load := llmLoad(rand, i)
			return round2(950*load + (rand()-0.5)*60)
		},
	},
	{
		Name: "promptTokens",
		Unit: "tokens",
		PromQL: func(ns, svc string) string {
			f := joinFilters(`namespace="`+escapeLabel(ns)+`"`, `model_name="`+escapeLabel(svc)+`"`)
			return "sum(increase(vllm:prompt_tokens_total{" + f + "}[5m]))"
		},
		Synthetic: func(rand func() float64, i int) float64 {
			return round2(180 * llmLoad(rand, i) * 60)
		},
	},
	{
		Name: "completionTokens",
		Unit: "tokens",
		PromQL: func(ns, svc string) string {
			f := joinFilters(`namespace="`+escapeLabel(ns)+`"`, `model_name="`+escapeLabel(svc)+`"`)
			return "sum(increase(vllm:generation_tokens_total{" + f + "}[5m]))"
		},
		Synthetic: func(rand func() float64, i int) float64 {
			return round2(220 * llmLoad(rand, i) * 60)
		},
	},
	{
		Name: "rps",
		Unit: "rps",
		PromQL: func(ns, svc string) string {
			f := joinFilters(`namespace="`+escapeLabel(ns)+`"`, `model_name="`+escapeLabel(svc)+`"`)
			return "sum(rate(vllm:request_success_total{" + f + "}[5m]))"
		},
		Synthetic: func(rand func() float64, i int) float64 {
			return round2(20 * llmLoad(rand, i))
		},
	},
	{
		Name: "p50",
		Unit: "ms",
		PromQL: func(ns, svc string) string {
			return latencyQuantile(ns, svc, 0.5)
		},
		Synthetic: func(rand func() float64, i int) float64 {
			return round2(80 + 40*llmLoad(rand, i) + (rand()-0.5)*10)
		},
	},
	{
		Name: "p95",
		Unit: "ms",
		PromQL: func(ns, svc string) string {
			return latencyQuantile(ns, svc, 0.95)
		},
		Synthetic: func(rand func() float64, i int) float64 {
			p50 := 80 + 40*llmLoad(rand, i)
			return round2(p50*1.8 + rand()*30)
		},
	},
	{
		Name: "p99",
		Unit: "ms",
		PromQL: func(ns, svc string) string {
			return latencyQuantile(ns, svc, 0.99)
		},
		Synthetic: func(rand func() float64, i int) float64 {
			p50 := 80 + 40*llmLoad(rand, i)
			p95 := p50*1.8 + rand()*30
			return round2(p95*1.2 + rand()*50)
		},
	},
}

// trainSpecs lists the metrics surfaced on the train-job monitoring page.
// PromQL defaults pull DCGM (GPU util/mem) and cAdvisor (host cpu/mem,
// network) filtered to pods that carry the Trainer-v2 job label.
var trainSpecs = []trainSeriesSpec{
	{
		Name: "gpuUtil",
		Unit: "%",
		PromQL: func(ns, job string) string {
			f := joinFilters(
				`exported_namespace="`+escapeLabel(ns)+`"`,
				`exported_pod=~"`+escapeLabel(job)+`-.*"`,
			)
			return "avg(DCGM_FI_DEV_GPU_UTIL{" + f + "})"
		},
		Synthetic: func(rand func() float64, i int) float64 {
			phase := math.Sin(float64(i) / 5)
			v := math.Min(100, math.Max(0, 78+phase*18+(rand()-0.5)*6))
			return round2(v)
		},
	},
	{
		Name: "gpuMemGiB",
		Unit: "GiB",
		PromQL: func(ns, job string) string {
			f := joinFilters(
				`exported_namespace="`+escapeLabel(ns)+`"`,
				`exported_pod=~"`+escapeLabel(job)+`-.*"`,
			)
			// DCGM reports framebuffer used in MiB; convert to GiB.
			return "sum(DCGM_FI_DEV_FB_USED{" + f + "}) / 1024"
		},
		Synthetic: func(rand func() float64, i int) float64 {
			phase := math.Sin(float64(i) / 5)
			return round2(36 + phase*4 + (rand()-0.5)*2)
		},
	},
	{
		Name: "hostCpu",
		Unit: "cores",
		PromQL: func(ns, job string) string {
			f := joinFilters(
				`namespace="`+escapeLabel(ns)+`"`,
				`pod=~"`+escapeLabel(job)+`-.*"`,
				`container!=""`,
				`image!=""`,
			)
			return "sum(rate(container_cpu_usage_seconds_total{" + f + "}[5m]))"
		},
		Synthetic: func(rand func() float64, i int) float64 {
			phase := math.Sin(float64(i) / 5)
			return round2(8 + phase*2 + (rand() - 0.5))
		},
	},
	{
		Name: "hostMemGiB",
		Unit: "GiB",
		PromQL: func(ns, job string) string {
			f := joinFilters(
				`namespace="`+escapeLabel(ns)+`"`,
				`pod=~"`+escapeLabel(job)+`-.*"`,
				`container!=""`,
				`image!=""`,
			)
			return "sum(container_memory_working_set_bytes{" + f + "}) / 1024 / 1024 / 1024"
		},
		Synthetic: func(rand func() float64, i int) float64 {
			phase := math.Sin(float64(i) / 5)
			return round2(48 + phase*6 + (rand()-0.5)*4)
		},
	},
	{
		Name: "netRxMiB",
		Unit: "MiB/s",
		PromQL: func(ns, job string) string {
			f := joinFilters(
				`namespace="`+escapeLabel(ns)+`"`,
				`pod=~"`+escapeLabel(job)+`-.*"`,
			)
			return "sum(rate(container_network_receive_bytes_total{" + f + "}[5m])) / 1024 / 1024"
		},
		Synthetic: func(rand func() float64, i int) float64 {
			phase := math.Sin(float64(i) / 5)
			return round2(420 + phase*80 + (rand()-0.5)*60)
		},
	},
	{
		Name: "netTxMiB",
		Unit: "MiB/s",
		PromQL: func(ns, job string) string {
			f := joinFilters(
				`namespace="`+escapeLabel(ns)+`"`,
				`pod=~"`+escapeLabel(job)+`-.*"`,
			)
			return "sum(rate(container_network_transmit_bytes_total{" + f + "}[5m])) / 1024 / 1024"
		},
		Synthetic: func(rand func() float64, i int) float64 {
			phase := math.Sin(float64(i) / 5)
			return round2(380 + phase*70 + (rand()-0.5)*60)
		},
	},
}

func latencyQuantile(ns, svc string, q float64) string {
	f := joinFilters(`namespace="`+escapeLabel(ns)+`"`, `model_name="`+escapeLabel(svc)+`"`)
	// histogram_quantile expects sum-by-le rate of buckets; multiply by 1000 to
	// convert seconds → ms.
	return "1000 * histogram_quantile(" +
		formatFloat(q) +
		", sum by (le) (rate(vllm:e2e_request_latency_seconds_bucket{" + f + "}[5m])))"
}

// QueryLLM returns the bundle of named series shown on the LLM monitoring
// page. When KNAIC_PROMETHEUS_URL is empty (dev mode) every series is
// synthesised deterministically from the {namespace, service} key so the
// chart shapes match the previous in-frontend mock.
func (s *Service) QueryLLM(ctx context.Context, req LLMRequest) (Bundle, error) {
	if req.Namespace == "" || req.Service == "" {
		return Bundle{}, errors.New("namespace and service are required")
	}
	out := Bundle{
		Namespace: req.Namespace,
		Target:    req.Service,
		Series:    make(map[string]Series, len(llmSpecs)),
	}
	if s.baseURL == "" {
		out.Source = SourceSynthetic
		seedKey := "llm:" + req.Namespace + ":" + req.Service
		points, axis := syntheticAxis(req.Start, req.End, req.Step)
		for _, sp := range llmSpecs {
			rand := seededRand(seedKey + ":" + sp.Name)
			out.Series[sp.Name] = Series{
				Points: buildSyntheticPoints(axis, points, sp.Synthetic, rand),
				Unit:   sp.Unit,
				Source: SourceSynthetic,
			}
		}
		return out, nil
	}
	out.Source = SourcePrometheus
	for _, sp := range llmSpecs {
		series, err := s.runRange(ctx, sp.PromQL(req.Namespace, req.Service), req.Start, req.End, req.Step)
		if err != nil {
			return Bundle{}, err
		}
		series.Unit = sp.Unit
		series.Source = SourcePrometheus
		out.Series[sp.Name] = series
	}
	return out, nil
}

// QueryTraining is the TrainJob analogue of QueryLLM.
func (s *Service) QueryTraining(ctx context.Context, req TrainRequest) (Bundle, error) {
	if req.Namespace == "" || req.Job == "" {
		return Bundle{}, errors.New("namespace and job are required")
	}
	out := Bundle{
		Namespace: req.Namespace,
		Target:    req.Job,
		Series:    make(map[string]Series, len(trainSpecs)),
	}
	if s.baseURL == "" {
		out.Source = SourceSynthetic
		seedKey := "train:" + req.Namespace + ":" + req.Job
		points, axis := syntheticAxis(req.Start, req.End, req.Step)
		for _, sp := range trainSpecs {
			rand := seededRand(seedKey + ":" + sp.Name)
			out.Series[sp.Name] = Series{
				Points: buildSyntheticPoints(axis, points, sp.Synthetic, rand),
				Unit:   sp.Unit,
				Source: SourceSynthetic,
			}
		}
		return out, nil
	}
	out.Source = SourcePrometheus
	for _, sp := range trainSpecs {
		series, err := s.runRange(ctx, sp.PromQL(req.Namespace, req.Job), req.Start, req.End, req.Step)
		if err != nil {
			return Bundle{}, err
		}
		series.Unit = sp.Unit
		series.Source = SourcePrometheus
		out.Series[sp.Name] = series
	}
	return out, nil
}

// llmLoad reproduces the load curve the prior in-frontend mock used so the
// synthetic shapes look identical to what users saw before this endpoint
// existed. The 0.6 baseline + sin pulse + jitter keeps chart movements
// deterministic per (namespace, service) seed.
func llmLoad(rand func() float64, i int) float64 {
	return 0.6 + math.Sin(float64(i)/4)*0.25 + (rand()-0.5)*0.15
}

func syntheticAxis(start, end time.Time, step time.Duration) (int, []time.Time) {
	if step == 0 {
		step = 5 * time.Minute
	}
	now := time.Now().UTC()
	if end.IsZero() {
		end = now
	}
	if start.IsZero() {
		start = end.Add(-3 * time.Hour)
	}
	span := end.Sub(start)
	points := int(span/step) + 1
	if points <= 0 {
		points = 36
	}
	axis := make([]time.Time, points)
	for i := 0; i < points; i++ {
		axis[i] = start.Add(time.Duration(i) * step)
	}
	return points, axis
}

func buildSyntheticPoints(axis []time.Time, points int, gen func(rand func() float64, i int) float64, rand func() float64) []Point {
	out := make([]Point, points)
	for i := 0; i < points; i++ {
		out[i] = Point{Time: axis[i].UTC().Format("15:04"), Value: gen(rand, i)}
	}
	return out
}

func formatFloat(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}
