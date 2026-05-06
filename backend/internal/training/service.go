package training

import (
	"context"
	"errors"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

var (
	gvrRuntime = schema.GroupVersionResource{Group: "trainer.kubeflow.org", Version: "v1alpha1", Resource: "trainingruntimes"}
	gvrJob     = schema.GroupVersionResource{Group: "trainer.kubeflow.org", Version: "v1alpha1", Resource: "trainjobs"}
)

const (
	mlflowTrackingURIAnno = "mlflow.knaic.io/tracking-uri"
	mlflowExperimentAnno  = "mlflow.knaic.io/experiment"
	mlflowRunIDAnno       = "mlflow.knaic.io/run-id"

	managedLabel        = "knaic.io/managed"
	componentLabel      = "knaic.io/component"
	frameworkLabelKey   = "knaic.io/framework"
	defaultMLflowSvcURI = "http://mlflow.knaic-system.svc.cluster.local"
)

type Service struct {
	dyn    dynamic.Interface
	mlflow MLflow
}

func New(dyn dynamic.Interface, mlflow MLflow) *Service {
	return &Service{dyn: dyn, mlflow: mlflow}
}

func (s *Service) WithDynamic(dyn dynamic.Interface) *Service {
	return &Service{dyn: dyn, mlflow: s.mlflow}
}

// CreateRuntime applies a TrainingRuntime CR. The chart-style template
// below uses the Trainer v2 mlPolicy + JobSet template shape so the
// projector can read the framework and resources back out.
func (s *Service) CreateRuntime(ctx context.Context, namespace string, req CreateRuntimeRequest) (*unstructured.Unstructured, error) {
	if req.Name == "" || req.Image == "" {
		return nil, errors.New("name and image are required")
	}
	if req.NumNodes == 0 {
		req.NumNodes = 1
	}
	if req.Framework == "" {
		req.Framework = "torch"
	}

	limits := map[string]any{}
	if req.CPULimit != "" {
		limits["cpu"] = req.CPULimit
	}
	if req.MemoryLimit != "" {
		limits["memory"] = req.MemoryLimit
	}
	if req.GPULimit > 0 {
		limits["nvidia.com/gpu"] = req.GPULimit
	}

	container := map[string]any{
		"name":  "trainer",
		"image": req.Image,
	}
	if len(limits) > 0 {
		container["resources"] = map[string]any{"limits": limits}
	}

	obj := &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": "trainer.kubeflow.org/v1alpha1",
			"kind":       "TrainingRuntime",
			"metadata": map[string]any{
				"name":      req.Name,
				"namespace": namespace,
				"labels": map[string]any{
					managedLabel:      "true",
					componentLabel:    "training",
					frameworkLabelKey: req.Framework,
				},
			},
			"spec": map[string]any{
				"mlPolicy": map[string]any{
					"numNodes":    req.NumNodes,
					req.Framework: map[string]any{},
				},
				"template": map[string]any{
					"spec": map[string]any{
						"replicatedJobs": []any{
							map[string]any{
								"name": "trainer",
								"template": map[string]any{
									"spec": map[string]any{
										"template": map[string]any{
											"spec": map[string]any{
												"containers": []any{container},
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
	}
	return s.dyn.Resource(gvrRuntime).Namespace(namespace).Create(ctx, obj, metav1.CreateOptions{})
}

func (s *Service) CreateJob(ctx context.Context, namespace string, req CreateJobRequest) (*unstructured.Unstructured, error) {
	if req.Name == "" || req.Runtime == "" {
		return nil, errors.New("name and runtime are required")
	}
	if req.NumNodes == 0 {
		req.NumNodes = 1
	}
	if req.CPULimit == "" {
		req.CPULimit = req.CPURequest
	}
	if req.MemoryLimit == "" {
		req.MemoryLimit = req.MemoryRequest
	}

	requests := map[string]any{}
	if req.CPURequest != "" {
		requests["cpu"] = req.CPURequest
	}
	if req.MemoryRequest != "" {
		requests["memory"] = req.MemoryRequest
	}
	for k, v := range req.GPUValues {
		requests[k] = v
	}
	limits := map[string]any{}
	if req.CPULimit != "" {
		limits["cpu"] = req.CPULimit
	}
	if req.MemoryLimit != "" {
		limits["memory"] = req.MemoryLimit
	}
	for k, v := range req.GPUValues {
		limits[k] = v
	}

	trainer := map[string]any{
		"numNodes": req.NumNodes,
		"resourcesPerNode": map[string]any{
			"requests": requests,
			"limits":   limits,
		},
	}
	if len(req.Command) > 0 {
		trainer["command"] = toAnySlice(req.Command)
	}
	if len(req.Args) > 0 {
		trainer["args"] = toAnySlice(req.Args)
	}
	if len(req.Env) > 0 {
		envs := make([]any, 0, len(req.Env))
		for _, e := range req.Env {
			envs = append(envs, map[string]any{"name": e.Name, "value": e.Value})
		}
		trainer["env"] = envs
	}
	if req.ModelURI != "" {
		trainer["modelConfig"] = map[string]any{
			"input": map[string]any{"storageUri": req.ModelURI},
		}
	}
	if req.DatasetURI != "" {
		trainer["datasetConfig"] = map[string]any{
			"input": map[string]any{"storageUri": req.DatasetURI},
		}
	}

	annotations := map[string]any{}
	if req.MLflowTrackingURI != "" {
		annotations[mlflowTrackingURIAnno] = req.MLflowTrackingURI
	}
	if req.MLflowExperiment != "" {
		annotations[mlflowExperimentAnno] = req.MLflowExperiment
	}
	// Stamp a placeholder run id so the projector can render the MLflow tab
	// before the trainer starts reporting; the trainer will overwrite it.
	if req.MLflowExperiment != "" || req.MLflowTrackingURI != "" {
		annotations[mlflowRunIDAnno] = "r-" + shortRandHex(2)
	}

	metadata := map[string]any{
		"name":      req.Name,
		"namespace": namespace,
		"labels": map[string]any{
			managedLabel:   "true",
			componentLabel: "training",
		},
	}
	if len(annotations) > 0 {
		metadata["annotations"] = annotations
	}

	obj := &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": "trainer.kubeflow.org/v1alpha1",
			"kind":       "TrainJob",
			"metadata":   metadata,
			"spec": map[string]any{
				"runtimeRef": map[string]any{"name": req.Runtime, "kind": "TrainingRuntime"},
				"trainer":    trainer,
			},
		},
	}
	return s.dyn.Resource(gvrJob).Namespace(namespace).Create(ctx, obj, metav1.CreateOptions{})
}

// MLflowRun returns the recorded run + samples for a TrainJob. If the job
// has no MLflow annotations, the result is empty (and the UI hides the tab).
func (s *Service) MLflowRun(ctx context.Context, namespace, name string) (MLflowRun, error) {
	job, err := s.dyn.Resource(gvrJob).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return MLflowRun{}, err
	}
	ann := job.GetAnnotations()
	tracking := ann[mlflowTrackingURIAnno]
	if tracking == "" {
		tracking = defaultMLflowSvcURI
	}
	experiment := ann[mlflowExperimentAnno]
	runID := ann[mlflowRunIDAnno]
	if experiment == "" && runID == "" {
		return MLflowRun{}, fmt.Errorf("no mlflow tracking metadata on TrainJob %q", name)
	}
	samples, source, err := s.mlflow.Samples(ctx, tracking, runID)
	if err != nil {
		return MLflowRun{}, err
	}
	return MLflowRun{
		TrackingURI: tracking,
		Experiment:  experiment,
		RunID:       runID,
		Samples:     samples,
		Source:      source,
	}, nil
}

func toAnySlice(in []string) []any {
	out := make([]any, 0, len(in))
	for _, s := range in {
		out = append(out, s)
	}
	return out
}
