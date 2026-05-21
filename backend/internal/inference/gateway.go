package inference

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

// kserve-ingress-gateway is the Gateway resource KServe v0.14+ creates when
// ingress.enableGatewayApi is set. Defaults to the "kserve" namespace; on
// raw deployments it can be overridden via the kserveIngress configmap key
// but the upstream default install puts it here.
const (
	defaultKServeGatewayNamespace = "kserve"
	defaultKServeGatewayName      = "kserve-ingress-gateway"
)

// gvrs for the network resources we read/write to wire an InferenceService
// up to the Envoy AI Gateway. Versions chosen to match the upstream Envoy AI
// Gateway 0.3+ release and Gateway API v1.
var (
	gvrGateway              = schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "gateways"}
	gvrHTTPRoute            = schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "httproutes"}
	gvrReferenceGrant       = schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1beta1", Resource: "referencegrants"}
	gvrAIGatewayRoute       = schema.GroupVersionResource{Group: "aigateway.envoyproxy.io", Version: "v1alpha1", Resource: "aigatewayroutes"}
	gvrAIServiceBackend     = schema.GroupVersionResource{Group: "aigateway.envoyproxy.io", Version: "v1alpha1", Resource: "aiservicebackends"}
	gvrBackendTrafficPolicy = schema.GroupVersionResource{Group: "gateway.envoyproxy.io", Version: "v1alpha1", Resource: "backendtrafficpolicies"}
)

// GatewayConfig surfaces "is the gateway path usable here?" for the
// Inference Services + Gateway pages. It bundles:
//
//   - what KServe's configmap says (ingress.enableGatewayApi, deploy.defaultDeploymentMode)
//   - whether the cluster has the relevant CRDs installed (Gateway API +
//     Envoy AI Gateway aigateway.envoyproxy.io)
//   - the status of the default `kserve-ingress-gateway` Gateway, and any
//     external addresses the controller programmed onto it
//
// All probes degrade to a "not installed / unreachable" state when the
// caller lacks RBAC, so a non-admin can still render the page.
type GatewayConfig struct {
	// IngressGatewayAPIEnabled is the value of ingress.enableGatewayApi from
	// the kserve `inferenceservice-config` configmap. When false, KServe
	// drops the Gateway API integration and InferenceServices are exposed
	// only by their cluster-internal Service.
	IngressGatewayAPIEnabled bool   `json:"ingressGatewayApiEnabled"`
	DefaultDeploymentMode    string `json:"defaultDeploymentMode,omitempty"`
	// IngressDomain / UrlScheme are surfaced as-is so the UI can render
	// "https://<svc>.<ns>.<domain>" hints that mirror what KServe puts in
	// the InferenceService status URL.
	IngressDomain string `json:"ingressDomain,omitempty"`
	URLScheme     string `json:"urlScheme,omitempty"`
	// DisableIstioVirtualHost = true when KServe is configured to NOT mount
	// the legacy Istio VirtualService — typical for Gateway-API-only installs.
	DisableIstioVirtualHost bool `json:"disableIstioVirtualHost,omitempty"`

	GatewayAPIInstalled     bool `json:"gatewayApiInstalled"`
	EnvoyAIGatewayInstalled bool `json:"envoyAiGatewayInstalled"`

	// Gateway is the status of `kserve-ingress-gateway` itself; nil if the
	// resource is not present in the cluster.
	Gateway *KServeGatewayStatus `json:"gateway,omitempty"`
}

// KServeGatewayStatus mirrors the bits of the Gateway resource the UI cares
// about: where it lives, whether it's healthy, and the addresses external
// clients should hit. Addresses include the Service ClusterIP for in-cluster
// access plus any LoadBalancer IPs/hostnames the controller programmed.
type KServeGatewayStatus struct {
	Namespace        string   `json:"namespace"`
	Name             string   `json:"name"`
	GatewayClassName string   `json:"gatewayClassName,omitempty"`
	Status           string   `json:"status"` // Accepted | Pending | Failed
	Addresses        []string `json:"addresses,omitempty"`
	Listeners        []string `json:"listeners,omitempty"`
}

// GatewayConfig probes the cluster for everything the Inference Services
// page wants to know about gateway plumbing. Returns a fully-populated zero
// value (everything false / nil) on errors so the UI can render a sensible
// "not installed" panel.
func (s *Service) GatewayConfig(ctx context.Context) (GatewayConfig, error) {
	out := GatewayConfig{}

	if s.typed != nil {
		cm, err := s.typed.CoreV1().ConfigMaps(kserveConfigNamespace).Get(ctx, kserveConfigMap, metav1.GetOptions{})
		if err == nil {
			// "ingress" key holds the JSON-encoded IngressConfig struct.
			if raw, ok := cm.Data["ingress"]; ok && raw != "" {
				var ing struct {
					EnableGatewayAPI        bool   `json:"enableGatewayApi"`
					IngressDomain           string `json:"ingressDomain"`
					URLScheme               string `json:"urlScheme"`
					DisableIstioVirtualHost bool   `json:"disableIstioVirtualHost"`
				}
				if err := json.Unmarshal([]byte(raw), &ing); err == nil {
					out.IngressGatewayAPIEnabled = ing.EnableGatewayAPI
					out.IngressDomain = ing.IngressDomain
					out.URLScheme = ing.URLScheme
					out.DisableIstioVirtualHost = ing.DisableIstioVirtualHost
				}
			}
			if raw, ok := cm.Data["deploy"]; ok && raw != "" {
				var dep struct {
					DefaultDeploymentMode string `json:"defaultDeploymentMode"`
				}
				if err := json.Unmarshal([]byte(raw), &dep); err == nil {
					out.DefaultDeploymentMode = normaliseDeploymentMode(dep.DefaultDeploymentMode)
				}
			}
		} else if !apierrors.IsNotFound(err) && !apierrors.IsForbidden(err) && !apierrors.IsUnauthorized(err) {
			return out, fmt.Errorf("read kserve configmap: %w", err)
		}
	}

	if s.discovery != nil {
		if _, err := s.discovery.ServerResourcesForGroupVersion("gateway.networking.k8s.io/v1"); err == nil {
			out.GatewayAPIInstalled = true
		}
		if _, err := s.discovery.ServerResourcesForGroupVersion("aigateway.envoyproxy.io/v1alpha1"); err == nil {
			out.EnvoyAIGatewayInstalled = true
		}
	}

	if s.dyn != nil && out.GatewayAPIInstalled {
		gw, err := s.dyn.Resource(gvrGateway).
			Namespace(defaultKServeGatewayNamespace).
			Get(ctx, defaultKServeGatewayName, metav1.GetOptions{})
		if err == nil && gw != nil {
			out.Gateway = projectKServeGateway(gw)
		} else if err != nil && !apierrors.IsNotFound(err) && !apierrors.IsForbidden(err) && !apierrors.IsUnauthorized(err) {
			return out, fmt.Errorf("get kserve gateway: %w", err)
		}
	}

	return out, nil
}

func projectKServeGateway(o *unstructured.Unstructured) *KServeGatewayStatus {
	out := &KServeGatewayStatus{
		Namespace: o.GetNamespace(),
		Name:      o.GetName(),
		Status:    gatewayConditionStatus(o),
	}
	if v, _, _ := unstructured.NestedString(o.Object, "spec", "gatewayClassName"); v != "" {
		out.GatewayClassName = v
	}
	if rawListeners, _, _ := unstructured.NestedSlice(o.Object, "spec", "listeners"); len(rawListeners) > 0 {
		for _, raw := range rawListeners {
			m, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			name, _, _ := unstructured.NestedString(m, "name")
			port, _, _ := unstructured.NestedInt64(m, "port")
			proto, _, _ := unstructured.NestedString(m, "protocol")
			out.Listeners = append(out.Listeners, fmt.Sprintf("%s · %s :%d", name, proto, port))
		}
	}
	if rawAddrs, _, _ := unstructured.NestedSlice(o.Object, "status", "addresses"); len(rawAddrs) > 0 {
		for _, raw := range rawAddrs {
			if m, ok := raw.(map[string]any); ok {
				if v, _, _ := unstructured.NestedString(m, "value"); v != "" {
					out.Addresses = append(out.Addresses, v)
				}
			}
		}
	}
	return out
}

// gatewayConditionStatus collapses the gateway's status conditions to a
// single Accepted/Pending/Failed bucket — same convention as the generic
// k8sres projector so the UI can re-use its StatusTag colour map.
func gatewayConditionStatus(o *unstructured.Unstructured) string {
	conditions, _, _ := unstructured.NestedSlice(o.Object, "status", "conditions")
	accepted := false
	for _, raw := range conditions {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		t, _, _ := unstructured.NestedString(m, "type")
		s, _, _ := unstructured.NestedString(m, "status")
		switch t {
		case "Accepted":
			if s == "True" {
				accepted = true
			}
			if s == "False" {
				return "Failed"
			}
		case "Programmed":
			if s == "False" {
				return "Failed"
			}
		}
	}
	if accepted {
		return "Accepted"
	}
	return "Pending"
}

// ServiceRouteStatus is the per-InferenceService rollup the UI shows on the
// list / detail page: how many routes target this service, what hostnames
// they expose, and whether any BackendTrafficPolicy ratelimit applies.
type ServiceRouteStatus struct {
	Routes      []RouteRef      `json:"routes"`
	RateLimits  []RateLimitRef  `json:"rateLimits"`
	Backends    []ServiceRefDTO `json:"backends,omitempty"`
	Suggestions []string        `json:"suggestions,omitempty"`
}

// RouteRef is one HTTPRoute or AIGatewayRoute pointing at the service.
type RouteRef struct {
	APIVersion string   `json:"apiVersion"`
	Kind       string   `json:"kind"`
	Namespace  string   `json:"namespace"`
	Name       string   `json:"name"`
	Hostnames  []string `json:"hostnames,omitempty"`
	ParentName string   `json:"parentName,omitempty"`
	Status     string   `json:"status,omitempty"`
}

// RateLimitRef is one BackendTrafficPolicy with rateLimit configured.
type RateLimitRef struct {
	Namespace string   `json:"namespace"`
	Name      string   `json:"name"`
	TargetKind string  `json:"targetKind,omitempty"`
	TargetName string  `json:"targetName,omitempty"`
	Type       string  `json:"type,omitempty"`
	Summaries  []string `json:"summaries,omitempty"`
}

// ServiceRefDTO is the wire shape of an AIServiceBackend's backendRef so the
// UI can show "route is wired to this k8s Service".
type ServiceRefDTO struct {
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name"`
	Port      int64  `json:"port,omitempty"`
}

// ServiceRouteStatus returns the route + rate-limit picture for one
// InferenceService. Searches HTTPRoute (any namespace), AIGatewayRoute (any
// namespace) plus BackendTrafficPolicy (any namespace) and keeps anything
// pointing at the service's predictor Service or AIServiceBackend.
//
// Errors are non-fatal per-CRD: if the cluster lacks AIGatewayRoute, the
// classic HTTPRoute scan still runs. Helps the UI degrade gracefully.
func (s *Service) ServiceRouteStatus(ctx context.Context, namespace, name string) (ServiceRouteStatus, error) {
	out := ServiceRouteStatus{
		Routes:     []RouteRef{},
		RateLimits: []RateLimitRef{},
		Backends:   []ServiceRefDTO{},
	}
	if s.dyn == nil {
		return out, nil
	}
	candidates := serviceBackendCandidates(namespace, name)

	// AIServiceBackends → resolved Service refs. Listed cluster-wide because
	// teams commonly put AIServiceBackend in a gateway-tenant namespace while
	// the InferenceService lives in the team namespace.
	aiBackendNames := map[string]struct{}{}
	if list, err := s.dyn.Resource(gvrAIServiceBackend).Namespace(metav1.NamespaceAll).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range list.Items {
			item := &list.Items[i]
			ref := extractAIServiceBackendRef(item)
			if ref == nil {
				continue
			}
			if matchesAnyCandidate(*ref, candidates) {
				out.Backends = append(out.Backends, *ref)
				aiBackendNames[item.GetNamespace()+"/"+item.GetName()] = struct{}{}
			}
		}
	}

	// HTTPRoutes referencing the backend Service directly.
	if list, err := s.dyn.Resource(gvrHTTPRoute).Namespace(metav1.NamespaceAll).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range list.Items {
			item := &list.Items[i]
			if routeReferencesService(item, candidates) {
				out.Routes = append(out.Routes, projectRouteRef(item, "HTTPRoute"))
			}
		}
	}

	// AIGatewayRoutes referencing one of the matching AIServiceBackend(s).
	if list, err := s.dyn.Resource(gvrAIGatewayRoute).Namespace(metav1.NamespaceAll).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range list.Items {
			item := &list.Items[i]
			if aigatewayRouteReferences(item, aiBackendNames) {
				out.Routes = append(out.Routes, projectRouteRef(item, "AIGatewayRoute"))
			}
		}
	}

	// BackendTrafficPolicy with rate-limit blocks targeting our routes.
	routeKey := map[string]struct{}{}
	for _, r := range out.Routes {
		routeKey[r.Kind+"/"+r.Namespace+"/"+r.Name] = struct{}{}
	}
	if list, err := s.dyn.Resource(gvrBackendTrafficPolicy).Namespace(metav1.NamespaceAll).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range list.Items {
			item := &list.Items[i]
			rl := extractRateLimit(item)
			if rl == nil {
				continue
			}
			if policyTargetsAnyRoute(item, routeKey) {
				out.RateLimits = append(out.RateLimits, *rl)
			}
		}
	}

	sort.Slice(out.Routes, func(i, j int) bool {
		if out.Routes[i].Kind != out.Routes[j].Kind {
			return out.Routes[i].Kind < out.Routes[j].Kind
		}
		return out.Routes[i].Namespace+out.Routes[i].Name < out.Routes[j].Namespace+out.Routes[j].Name
	})

	if len(out.Routes) == 0 {
		out.Suggestions = append(out.Suggestions,
			fmt.Sprintf("No gateway route found for %s/%s. Use the Gateway page to provision an AIGatewayRoute + AIServiceBackend.", namespace, name))
	}
	return out, nil
}

// serviceBackendCandidates lists every k8s Service name that might be the
// backend of an InferenceService. KServe uses different naming depending on
// deployment mode + kind, so we accept the predictor-suffix shape, the
// kind-suffix shape, plus the bare name as a fallback.
func serviceBackendCandidates(namespace, name string) []ServiceRefDTO {
	return []ServiceRefDTO{
		{Namespace: namespace, Name: name},
		{Namespace: namespace, Name: name + "-predictor"},
		{Namespace: namespace, Name: name + "-predictor-default"},
	}
}

func matchesAnyCandidate(ref ServiceRefDTO, candidates []ServiceRefDTO) bool {
	for _, c := range candidates {
		if (ref.Namespace == "" || c.Namespace == "" || ref.Namespace == c.Namespace) && ref.Name == c.Name {
			return true
		}
	}
	return false
}

// extractAIServiceBackendRef pulls the backendRef out of an AIServiceBackend
// resource. The Envoy AI Gateway schema has both spec.backendRef (single
// ref) and spec.backendRefs (list); we handle either.
func extractAIServiceBackendRef(o *unstructured.Unstructured) *ServiceRefDTO {
	if m, ok, _ := unstructured.NestedMap(o.Object, "spec", "backendRef"); ok {
		return refFromMap(m, o.GetNamespace())
	}
	if list, ok, _ := unstructured.NestedSlice(o.Object, "spec", "backendRefs"); ok && len(list) > 0 {
		if m, ok := list[0].(map[string]any); ok {
			return refFromMap(m, o.GetNamespace())
		}
	}
	return nil
}

func refFromMap(m map[string]any, defaultNS string) *ServiceRefDTO {
	name, _, _ := unstructured.NestedString(m, "name")
	if name == "" {
		return nil
	}
	ns, _, _ := unstructured.NestedString(m, "namespace")
	if ns == "" {
		ns = defaultNS
	}
	port, _, _ := unstructured.NestedInt64(m, "port")
	return &ServiceRefDTO{Namespace: ns, Name: name, Port: port}
}

// routeReferencesService walks rules[].backendRefs and returns true if any
// rule points at one of the candidate Service names.
func routeReferencesService(o *unstructured.Unstructured, candidates []ServiceRefDTO) bool {
	rawRules, _, _ := unstructured.NestedSlice(o.Object, "spec", "rules")
	for _, raw := range rawRules {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		refs, _, _ := unstructured.NestedSlice(m, "backendRefs")
		for _, br := range refs {
			bm, ok := br.(map[string]any)
			if !ok {
				continue
			}
			name, _, _ := unstructured.NestedString(bm, "name")
			ns, _, _ := unstructured.NestedString(bm, "namespace")
			if ns == "" {
				ns = o.GetNamespace()
			}
			if matchesAnyCandidate(ServiceRefDTO{Namespace: ns, Name: name}, candidates) {
				return true
			}
		}
	}
	return false
}

// aigatewayRouteReferences returns true if the AIGatewayRoute names any of
// the AIServiceBackend keys we've already matched.
func aigatewayRouteReferences(o *unstructured.Unstructured, backendKeys map[string]struct{}) bool {
	rawRules, _, _ := unstructured.NestedSlice(o.Object, "spec", "rules")
	for _, raw := range rawRules {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		refs, _, _ := unstructured.NestedSlice(m, "backendRefs")
		for _, br := range refs {
			bm, ok := br.(map[string]any)
			if !ok {
				continue
			}
			name, _, _ := unstructured.NestedString(bm, "name")
			ns, _, _ := unstructured.NestedString(bm, "namespace")
			if ns == "" {
				ns = o.GetNamespace()
			}
			if _, ok := backendKeys[ns+"/"+name]; ok {
				return true
			}
		}
	}
	return false
}

// policyTargetsAnyRoute walks targetRefs[] and returns true when one of them
// names a route in routeKey.
func policyTargetsAnyRoute(o *unstructured.Unstructured, routeKey map[string]struct{}) bool {
	rawTargets, _, _ := unstructured.NestedSlice(o.Object, "spec", "targetRefs")
	if len(rawTargets) == 0 {
		// Fall back to single-target shape (older schema).
		if m, ok, _ := unstructured.NestedMap(o.Object, "spec", "targetRef"); ok {
			rawTargets = []any{m}
		}
	}
	for _, raw := range rawTargets {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		kind, _, _ := unstructured.NestedString(m, "kind")
		name, _, _ := unstructured.NestedString(m, "name")
		ns, _, _ := unstructured.NestedString(m, "namespace")
		if ns == "" {
			ns = o.GetNamespace()
		}
		if _, ok := routeKey[kind+"/"+ns+"/"+name]; ok {
			return true
		}
	}
	return false
}

// extractRateLimit summarises the BackendTrafficPolicy rateLimit block for
// the UI. Returns nil when no rateLimit is configured — the policy may exist
// solely for retry/timeout settings.
func extractRateLimit(o *unstructured.Unstructured) *RateLimitRef {
	rl, ok, _ := unstructured.NestedMap(o.Object, "spec", "rateLimit")
	if !ok || len(rl) == 0 {
		return nil
	}
	out := &RateLimitRef{Namespace: o.GetNamespace(), Name: o.GetName()}
	out.Type, _, _ = unstructured.NestedString(rl, "type")
	if out.Type == "" {
		out.Type = "Global"
	}
	// Pull the first targetRef so the UI can show "targets HTTPRoute X".
	targets, _, _ := unstructured.NestedSlice(o.Object, "spec", "targetRefs")
	if len(targets) > 0 {
		if m, ok := targets[0].(map[string]any); ok {
			out.TargetKind, _, _ = unstructured.NestedString(m, "kind")
			out.TargetName, _, _ = unstructured.NestedString(m, "name")
		}
	}
	rules, _, _ := unstructured.NestedSlice(rl, "global", "rules")
	for _, raw := range rules {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		req, _, _ := unstructured.NestedInt64(m, "limit", "requests")
		unit, _, _ := unstructured.NestedString(m, "limit", "unit")
		if req > 0 {
			out.Summaries = append(out.Summaries, fmt.Sprintf("%d / %s", req, strings.ToLower(unit)))
		}
	}
	if len(out.Summaries) == 0 {
		out.Summaries = []string{"configured"}
	}
	return out
}

// projectRouteRef collapses an HTTPRoute / AIGatewayRoute to the shape the
// UI displays. parentRefs[0] is highlighted as the Gateway the route is
// attached to (typically kserve-ingress-gateway).
func projectRouteRef(o *unstructured.Unstructured, kind string) RouteRef {
	ref := RouteRef{
		APIVersion: o.GetAPIVersion(),
		Kind:       kind,
		Namespace:  o.GetNamespace(),
		Name:       o.GetName(),
	}
	if names, _, _ := unstructured.NestedStringSlice(o.Object, "spec", "hostnames"); len(names) > 0 {
		ref.Hostnames = names
	}
	parents, _, _ := unstructured.NestedSlice(o.Object, "spec", "parentRefs")
	if len(parents) == 0 {
		// AIGatewayRoute uses spec.targetRefs[] to attach to a Gateway.
		parents, _, _ = unstructured.NestedSlice(o.Object, "spec", "targetRefs")
	}
	if len(parents) > 0 {
		if m, ok := parents[0].(map[string]any); ok {
			ref.ParentName, _, _ = unstructured.NestedString(m, "name")
		}
	}
	ref.Status = gatewayConditionStatus(o)
	return ref
}

// CreateAIGatewayRouteRequest is the body for POST
// /api/v1/namespaces/{ns}/inference/services/{name}/gateway-route.
//
// The handler creates:
//
//   - AIServiceBackend (envoy ai gateway) pointing at the predictor Service
//   - AIGatewayRoute attached to kserve-ingress-gateway with a header match
//     on the model name
//   - (optional) BackendTrafficPolicy with a Global rate limit
//   - (optional) ReferenceGrant when the route's namespace differs from the
//     service namespace, so the cross-namespace Service reference is allowed
//
// All resources are labelled `knaic.io/managed=true` so they can be GC'd by
// re-running the form.
type CreateAIGatewayRouteRequest struct {
	// GatewayNamespace + GatewayName name the Gateway the route attaches to.
	// Defaults to kserve/kserve-ingress-gateway.
	GatewayNamespace string `json:"gatewayNamespace,omitempty"`
	GatewayName      string `json:"gatewayName,omitempty"`
	// Hostnames programmed into the AIGatewayRoute. Empty means inherit from
	// the gateway listener.
	Hostnames []string `json:"hostnames,omitempty"`
	// ModelHeader is the value the route matches on `x-ai-eg-model`. Defaults
	// to the InferenceService name when empty.
	ModelHeader string `json:"modelHeader,omitempty"`
	// ServicePort is the backend port; defaults to 80 (KServe Standard) /
	// 8080 (RawDeployment). The user typically can read this off the
	// InferenceService status URL.
	ServicePort int64 `json:"servicePort,omitempty"`
	// RateLimit, when set, also creates a BackendTrafficPolicy. Per the
	// Envoy AI Gateway recipe, cost.request.number is forced to 0 so only
	// token usage counts.
	RateLimit *RateLimitConfig `json:"rateLimit,omitempty"`
}

// RateLimitConfig is the form shape. Requests + Unit drive the policy; the
// ClientHeader value seeds a per-user clientSelector (e.g. x-user-id).
type RateLimitConfig struct {
	Requests     int64  `json:"requests"`
	Unit         string `json:"unit"` // Second | Minute | Hour | Day
	ClientHeader string `json:"clientHeader,omitempty"`
	// CountTokens=true configures cost.response to charge llm_total_token
	// instead of just the request count (per the envoy-ai-gateway recipe).
	CountTokens bool `json:"countTokens,omitempty"`
}

// CreatedResource describes one K8s object that CreateAIGatewayRoute
// provisioned, so the UI can show "we created these CRs:".
type CreatedResource struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Namespace  string `json:"namespace"`
	Name       string `json:"name"`
}

// CreateAIGatewayRouteResult is the response body.
type CreateAIGatewayRouteResult struct {
	Created []CreatedResource `json:"created"`
}

// CreateAIGatewayRoute provisions the AIServiceBackend + AIGatewayRoute
// (and optionally the BackendTrafficPolicy) needed to expose an
// InferenceService via the Envoy AI Gateway. Resources are created in the
// route's namespace (= the inference service's namespace) for simplicity.
//
// Calling this a second time replaces the previous AIGatewayRoute /
// AIServiceBackend / BackendTrafficPolicy (deterministic names derived from
// the service name).
func (s *Service) CreateAIGatewayRoute(ctx context.Context, namespace, svcName string, req CreateAIGatewayRouteRequest) (CreateAIGatewayRouteResult, error) {
	if svcName == "" {
		return CreateAIGatewayRouteResult{}, errors.New("service name is required")
	}
	if s.dyn == nil {
		return CreateAIGatewayRouteResult{}, errors.New("dynamic client unavailable")
	}
	gwNS := req.GatewayNamespace
	if gwNS == "" {
		gwNS = defaultKServeGatewayNamespace
	}
	gwName := req.GatewayName
	if gwName == "" {
		gwName = defaultKServeGatewayName
	}
	header := req.ModelHeader
	if header == "" {
		header = svcName
	}
	port := req.ServicePort
	if port == 0 {
		port = 80
	}

	created := []CreatedResource{}

	// 1. AIServiceBackend → predictor Service.
	backendName := svcName + "-aibackend"
	backend := map[string]any{
		"apiVersion": "aigateway.envoyproxy.io/v1alpha1",
		"kind":       "AIServiceBackend",
		"metadata": map[string]any{
			"name":      backendName,
			"namespace": namespace,
			"labels":    aiGatewayLabels(svcName),
		},
		"spec": map[string]any{
			"schema": map[string]any{"name": "OpenAI"},
			"backendRef": map[string]any{
				"name": svcName + "-predictor",
				"kind": "Service",
				"port": port,
			},
		},
	}
	obj, err := applyResource(ctx, s.dyn, gvrAIServiceBackend, namespace, backendName, backend)
	if err != nil {
		return CreateAIGatewayRouteResult{}, fmt.Errorf("apply AIServiceBackend: %w", err)
	}
	created = append(created, CreatedResource{
		APIVersion: obj.GetAPIVersion(), Kind: "AIServiceBackend", Namespace: namespace, Name: backendName,
	})

	// 2. AIGatewayRoute.
	routeName := svcName + "-route"
	hostnames := []any{}
	for _, h := range req.Hostnames {
		if h != "" {
			hostnames = append(hostnames, h)
		}
	}
	matches := []any{
		map[string]any{
			"headers": []any{
				map[string]any{"type": "Exact", "name": "x-ai-eg-model", "value": header},
			},
		},
	}
	backendRefs := []any{
		map[string]any{"name": backendName, "kind": "AIServiceBackend"},
	}
	routeSpec := map[string]any{
		"targetRefs": []any{
			map[string]any{
				"group":     "gateway.networking.k8s.io",
				"kind":      "Gateway",
				"name":      gwName,
				"namespace": gwNS,
			},
		},
		"rules": []any{
			map[string]any{"matches": matches, "backendRefs": backendRefs},
		},
	}
	if req.RateLimit != nil && req.RateLimit.CountTokens {
		routeSpec["llmRequestCosts"] = []any{
			map[string]any{
				"metadataKey": "llm_total_token",
				"type":        "OutputToken",
			},
		}
	}
	if len(hostnames) > 0 {
		routeSpec["hostnames"] = hostnames
	}
	route := map[string]any{
		"apiVersion": "aigateway.envoyproxy.io/v1alpha1",
		"kind":       "AIGatewayRoute",
		"metadata": map[string]any{
			"name":      routeName,
			"namespace": namespace,
			"labels":    aiGatewayLabels(svcName),
		},
		"spec": routeSpec,
	}
	obj, err = applyResource(ctx, s.dyn, gvrAIGatewayRoute, namespace, routeName, route)
	if err != nil {
		return CreateAIGatewayRouteResult{}, fmt.Errorf("apply AIGatewayRoute: %w", err)
	}
	created = append(created, CreatedResource{
		APIVersion: obj.GetAPIVersion(), Kind: "AIGatewayRoute", Namespace: namespace, Name: routeName,
	})

	// 3. Optional BackendTrafficPolicy with rate limit.
	if rl := req.RateLimit; rl != nil && rl.Requests > 0 {
		policyName := svcName + "-ratelimit"
		clientSelectors := []any{
			map[string]any{
				"headers": []any{
					map[string]any{
						"type": "Distinct",
						"name": coalesce(rl.ClientHeader, "x-user-id"),
					},
				},
			},
		}
		rule := map[string]any{
			"clientSelectors": clientSelectors,
			"limit": map[string]any{
				"requests": rl.Requests,
				"unit":     coalesce(rl.Unit, "Hour"),
			},
		}
		if rl.CountTokens {
			// Per the Envoy AI Gateway docs: request cost MUST be 0 when
			// counting tokens — otherwise every request counts against the
			// limit alongside the token charge.
			rule["cost"] = map[string]any{
				"request":  map[string]any{"from": "Number", "number": 0},
				"response": map[string]any{
					"from": "Metadata",
					"metadata": map[string]any{
						"namespace": "io.envoy.ai_gateway",
						"key":       "llm_total_token",
					},
				},
			}
		}
		policy := map[string]any{
			"apiVersion": "gateway.envoyproxy.io/v1alpha1",
			"kind":       "BackendTrafficPolicy",
			"metadata": map[string]any{
				"name":      policyName,
				"namespace": namespace,
				"labels":    aiGatewayLabels(svcName),
			},
			"spec": map[string]any{
				"targetRefs": []any{
					map[string]any{
						"group": "aigateway.envoyproxy.io",
						"kind":  "AIGatewayRoute",
						"name":  routeName,
					},
				},
				"rateLimit": map[string]any{
					"type":   "Global",
					"global": map[string]any{"rules": []any{rule}},
				},
			},
		}
		obj, err = applyResource(ctx, s.dyn, gvrBackendTrafficPolicy, namespace, policyName, policy)
		if err != nil {
			return CreateAIGatewayRouteResult{}, fmt.Errorf("apply BackendTrafficPolicy: %w", err)
		}
		created = append(created, CreatedResource{
			APIVersion: obj.GetAPIVersion(), Kind: "BackendTrafficPolicy", Namespace: namespace, Name: policyName,
		})
	}

	// 4. ReferenceGrant only when the gateway lives in another namespace.
	if gwNS != namespace {
		grantName := svcName + "-refgrant"
		grant := map[string]any{
			"apiVersion": "gateway.networking.k8s.io/v1beta1",
			"kind":       "ReferenceGrant",
			"metadata": map[string]any{
				"name":      grantName,
				"namespace": namespace,
				"labels":    aiGatewayLabels(svcName),
			},
			"spec": map[string]any{
				"from": []any{
					map[string]any{
						"group":     "aigateway.envoyproxy.io",
						"kind":      "AIGatewayRoute",
						"namespace": gwNS,
					},
				},
				"to": []any{
					map[string]any{"group": "", "kind": "Service"},
				},
			},
		}
		obj, err = applyResource(ctx, s.dyn, gvrReferenceGrant, namespace, grantName, grant)
		if err != nil {
			// Don't fail the whole call — the AIGatewayRoute still works
			// when the gateway controller has cluster-wide cross-namespace
			// access (some installs do). Surface the failure as a soft
			// suggestion via the response field so the UI can show it.
			created = append(created, CreatedResource{
				APIVersion: "gateway.networking.k8s.io/v1beta1",
				Kind:       "ReferenceGrant (skipped: " + err.Error() + ")",
				Namespace:  namespace,
				Name:       grantName,
			})
		} else {
			created = append(created, CreatedResource{
				APIVersion: obj.GetAPIVersion(), Kind: "ReferenceGrant", Namespace: namespace, Name: grantName,
			})
		}
	}

	return CreateAIGatewayRouteResult{Created: created}, nil
}

// applyResource is "create-or-update by name". Uses unstructured because
// we're mixing CRDs from three different API groups and don't want typed
// schemas for any of them. Resource-version handling: we read the live
// object's resourceVersion before each Update to avoid 409 conflicts on
// rapid re-applies.
func applyResource(ctx context.Context, dyn dynamic.Interface, gvr schema.GroupVersionResource, namespace, name string, body map[string]any) (*unstructured.Unstructured, error) {
	obj := &unstructured.Unstructured{Object: body}
	existing, err := dyn.Resource(gvr).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return dyn.Resource(gvr).Namespace(namespace).Create(ctx, obj, metav1.CreateOptions{})
	}
	if err != nil {
		return nil, err
	}
	obj.SetResourceVersion(existing.GetResourceVersion())
	return dyn.Resource(gvr).Namespace(namespace).Update(ctx, obj, metav1.UpdateOptions{})
}

func aiGatewayLabels(svc string) map[string]any {
	return map[string]any{
		"knaic.io/managed":            "true",
		"knaic.io/component":          "inference-gateway",
		"knaic.io/inference-service":  svc,
	}
}

func coalesce(a, b string) string {
	if a == "" {
		return b
	}
	return a
}
