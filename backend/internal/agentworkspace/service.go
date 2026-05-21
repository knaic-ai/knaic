// Package agentworkspace provisions a per-user Codex Web pod (Deployment +
// Service + PVC) and exposes it through a reverse proxy. Narrowed to the
// codex-web runtime and wired to a single SA-backed Kubernetes client, so
// any authenticated caller can provision their own without per-namespace
// Deployment RBAC.
//
// The workspace is keyed on a stable DNS-safe slug of the caller's OIDC
// identity (Email > Subject), so first-login auto-creation is idempotent and
// the per-user Deployment / Service / PVC names survive restarts.
package agentworkspace

import (
	"context"
	"fmt"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes"
)

const (
	labelManaged   = "knaic.io/managed"
	labelComponent = "knaic.io/component"
	// labelOwner carries the sanitized owner slug (the same slug used as
	// the workspace name suffix). K8s label values can't hold characters
	// like '@' or '+' that appear in real OIDC identities, so the raw
	// value lives in annotationOwnerID instead.
	labelOwner          = "knaic.io/owner"
	annotationOwnerID   = "knaic.io/owner-id"
	componentValue      = "agent-workspace"

	resourcePrefix = "knaic-agent-"
	containerPort  = int32(8080)
)

// Options configures the per-pod runtime. All fields have safe defaults via
// normalize().
type Options struct {
	Namespace        string
	Image            string
	Storage          string
	CPURequest       string
	CPULimit         string
	MemoryRequest    string
	MemoryLimit      string
	ImagePullSecrets []string
	StorageClass     string
}

// Workspace is the JSON-serializable view returned to the frontend.
type Workspace struct {
	Name      string    `json:"name"`
	Namespace string    `json:"namespace"`
	OwnerID   string    `json:"ownerId"`
	Status    string    `json:"status"`
	Image     string    `json:"image"`
	Storage   string    `json:"storage"`
	Route     string    `json:"route"`
	CreatedAt time.Time `json:"createdAt"`
}

// ResourceSpec is the subset of pod resources the UI can edit. Empty strings
// mean "leave unchanged". Storage resizes the PVC (grow only on most CSI
// drivers).
type ResourceSpec struct {
	CPURequest    string `json:"cpuRequest,omitempty"`
	CPULimit      string `json:"cpuLimit,omitempty"`
	MemoryRequest string `json:"memoryRequest,omitempty"`
	MemoryLimit   string `json:"memoryLimit,omitempty"`
	Storage       string `json:"storage,omitempty"`
}

type Service struct {
	client kubernetes.Interface
	opts   Options
}

func New(client kubernetes.Interface, opts Options) *Service {
	return &Service{client: client, opts: normalize(opts)}
}

// Namespace returns the namespace per-user workspaces are provisioned in.
// Surfaced so the proxy handler can build the in-cluster Service URL without
// peeking inside Options.
func (s *Service) Namespace() string { return s.opts.Namespace }

// Image returns the codex-web image the service was configured with. Useful
// for the cluster-info / debug endpoints that surface deployment defaults.
func (s *Service) Image() string { return s.opts.Image }

// Get returns the caller's workspace if it exists. Returns IsNotFound when the
// Deployment hasn't been created yet so callers can decide whether to 404 or
// auto-provision.
func (s *Service) Get(ctx context.Context, ownerID string) (Workspace, error) {
	name := WorkspaceName(ownerID)
	deploy, err := s.client.AppsV1().Deployments(s.opts.Namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return Workspace{}, err
	}
	return s.workspaceFromDeployment(ctx, deploy, ownerID), nil
}

// Ensure returns the caller's workspace, creating Deployment + Service + PVC
// if missing. Safe to call repeatedly — already-exists errors collapse to no-
// op so re-entrant first-login flows just see the existing resources.
func (s *Service) Ensure(ctx context.Context, ownerID string) (Workspace, error) {
	ws, err := s.Get(ctx, ownerID)
	if err == nil {
		return ws, nil
	}
	if !apierrors.IsNotFound(err) {
		return Workspace{}, err
	}
	if err := s.ensurePVC(ctx, ownerID); err != nil {
		return Workspace{}, fmt.Errorf("pvc: %w", err)
	}
	if err := s.ensureService(ctx, ownerID); err != nil {
		return Workspace{}, fmt.Errorf("service: %w", err)
	}
	if err := s.ensureDeployment(ctx, ownerID); err != nil {
		return Workspace{}, fmt.Errorf("deployment: %w", err)
	}
	return s.Get(ctx, ownerID)
}

// Restart rolls the workspace pod without changing the Deployment spec by
// patching a "restartedAt" pod-template annotation — same trick kubectl
// rollout restart uses. Cleaner than scale 0→1 because it doesn't strand the
// PVC reader and triggers a normal rolling update.
func (s *Service) Restart(ctx context.Context, ownerID string) error {
	name := WorkspaceName(ownerID)
	patch := []byte(fmt.Sprintf(
		`{"spec":{"template":{"metadata":{"annotations":{"knaic.io/restartedAt":%q}}}}}`,
		time.Now().UTC().Format(time.RFC3339),
	))
	_, err := s.client.AppsV1().Deployments(s.opts.Namespace).Patch(
		ctx, name, types.StrategicMergePatchType, patch, metav1.PatchOptions{},
	)
	return err
}

// UpdateResources patches the Deployment's primary container resources and
// (optionally) resizes the PVC. The Deployment patch implicitly rolls the
// pod; PVC resize requires the StorageClass to allow volume expansion.
func (s *Service) UpdateResources(ctx context.Context, ownerID string, spec ResourceSpec) (Workspace, error) {
	name := WorkspaceName(ownerID)
	deploy, err := s.client.AppsV1().Deployments(s.opts.Namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return Workspace{}, fmt.Errorf("get deployment: %w", err)
	}
	if len(deploy.Spec.Template.Spec.Containers) == 0 {
		return Workspace{}, fmt.Errorf("deployment %s has no containers", name)
	}
	c := &deploy.Spec.Template.Spec.Containers[0]
	if c.Resources.Requests == nil {
		c.Resources.Requests = corev1.ResourceList{}
	}
	if c.Resources.Limits == nil {
		c.Resources.Limits = corev1.ResourceList{}
	}
	if err := setQuantity(c.Resources.Requests, corev1.ResourceCPU, spec.CPURequest, "cpuRequest"); err != nil {
		return Workspace{}, err
	}
	if err := setQuantity(c.Resources.Limits, corev1.ResourceCPU, spec.CPULimit, "cpuLimit"); err != nil {
		return Workspace{}, err
	}
	if err := setQuantity(c.Resources.Requests, corev1.ResourceMemory, spec.MemoryRequest, "memoryRequest"); err != nil {
		return Workspace{}, err
	}
	if err := setQuantity(c.Resources.Limits, corev1.ResourceMemory, spec.MemoryLimit, "memoryLimit"); err != nil {
		return Workspace{}, err
	}
	if _, err := s.client.AppsV1().Deployments(s.opts.Namespace).Update(ctx, deploy, metav1.UpdateOptions{}); err != nil {
		return Workspace{}, fmt.Errorf("update deployment: %w", err)
	}
	if spec.Storage != "" {
		q, err := resource.ParseQuantity(spec.Storage)
		if err != nil {
			return Workspace{}, fmt.Errorf("storage: %w", err)
		}
		pvcName := name + "-home"
		pvc, err := s.client.CoreV1().PersistentVolumeClaims(s.opts.Namespace).Get(ctx, pvcName, metav1.GetOptions{})
		if err != nil {
			return Workspace{}, fmt.Errorf("get pvc: %w", err)
		}
		pvc.Spec.Resources.Requests[corev1.ResourceStorage] = q
		if _, err := s.client.CoreV1().PersistentVolumeClaims(s.opts.Namespace).Update(ctx, pvc, metav1.UpdateOptions{}); err != nil {
			return Workspace{}, fmt.Errorf("update pvc: %w", err)
		}
	}
	return s.Get(ctx, ownerID)
}

// Delete removes the Deployment, Service, and PVC. Each resource is removed
// best-effort; not-found is treated as success so repeated deletes are
// idempotent.
func (s *Service) Delete(ctx context.Context, ownerID string) error {
	name := WorkspaceName(ownerID)
	policy := metav1.DeletePropagationForeground
	dopts := metav1.DeleteOptions{PropagationPolicy: &policy}
	if err := s.client.AppsV1().Deployments(s.opts.Namespace).Delete(ctx, name, dopts); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete deployment: %w", err)
	}
	if err := s.client.CoreV1().Services(s.opts.Namespace).Delete(ctx, name, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete service: %w", err)
	}
	if err := s.client.CoreV1().PersistentVolumeClaims(s.opts.Namespace).Delete(ctx, name+"-home", metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete pvc: %w", err)
	}
	return nil
}

// ServiceDNS returns the in-cluster DNS name the reverse proxy should target.
// Exported so the API layer can build the *url.URL without knowing the naming
// scheme.
func (s *Service) ServiceDNS(ownerID string) string {
	return fmt.Sprintf("http://%s.%s.svc.cluster.local", WorkspaceName(ownerID), s.opts.Namespace)
}

func (s *Service) ensurePVC(ctx context.Context, ownerID string) error {
	name := WorkspaceName(ownerID) + "-home"
	_, err := s.client.CoreV1().PersistentVolumeClaims(s.opts.Namespace).Get(ctx, name, metav1.GetOptions{})
	if err == nil {
		return nil
	}
	if !apierrors.IsNotFound(err) {
		return err
	}
	qty, err := resource.ParseQuantity(s.opts.Storage)
	if err != nil {
		return err
	}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: s.objectMeta(name, ownerID),
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: qty},
			},
		},
	}
	if s.opts.StorageClass != "" {
		sc := s.opts.StorageClass
		pvc.Spec.StorageClassName = &sc
	}
	_, err = s.client.CoreV1().PersistentVolumeClaims(s.opts.Namespace).Create(ctx, pvc, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return nil
	}
	return err
}

func (s *Service) ensureService(ctx context.Context, ownerID string) error {
	name := WorkspaceName(ownerID)
	svc := &corev1.Service{
		ObjectMeta: s.objectMeta(name, ownerID),
		Spec: corev1.ServiceSpec{
			Selector: map[string]string{"app.kubernetes.io/name": name},
			Ports: []corev1.ServicePort{{
				Name:       "http",
				Port:       80,
				TargetPort: intstr.FromInt32(containerPort),
			}},
		},
	}
	_, err := s.client.CoreV1().Services(s.opts.Namespace).Create(ctx, svc, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return nil
	}
	return err
}

func (s *Service) ensureDeployment(ctx context.Context, ownerID string) error {
	name := WorkspaceName(ownerID)
	pvcName := name + "-home"
	replicas := int32(1)
	labels := map[string]string{
		"app.kubernetes.io/name":    name,
		"app.kubernetes.io/part-of": "knaic",
		labelManaged:                "true",
		labelComponent:              componentValue,
		labelOwner:                  ownerLabelValue(ownerID),
	}
	// Shared volumes between the web container and the codex sidecar:
	// /workspace is the user's working tree; /codex-home is a sub-path
	// of the same PVC (.codex-home/ under the workspace root) so codex
	// settings, login credentials, and config.toml survive pod restarts.
	sharedMounts := []corev1.VolumeMount{
		{Name: "home", MountPath: "/workspace"},
		{Name: "home", MountPath: "/codex-home", SubPath: ".codex-home"},
	}
	sidecarEnv := []corev1.EnvVar{
		{Name: "CODEX_HOME", Value: "/codex-home"},
		{Name: "HOME", Value: "/codex-home"},
		{Name: "RUST_LOG", Value: "info"},
		// codex 0.129+ requires the provider's env_key to resolve to a
		// non-empty string at startup. Placeholder so the sidecar boots
		// before the user saves real settings.
		{Name: "OPENAI_API_KEY", Value: "placeholder"},
	}
	containerEnv := []corev1.EnvVar{
		{Name: "PORT", Value: fmt.Sprintf("%d", containerPort)},
		{Name: "WORKSPACE_DIR", Value: "/workspace"},
		{Name: "CODEX_HOME", Value: "/codex-home"},
		{Name: "HOME", Value: "/codex-home"},
		// Where the web container reaches the sidecar's app-server over
		// loopback. Browser never sees this URL.
		{Name: "CODEX_APP_SERVER_URL", Value: "ws://127.0.0.1:7878"},
	}
	deploy := &appsv1.Deployment{
		ObjectMeta: s.objectMeta(name, ownerID),
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app.kubernetes.io/name": name}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					// ShareProcessNamespace lets the codex-web container signal
					// the sidecar so codex app-server can reload its config
					// without a full pod restart.
					ShareProcessNamespace: boolPtr(true),
					ImagePullSecrets:      localObjectReferences(s.opts.ImagePullSecrets),
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: boolPtr(true),
						RunAsUser:    int64Ptr(1000),
						RunAsGroup:   int64Ptr(1000),
						FSGroup:      int64Ptr(1000),
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Containers: []corev1.Container{
						{
							Name:            "workspace",
							Image:           s.opts.Image,
							ImagePullPolicy: corev1.PullAlways,
							Env:             containerEnv,
							Ports:           []corev1.ContainerPort{{Name: "http", ContainerPort: containerPort}},
							SecurityContext: hardenedContainerSecurityContext(),
							Resources: corev1.ResourceRequirements{
								Requests: resourceList(s.opts.CPURequest, s.opts.MemoryRequest),
								Limits:   resourceList(s.opts.CPULimit, s.opts.MemoryLimit),
							},
							VolumeMounts: sharedMounts,
						},
						{
							Name:            "codex-server",
							Image:           s.opts.Image,
							ImagePullPolicy: corev1.PullAlways,
							Command:         []string{"codex"},
							Args:            []string{"app-server", "--listen", "ws://127.0.0.1:7878"},
							Env:             sidecarEnv,
							SecurityContext: hardenedContainerSecurityContext(),
							VolumeMounts:    sharedMounts,
						},
					},
					Volumes: []corev1.Volume{{
						Name: "home",
						VolumeSource: corev1.VolumeSource{
							PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: pvcName},
						},
					}},
				},
			},
		},
	}
	_, err := s.client.AppsV1().Deployments(s.opts.Namespace).Create(ctx, deploy, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return nil
	}
	return err
}

func (s *Service) workspaceFromDeployment(ctx context.Context, deploy *appsv1.Deployment, ownerID string) Workspace {
	name := deploy.Name
	ws := Workspace{
		Name:      name,
		Namespace: deploy.Namespace,
		OwnerID:   defaultString(deploy.Annotations[annotationOwnerID], ownerID),
		Status:    statusFromDeployment(deploy),
		CreatedAt: deploy.CreationTimestamp.Time,
		Route:     "/api/v1/me/workspace/proxy/",
	}
	if len(deploy.Spec.Template.Spec.Containers) > 0 {
		ws.Image = deploy.Spec.Template.Spec.Containers[0].Image
	}
	if pvc, err := s.client.CoreV1().PersistentVolumeClaims(deploy.Namespace).Get(ctx, name+"-home", metav1.GetOptions{}); err == nil {
		if qty, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
			ws.Storage = qty.String()
		}
	}
	return ws
}

func (s *Service) objectMeta(name, ownerID string) metav1.ObjectMeta {
	return metav1.ObjectMeta{
		Name:      name,
		Namespace: s.opts.Namespace,
		Labels: map[string]string{
			"app.kubernetes.io/name":    name,
			"app.kubernetes.io/part-of": "knaic",
			labelManaged:                "true",
			labelComponent:              componentValue,
			labelOwner:                  ownerLabelValue(ownerID),
		},
		Annotations: map[string]string{
			annotationOwnerID: ownerID,
		},
	}
}

// ownerLabelValue strips characters K8s rejects in label values from the
// owner identity (e.g. '@', '+'). Reuses the same slugification logic as
// WorkspaceName so the label, the workspace name suffix, and any future
// selector all line up.
func ownerLabelValue(ownerID string) string {
	return strings.TrimPrefix(WorkspaceName(ownerID), resourcePrefix)
}

// WorkspaceName derives a stable, DNS-safe Deployment/Service/PVC name from
// the caller's OIDC identity. Exported because the proxy handler needs the
// same naming to look up the workspace.
func WorkspaceName(ownerID string) string {
	cleaned := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r
		case r >= '0' && r <= '9':
			return r
		case r == '-':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		}
		return '-'
	}, ownerID)
	cleaned = strings.Trim(cleaned, "-")
	if cleaned == "" {
		cleaned = "user"
	}
	// Cap the slug so name + suffixes (e.g. "-home") stay well under the
	// 63-char DNS-label limit.
	if len(cleaned) > 40 {
		cleaned = cleaned[:40]
	}
	return resourcePrefix + cleaned
}

func statusFromDeployment(deploy *appsv1.Deployment) string {
	desired := int32(0)
	if deploy.Spec.Replicas != nil {
		desired = *deploy.Spec.Replicas
	}
	if desired == 0 {
		return "Stopped"
	}
	if deploy.Status.ReadyReplicas >= desired {
		return "Running"
	}
	return "Starting"
}

func resourceList(cpu, memory string) corev1.ResourceList {
	out := corev1.ResourceList{}
	if cpu != "" {
		out[corev1.ResourceCPU] = resource.MustParse(cpu)
	}
	if memory != "" {
		out[corev1.ResourceMemory] = resource.MustParse(memory)
	}
	return out
}

func setQuantity(list corev1.ResourceList, name corev1.ResourceName, value, field string) error {
	if value == "" {
		return nil
	}
	q, err := resource.ParseQuantity(value)
	if err != nil {
		return fmt.Errorf("%s: %w", field, err)
	}
	list[name] = q
	return nil
}

func hardenedContainerSecurityContext() *corev1.SecurityContext {
	return &corev1.SecurityContext{
		AllowPrivilegeEscalation: boolPtr(false),
		Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
	}
}

func localObjectReferences(names []string) []corev1.LocalObjectReference {
	out := make([]corev1.LocalObjectReference, 0, len(names))
	for _, n := range names {
		if n != "" {
			out = append(out, corev1.LocalObjectReference{Name: n})
		}
	}
	return out
}

func boolPtr(v bool) *bool   { return &v }
func int64Ptr(v int64) *int64 { return &v }

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func normalize(opts Options) Options {
	if opts.Namespace == "" {
		opts.Namespace = "knaic-system"
	}
	if opts.Image == "" {
		opts.Image = "ghcr.io/knaic/codex-web:latest"
	}
	if opts.Storage == "" {
		opts.Storage = "40Gi"
	}
	if opts.CPURequest == "" {
		opts.CPURequest = "500m"
	}
	if opts.CPULimit == "" {
		opts.CPULimit = "2"
	}
	if opts.MemoryRequest == "" {
		opts.MemoryRequest = "1Gi"
	}
	if opts.MemoryLimit == "" {
		opts.MemoryLimit = "4Gi"
	}
	return opts
}
