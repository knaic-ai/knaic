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

// stopAnnotation is the standard KServe quiesce annotation (v0.12+). Setting
// it to "true" scales the predictor to zero without deleting the resource.
const stopAnnotation = "serving.kserve.io/stop"

type Service struct {
	dyn dynamic.Interface
}

func New(dyn dynamic.Interface) *Service { return &Service{dyn: dyn} }

func gvrFor(kind string) (schema.GroupVersionResource, error) {
	switch kind {
	case "InferenceService", "":
		return gvrInferenceService, nil
	case "LLMInferenceService":
		return gvrLLMInferenceService, nil
	default:
		return schema.GroupVersionResource{}, fmt.Errorf("unknown kind %q", kind)
	}
}

// SetStopped flips the KServe stop annotation. Pass true to scale the
// predictor to zero, false to resume. Empty kind defaults to InferenceService.
func (s *Service) SetStopped(ctx context.Context, namespace, name, kind string, stopped bool) (*unstructured.Unstructured, error) {
	gvr, err := gvrFor(kind)
	if err != nil {
		return nil, err
	}
	cur, err := s.dyn.Resource(gvr).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	annos := cur.GetAnnotations()
	if annos == nil {
		annos = map[string]string{}
	}
	if stopped {
		annos[stopAnnotation] = "true"
	} else {
		delete(annos, stopAnnotation)
	}
	cur.SetAnnotations(annos)
	return s.dyn.Resource(gvr).Namespace(namespace).Update(ctx, cur, metav1.UpdateOptions{})
}

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
	labels := map[string]any{}
	for k, v := range runtimeLabels(req.Runtime) {
		labels[k] = v
	}
	obj := &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": "serving.kserve.io/v1alpha1",
			"kind":       "ServingRuntime",
			"metadata": map[string]any{
				"name":      req.Name,
				"namespace": namespace,
				"labels":    labels,
			},
			"spec": runtimeSpec(req),
		},
	}
	return s.dyn.Resource(gvrServingRuntime).Namespace(namespace).Create(ctx, obj, metav1.CreateOptions{})
}

// UpdateRuntime rewrites the spec of an existing ServingRuntime from the
// form fields. Identity (name/namespace) and unrelated metadata
// (resourceVersion, uid, ownerReferences, …) are preserved.
func (s *Service) UpdateRuntime(ctx context.Context, namespace, name string, req CreateRuntimeRequest) (*unstructured.Unstructured, error) {
	if name == "" || req.Image == "" {
		return nil, errors.New("name and image are required")
	}
	cur, err := s.dyn.Resource(gvrServingRuntime).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	// Merge knaic labels onto whatever the existing object carried.
	labels, _, _ := unstructured.NestedStringMap(cur.Object, "metadata", "labels")
	if labels == nil {
		labels = map[string]string{}
	}
	for k, v := range runtimeLabels(req.Runtime) {
		labels[k] = v
	}
	if err := unstructured.SetNestedStringMap(cur.Object, labels, "metadata", "labels"); err != nil {
		return nil, err
	}
	cur.Object["spec"] = runtimeSpec(req)
	return s.dyn.Resource(gvrServingRuntime).Namespace(namespace).Update(ctx, cur, metav1.UpdateOptions{})
}

func runtimeLabels(runtime string) map[string]string {
	return map[string]string{
		"knaic.io/managed":   "true",
		"knaic.io/component": "inference",
		"knaic.io/runtime":   runtime,
	}
}

func runtimeSpec(req CreateRuntimeRequest) map[string]any {
	formats := make([]any, 0, len(req.SupportedModelFormats))
	for _, f := range req.SupportedModelFormats {
		formats = append(formats, map[string]any{"name": f, "autoSelect": true})
	}
	if len(formats) == 0 {
		formats = append(formats, map[string]any{"name": "huggingface", "autoSelect": true})
	}
	if req.CPULimit == "" {
		req.CPULimit = req.CPURequest
	}
	if req.MemoryLimit == "" {
		req.MemoryLimit = req.MemoryRequest
	}
	requests := runtimeResources(req.CPURequest, req.MemoryRequest, req.GPUValues, req.GPULimit)
	limits := runtimeResources(req.CPULimit, req.MemoryLimit, req.GPUValues, req.GPULimit)
	container := map[string]any{
		"name":  "kserve-container",
		"image": req.Image,
		"args":  toAnySlice(req.Args),
	}
	resources := map[string]any{}
	if len(requests) > 0 {
		resources["requests"] = requests
	}
	if len(limits) > 0 {
		resources["limits"] = limits
	}
	if len(resources) > 0 {
		container["resources"] = resources
	}
	return map[string]any{
		"supportedModelFormats": formats,
		"containers":            []any{container},
	}
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

func runtimeResources(cpu, memory string, gpu map[string]int64, legacyGPU int64) map[string]any {
	out := map[string]any{}
	if cpu != "" {
		out["cpu"] = cpu
	}
	if memory != "" {
		out["memory"] = memory
	}
	if len(gpu) > 0 {
		for k, v := range gpu {
			out[k] = v
		}
	} else if legacyGPU > 0 {
		out["nvidia.com/gpu"] = legacyGPU
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
