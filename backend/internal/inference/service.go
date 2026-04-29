package inference

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
	gvrInferenceService    = schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1beta1", Resource: "inferenceservices"}
	gvrLLMInferenceService = schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1alpha1", Resource: "llminferenceservices"}
	gvrServingRuntime      = schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1alpha1", Resource: "servingruntimes"}
)

type Service struct {
	dyn dynamic.Interface
}

func New(dyn dynamic.Interface) *Service { return &Service{dyn: dyn} }

// CreateService applies the right KServe CRD shape based on req.Kind.
// Returns the created object (post-server defaults applied).
func (s *Service) CreateService(ctx context.Context, namespace string, req CreateServiceRequest) (*unstructured.Unstructured, error) {
	if req.Name == "" {
		return nil, errors.New("name is required")
	}
	if req.Replicas == 0 {
		req.Replicas = 1
	}
	if req.CPULimit == "" {
		req.CPULimit = req.CPURequest
	}
	if req.MemoryLimit == "" {
		req.MemoryLimit = req.MemoryRequest
	}
	switch req.Kind {
	case "InferenceService", "":
		return s.createInferenceService(ctx, namespace, req)
	case "LLMInferenceService":
		return s.createLLMInferenceService(ctx, namespace, req)
	default:
		return nil, fmt.Errorf("unknown kind %q", req.Kind)
	}
}

func (s *Service) createInferenceService(ctx context.Context, namespace string, req CreateServiceRequest) (*unstructured.Unstructured, error) {
	model := map[string]any{
		"modelFormat": map[string]any{"name": "huggingface"},
		"runtime":     req.Runtime,
		"storageUri":  req.ModelURI,
		"resources": map[string]any{
			"requests": resourceRequests(req),
			"limits":   resourceLimits(req),
		},
	}
	if cmd := req.Command; len(cmd) > 0 {
		model["command"] = toAnySlice(cmd)
	}
	if args := req.Args; len(args) > 0 {
		model["args"] = toAnySlice(args)
	}
	if len(req.Env) > 0 {
		model["env"] = envSlice(req.Env)
	}

	obj := &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": "serving.kserve.io/v1beta1",
			"kind":       "InferenceService",
			"metadata": map[string]any{
				"name":      req.Name,
				"namespace": namespace,
				"labels": map[string]any{
					"knaic.io/managed":   "true",
					"knaic.io/component": "inference",
				},
			},
			"spec": map[string]any{
				"predictor": map[string]any{
					"minReplicas": req.Replicas,
					"maxReplicas": req.Replicas,
					"model":       model,
				},
			},
		},
	}
	return s.dyn.Resource(gvrInferenceService).Namespace(namespace).Create(ctx, obj, metav1.CreateOptions{})
}

func (s *Service) createLLMInferenceService(ctx context.Context, namespace string, req CreateServiceRequest) (*unstructured.Unstructured, error) {
	model := map[string]any{
		"uri": req.ModelURI,
		"resources": map[string]any{
			"requests": resourceRequests(req),
			"limits":   resourceLimits(req),
		},
	}
	if len(req.Env) > 0 {
		model["env"] = envSlice(req.Env)
	}
	spec := map[string]any{
		"model":       model,
		"minReplicas": req.Replicas,
		"maxReplicas": req.Replicas,
	}
	if req.Runtime != "" {
		spec["runtimeRef"] = map[string]any{"name": req.Runtime}
	}
	obj := &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": "serving.kserve.io/v1alpha1",
			"kind":       "LLMInferenceService",
			"metadata": map[string]any{
				"name":      req.Name,
				"namespace": namespace,
				"labels": map[string]any{
					"knaic.io/managed":   "true",
					"knaic.io/component": "inference",
				},
			},
			"spec": spec,
		},
	}
	return s.dyn.Resource(gvrLLMInferenceService).Namespace(namespace).Create(ctx, obj, metav1.CreateOptions{})
}

func (s *Service) CreateRuntime(ctx context.Context, namespace string, req CreateRuntimeRequest) (*unstructured.Unstructured, error) {
	if req.Name == "" || req.Image == "" {
		return nil, errors.New("name and image are required")
	}
	formats := make([]any, 0, len(req.SupportedModelFormats))
	for _, f := range req.SupportedModelFormats {
		formats = append(formats, map[string]any{"name": f, "autoSelect": true})
	}
	if len(formats) == 0 {
		formats = append(formats, map[string]any{"name": "huggingface", "autoSelect": true})
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
		"name":  "kserve-container",
		"image": req.Image,
		"args":  toAnySlice(req.Args),
	}
	if len(limits) > 0 {
		container["resources"] = map[string]any{"limits": limits}
	}
	obj := &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": "serving.kserve.io/v1alpha1",
			"kind":       "ServingRuntime",
			"metadata": map[string]any{
				"name":      req.Name,
				"namespace": namespace,
				"labels": map[string]any{
					"knaic.io/managed":   "true",
					"knaic.io/component": "inference",
					"knaic.io/runtime":   req.Runtime,
				},
			},
			"spec": map[string]any{
				"supportedModelFormats": formats,
				"containers":            []any{container},
			},
		},
	}
	return s.dyn.Resource(gvrServingRuntime).Namespace(namespace).Create(ctx, obj, metav1.CreateOptions{})
}

func resourceRequests(req CreateServiceRequest) map[string]any {
	out := map[string]any{}
	if req.CPURequest != "" {
		out["cpu"] = req.CPURequest
	}
	if req.MemoryRequest != "" {
		out["memory"] = req.MemoryRequest
	}
	for k, v := range req.GPUValues {
		out[k] = v
	}
	return out
}

func resourceLimits(req CreateServiceRequest) map[string]any {
	out := map[string]any{}
	if req.CPULimit != "" {
		out["cpu"] = req.CPULimit
	}
	if req.MemoryLimit != "" {
		out["memory"] = req.MemoryLimit
	}
	for k, v := range req.GPUValues {
		out[k] = v
	}
	return out
}

func envSlice(in []EnvVar) []any {
	out := make([]any, 0, len(in))
	for _, e := range in {
		out = append(out, map[string]any{"name": e.Name, "value": e.Value})
	}
	return out
}

func toAnySlice(in []string) []any {
	out := make([]any, 0, len(in))
	for _, s := range in {
		out = append(out, s)
	}
	return out
}
