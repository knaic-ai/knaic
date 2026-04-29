package training

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math"
	"net/http"
	"net/url"
	"time"
)

// MLflow returns time-series samples for a given run. Production binds it
// to mlflowREST (which proxies to the MLflow REST API); test code can pass
// SyntheticMLflow to avoid needing a live MLflow.
type MLflow interface {
	Samples(ctx context.Context, trackingURI, runID string) ([]MLflowSample, string, error)
}

// SyntheticMLflow is the fallback when MLflow isn't reachable. It seeds a
// deterministic loss/accuracy curve from the run id, so users still see a
// chart in dev mode and the data doesn't shift between page reloads.
type SyntheticMLflow struct{}

func (SyntheticMLflow) Samples(_ context.Context, _ string, runID string) ([]MLflowSample, string, error) {
	return syntheticSamples(runID, 30), "synthetic", nil
}

// REST is an MLflow REST proxy. It tries the live MLflow first; on failure
// (404, network error, 5xx) it falls back to synthetic samples so the UI
// always renders something.
type REST struct {
	HTTP *http.Client
}

func NewREST() *REST {
	return &REST{HTTP: &http.Client{Timeout: 5 * time.Second}}
}

func (r *REST) Samples(ctx context.Context, trackingURI, runID string) ([]MLflowSample, string, error) {
	if trackingURI == "" || runID == "" {
		return syntheticSamples(runID, 30), "synthetic", nil
	}
	loss, lossErr := r.metricHistory(ctx, trackingURI, runID, "loss")
	acc, _ := r.metricHistory(ctx, trackingURI, runID, "accuracy")
	if lossErr != nil || len(loss) == 0 {
		return syntheticSamples(runID, 30), "synthetic", nil
	}
	out := make([]MLflowSample, 0, len(loss))
	for i, p := range loss {
		s := MLflowSample{Step: int(p.Step), Loss: p.Value}
		if i < len(acc) {
			s.Accuracy = acc[i].Value
		}
		out = append(out, s)
	}
	return out, "mlflow", nil
}

type metricPoint struct {
	Step  int64   `json:"step"`
	Value float64 `json:"value"`
}

func (r *REST) metricHistory(ctx context.Context, base, runID, metric string) ([]metricPoint, error) {
	u, err := url.Parse(base)
	if err != nil {
		return nil, err
	}
	u.Path = "/api/2.0/mlflow/metrics/get-history"
	q := u.Query()
	q.Set("run_id", runID)
	q.Set("metric_key", metric)
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	res, err := r.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return nil, fmt.Errorf("mlflow %s: %s", metric, res.Status)
	}
	var body struct {
		Metrics []metricPoint `json:"metrics"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body.Metrics, nil
}

// syntheticSamples returns a deterministic loss/accuracy curve seeded from
// runID so visualisations are stable between page reloads.
func syntheticSamples(runID string, n int) []MLflowSample {
	h := fnv.New64a()
	if runID == "" {
		runID = "default"
	}
	_, _ = h.Write([]byte(runID))
	seed := h.Sum64()
	out := make([]MLflowSample, n)
	for i := 0; i < n; i++ {
		seed = seed*6364136223846793005 + 1442695040888963407
		jit := float64((seed>>32)&0xff) / 255.0
		t := float64(i+1) / float64(n)
		loss := 0.4 + (1-t)*(2.0+jit*0.4)
		acc := 0.55 + 0.35*t + jit*0.02
		out[i] = MLflowSample{
			Step:     i + 1,
			Loss:     math.Round(loss*1000) / 1000,
			Accuracy: math.Round(acc*1000) / 1000,
		}
	}
	return out
}

// shortRandHex returns 2*n hex chars of cryptographically random data — used
// to stamp placeholder run ids on freshly created TrainJobs.
func shortRandHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
