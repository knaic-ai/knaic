package inference

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

var (
	gvrInferenceService    = schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1beta1", Resource: "inferenceservices"}
	gvrLLMInferenceService = schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1alpha2", Resource: "llminferenceservices"}
	gvrServingRuntime      = schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1alpha1", Resource: "servingruntimes"}
)

// stopAnnotation is the standard KServe quiesce annotation (v0.12+). Setting
// it to "true" scales the predictor to zero without deleting the resource.
const stopAnnotation = "serving.kserve.io/stop"

// deploymentModeAnnotation pins the predictor's deployment back-end:
// Standard | RawDeployment | Serverless | ModelMesh.
const deploymentModeAnnotation = "serving.kserve.io/deploymentMode"

// kserveConfigNamespace and kserveConfigMap are where KServe stores its
// runtime config. The "deploy" key holds {"defaultDeploymentMode": "..."}.
const (
	kserveConfigNamespace = "kserve"
	kserveConfigMap       = "inferenceservice-config"
)

type Service struct {
	typed     kubernetes.Interface         // optional: enables ConfigMap-based defaults
	dyn       dynamic.Interface
	discovery discovery.DiscoveryInterface // optional: enables Knative/ModelMesh probe
}

// New builds an inference Service. typed and discovery are optional — when
// nil, deployment-mode detection falls back to a conservative default
// (Standard + RawDeployment, default Standard).
func New(typed kubernetes.Interface, dyn dynamic.Interface, disc discovery.DiscoveryInterface) *Service {
	return &Service{typed: typed, dyn: dyn, discovery: disc}
}

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

	metadata := map[string]any{
		"name":      req.Name,
		"namespace": namespace,
		"labels": map[string]any{
			"knaic.io/managed":   "true",
			"knaic.io/component": "inference",
		},
	}
	if req.DeploymentMode != "" {
		metadata["annotations"] = map[string]any{
			deploymentModeAnnotation: req.DeploymentMode,
		}
	}
	obj := &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": "serving.kserve.io/v1beta1",
			"kind":       "InferenceService",
			"metadata":   metadata,
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
	// LLMInferenceService spec (per the live CRD): {model, replicas,
	// baseRefs, template, worker, prefill, parallelism, router,
	// storageInitializer}. There is NO runtimeRef — that's an InferenceService
	// concept. Container customisation (image/command/args/env/resources)
	// goes under spec.template.containers[]; otherwise the controller (and
	// any baseRefs the user picked) supplies the defaults.
	model := map[string]any{"uri": req.ModelURI}
	if req.ModelName != "" {
		model["name"] = req.ModelName
	}
	spec := map[string]any{
		"model":    model,
		"replicas": req.Replicas,
	}
	if len(req.BaseConfigs) > 0 {
		refs := make([]any, 0, len(req.BaseConfigs))
		for _, name := range req.BaseConfigs {
			if name == "" {
				continue
			}
			refs = append(refs, map[string]any{"name": name})
		}
		if len(refs) > 0 {
			spec["baseRefs"] = refs
		}
	}

	// Build the container override only when at least one container-level
	// field is set; otherwise emitting an empty template would shadow what
	// the chosen baseRefs / controller default would provide.
	container := map[string]any{}
	if req.ContainerImage != "" {
		container["image"] = req.ContainerImage
	}
	if len(req.Command) > 0 {
		container["command"] = toAnySlice(req.Command)
	}
	if len(req.Args) > 0 {
		container["args"] = toAnySlice(req.Args)
	}
	if len(req.Env) > 0 {
		container["env"] = envSlice(req.Env)
	}
	requests := resourceRequests(req)
	limits := resourceLimits(req)
	if len(requests) > 0 || len(limits) > 0 {
		resources := map[string]any{}
		if len(requests) > 0 {
			resources["requests"] = requests
		}
		if len(limits) > 0 {
			resources["limits"] = limits
		}
		container["resources"] = resources
	}
	if len(container) > 0 {
		container["name"] = "main"
		spec["template"] = map[string]any{"containers": []any{container}}
	}

	labels := map[string]any{
		"knaic.io/managed":   "true",
		"knaic.io/component": "inference",
	}
	obj := &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": "serving.kserve.io/v1alpha2",
			"kind":       "LLMInferenceService",
			"metadata": map[string]any{
				"name":      req.Name,
				"namespace": namespace,
				"labels":    labels,
			},
			"spec": spec,
		},
	}
	return s.dyn.Resource(gvrLLMInferenceService).Namespace(namespace).Create(ctx, obj, metav1.CreateOptions{})
}

var gvrLLMInferenceServiceConfig = schema.GroupVersionResource{
	Group:    "serving.kserve.io",
	Version:  "v1alpha2",
	Resource: "llminferenceserviceconfigs",
}

// ListLLMConfigs returns LLMInferenceServiceConfig refs cluster-wide. These
// are the LLM equivalent of ServingRuntime: optional templates merged in via
// spec.baseRefs. Returns an empty list when the CRD isn't installed.
func (s *Service) ListLLMConfigs(ctx context.Context) ([]LLMConfigRef, error) {
	list, err := s.dyn.Resource(gvrLLMInferenceServiceConfig).Namespace(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		// Treat NotFound (CRD missing) as an empty list rather than 500-ing
		// the form. The frontend will show "no base configs available".
		return []LLMConfigRef{}, nil
	}
	out := make([]LLMConfigRef, 0, len(list.Items))
	for _, item := range list.Items {
		out = append(out, LLMConfigRef{
			Name:      item.GetName(),
			Namespace: item.GetNamespace(),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Namespace != out[j].Namespace {
			return out[i].Namespace < out[j].Namespace
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// ListDeploymentModes returns the deploymentMode values the cluster's KServe
// install can actually handle, plus the cluster-configured default.
//
//   - Standard / RawDeployment are always supported (KServe ≥ 0.14 ships
//     them out of the box, no extra dependencies).
//   - Serverless requires Knative Serving — we probe the
//     `serving.knative.dev/v1` group via the discovery client.
//   - The default is read from the `inferenceservice-config` ConfigMap in
//     the `kserve` namespace; the legacy "Knative" alias is normalised to
//     "Serverless". Falls back to "Standard" when the configmap is absent
//     or unreadable.
//
// Returns a usable result even when typed/discovery aren't wired (CLI mode
// without a cluster), so the form always has something to render.
func (s *Service) ListDeploymentModes(ctx context.Context) (DeploymentModesInfo, error) {
	out := DeploymentModesInfo{
		Modes:   []string{"Standard", "RawDeployment"},
		Default: "Standard",
	}
	if s.discovery != nil {
		if _, err := s.discovery.ServerResourcesForGroupVersion("serving.knative.dev/v1"); err == nil {
			out.Modes = append(out.Modes, "Serverless")
		}
	}
	if s.typed != nil {
		cm, err := s.typed.CoreV1().ConfigMaps(kserveConfigNamespace).Get(ctx, kserveConfigMap, metav1.GetOptions{})
		if err == nil {
			var deploy struct {
				DefaultDeploymentMode string `json:"defaultDeploymentMode"`
			}
			if data, ok := cm.Data["deploy"]; ok && data != "" {
				_ = json.Unmarshal([]byte(data), &deploy)
			}
			mode := normaliseDeploymentMode(deploy.DefaultDeploymentMode)
			if mode != "" {
				if !contains(out.Modes, mode) {
					// Cluster's chosen default isn't in our base set yet
					// (e.g. the admin enabled ModelMesh) — surface it so the
					// form can offer it.
					out.Modes = append(out.Modes, mode)
				}
				out.Default = mode
			}
		} else if !apierrors.IsNotFound(err) && !apierrors.IsForbidden(err) {
			// Surface unexpected failures so callers can log; the modes list
			// stays useful regardless.
			return out, fmt.Errorf("read kserve configmap: %w", err)
		}
	}
	return out, nil
}

// normaliseDeploymentMode maps the legacy "Knative" alias to "Serverless"
// (per KServe docs); other values pass through unchanged.
func normaliseDeploymentMode(mode string) string {
	switch mode {
	case "Knative":
		return "Serverless"
	default:
		return mode
	}
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
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
		"name":            "kserve-container",
		"image":           req.Image,
		"args":            toAnySlice(req.Args),
		"securityContext": runtimeSecurityContext(req.SecurityContext),
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

func runtimeSecurityContext(sc SecurityContext) map[string]any {
	out := map[string]any{
		"allowPrivilegeEscalation": false,
		"capabilities": map[string]any{
			"drop": []any{"ALL"},
		},
		"privileged":   false,
		"runAsNonRoot": true,
		"runAsUser":    int64(1000),
		"seccompProfile": map[string]any{
			"type": "RuntimeDefault",
		},
	}
	if sc.AllowPrivilegeEscalation != nil {
		out["allowPrivilegeEscalation"] = *sc.AllowPrivilegeEscalation
	}
	if sc.Privileged != nil {
		out["privileged"] = *sc.Privileged
	}
	if sc.RunAsNonRoot != nil {
		out["runAsNonRoot"] = *sc.RunAsNonRoot
	}
	if sc.RunAsUser != nil {
		out["runAsUser"] = *sc.RunAsUser
	}
	if sc.Capabilities != nil {
		caps := map[string]any{}
		if len(sc.Capabilities.Drop) > 0 {
			caps["drop"] = toAnySlice(sc.Capabilities.Drop)
		}
		if len(sc.Capabilities.Add) > 0 {
			caps["add"] = toAnySlice(sc.Capabilities.Add)
		}
		if len(caps) > 0 {
			out["capabilities"] = caps
		}
	}
	if sc.SeccompProfile != nil && sc.SeccompProfile.Type != "" {
		out["seccompProfile"] = map[string]any{"type": sc.SeccompProfile.Type}
	}
	return out
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
