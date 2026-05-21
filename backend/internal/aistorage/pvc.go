package aistorage

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// Default image for the per-PVC web UI. Pinned to a stable tag so we don't
// silently roll into a new major. Override per environment with
// KNAIC_PVC_VIEWER_IMAGE — see internal/api/aistorage.go where this is
// resolved.
const DefaultPVCViewerImage = "filebrowser/filebrowser:v2.31.2"

// PVCViewerStatus is what the UI polls to decide whether to show the
// "Start" button or the iframe.
type PVCViewerStatus struct {
	PVC        string `json:"pvc"`
	Running    bool   `json:"running"`
	Ready      bool   `json:"ready"`
	Phase      string `json:"phase,omitempty"`
	Deployment string `json:"deployment,omitempty"`
	Service    string `json:"service,omitempty"`
	StartedAt  string `json:"startedAt,omitempty"`
	// ViewerPath is the path the frontend should mount in its iframe —
	// the proxy under the same backend, so no cross-origin concerns.
	ViewerPath string `json:"viewerPath,omitempty"`
}

// PVCViewerOptions tunes a single viewer Deployment. Held in a struct so
// the HTTP layer can pass through `KNAIC_PVC_VIEWER_IMAGE` overrides
// without each method growing a new arg.
type PVCViewerOptions struct {
	Image string
}

func (o PVCViewerOptions) image() string {
	if o.Image != "" {
		return o.Image
	}
	return DefaultPVCViewerImage
}

// viewerName turns a PVC name into the Deployment/Service name. We prefix
// with `pvcv-` (PVC viewer) so the resources are easy to spot and impossible
// to collide with arbitrary user resources.
//
// PVC names are valid DNS-1123 subdomains (≤253 chars) but the resulting
// Deployment is a DNS-1123 label (≤63 chars), so we truncate with a 40-char
// budget on the PVC slice; the remaining room covers the prefix and a hash
// suffix should we need one. For the typical PVC name (≤30 chars) the
// resulting "pvcv-<pvc>" fits comfortably.
func viewerName(pvc string) string {
	const max = 40
	out := pvc
	if len(out) > max {
		out = out[:max]
	}
	return "pvcv-" + out
}

// PVCList lists PVCs in the namespace (lightweight projection — name,
// capacity, status — so the AI Storage PVC page doesn't need to detour
// through the generic k8sres handler).
type PVCEntry struct {
	Name         string `json:"name"`
	StorageClass string `json:"storageClass,omitempty"`
	Capacity     string `json:"capacity,omitempty"`
	AccessMode   string `json:"accessMode,omitempty"`
	Phase        string `json:"phase,omitempty"`
	Viewer       string `json:"viewer,omitempty"` // "running" | "ready" | ""
	CreatedAt    string `json:"createdAt,omitempty"`
}

func (s *Service) ListPVCs(ctx context.Context, namespace string) ([]PVCEntry, error) {
	pvcs, err := s.typed.CoreV1().PersistentVolumeClaims(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	// Pull viewer Deployments in one shot so we can tag each PVC row with
	// its viewer state without N+1 Get calls.
	dps, err := s.typed.AppsV1().Deployments(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("%s=%s,%s", labelComponent, componentValue, labelPVC),
	})
	if err != nil {
		return nil, err
	}
	viewerByPVC := make(map[string]string, len(dps.Items))
	for i := range dps.Items {
		d := &dps.Items[i]
		pvc := d.Labels[labelPVC]
		state := "running"
		if d.Status.ReadyReplicas > 0 {
			state = "ready"
		}
		viewerByPVC[pvc] = state
	}
	out := make([]PVCEntry, 0, len(pvcs.Items))
	for i := range pvcs.Items {
		p := &pvcs.Items[i]
		entry := PVCEntry{
			Name:      p.Name,
			Phase:     string(p.Status.Phase),
			CreatedAt: p.CreationTimestamp.Format(time.RFC3339),
			Viewer:    viewerByPVC[p.Name],
		}
		if p.Spec.StorageClassName != nil {
			entry.StorageClass = *p.Spec.StorageClassName
		}
		if c, ok := p.Status.Capacity[corev1.ResourceStorage]; ok {
			entry.Capacity = c.String()
		} else if q, ok := p.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
			entry.Capacity = q.String()
		}
		if len(p.Spec.AccessModes) > 0 {
			entry.AccessMode = string(p.Spec.AccessModes[0])
		}
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// StartViewer creates the filebrowser Deployment + Service if missing.
// Idempotent: a second call on a running viewer is a no-op that returns
// the current status.
func (s *Service) StartViewer(ctx context.Context, namespace, pvc string, opts PVCViewerOptions) (PVCViewerStatus, error) {
	if _, err := s.typed.CoreV1().PersistentVolumeClaims(namespace).Get(ctx, pvc, metav1.GetOptions{}); err != nil {
		return PVCViewerStatus{}, err
	}
	name := viewerName(pvc)
	labels := map[string]string{
		labelManaged:   "true",
		labelComponent: componentValue,
		labelPVC:       pvc,
		"app":          name,
	}
	replicas := int32(1)
	dp := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
			Labels:    labels,
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": name}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					Volumes: []corev1.Volume{{
						Name: "data",
						VolumeSource: corev1.VolumeSource{
							PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: pvc},
						},
					}},
					Containers: []corev1.Container{{
						Name:  "filebrowser",
						Image: opts.image(),
						Args: []string{
							"--noauth",
							"--address", "0.0.0.0",
							"--port", "80",
							"--root", "/srv",
							// The viewer is exposed under
							// /api/v1/namespaces/{ns}/aistorage/pvc/{pvc}/viewer/
							// — filebrowser needs to know that base path so
							// its own emitted URLs are correct.
							"--baseurl", fmt.Sprintf("/api/v1/namespaces/%s/aistorage/pvc/%s/viewer", namespace, pvc),
						},
						Ports: []corev1.ContainerPort{{ContainerPort: 80, Name: "http"}},
						VolumeMounts: []corev1.VolumeMount{
							{Name: "data", MountPath: "/srv"},
						},
						ReadinessProbe: &corev1.Probe{
							ProbeHandler: corev1.ProbeHandler{
								HTTPGet: &corev1.HTTPGetAction{
									// filebrowser's --baseurl prefixes every
									// path it serves, including /health. The
									// kubelet probe goes straight to the
									// container, not through our proxy, so
									// we have to use the prefixed path here.
									Path: fmt.Sprintf("/api/v1/namespaces/%s/aistorage/pvc/%s/viewer/health", namespace, pvc),
									Port: intstr.FromInt32(80),
								},
							},
							InitialDelaySeconds: 2,
							PeriodSeconds:       5,
						},
					}},
				},
			},
		},
	}
	if _, err := s.typed.AppsV1().Deployments(namespace).Create(ctx, dp, metav1.CreateOptions{}); err != nil {
		if !apierrors.IsAlreadyExists(err) {
			return PVCViewerStatus{}, err
		}
	}
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
			Labels:    labels,
		},
		Spec: corev1.ServiceSpec{
			Selector: map[string]string{"app": name},
			Ports: []corev1.ServicePort{{
				Name:       "http",
				Port:       80,
				TargetPort: intstr.FromInt32(80),
			}},
		},
	}
	if _, err := s.typed.CoreV1().Services(namespace).Create(ctx, svc, metav1.CreateOptions{}); err != nil {
		if !apierrors.IsAlreadyExists(err) {
			return PVCViewerStatus{}, err
		}
	}
	return s.ViewerStatus(ctx, namespace, pvc)
}

// StopViewer deletes the Deployment + Service. The PVC itself is untouched.
func (s *Service) StopViewer(ctx context.Context, namespace, pvc string) error {
	name := viewerName(pvc)
	if err := s.typed.AppsV1().Deployments(namespace).Delete(ctx, name, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	if err := s.typed.CoreV1().Services(namespace).Delete(ctx, name, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	return nil
}

func (s *Service) ViewerStatus(ctx context.Context, namespace, pvc string) (PVCViewerStatus, error) {
	name := viewerName(pvc)
	out := PVCViewerStatus{
		PVC:        pvc,
		Deployment: name,
		Service:    name,
		ViewerPath: fmt.Sprintf("/api/v1/namespaces/%s/aistorage/pvc/%s/viewer/", namespace, pvc),
	}
	dp, err := s.typed.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		out.Running = false
		return out, nil
	}
	if err != nil {
		return PVCViewerStatus{}, err
	}
	out.Running = true
	if dp.Status.ReadyReplicas > 0 {
		out.Ready = true
	}
	if !dp.CreationTimestamp.IsZero() {
		out.StartedAt = dp.CreationTimestamp.Format(time.RFC3339)
	}
	for _, c := range dp.Status.Conditions {
		if c.Type == appsv1.DeploymentAvailable {
			out.Phase = string(c.Status)
		}
	}
	return out, nil
}

// ViewerReverseProxy returns an httputil.ReverseProxy that targets the
// per-PVC Service inside the cluster. Callers wrap it as an HTTP handler
// behind a chi route that strips everything up to and including ".../viewer".
//
// We resolve the target via the in-cluster DNS name
// (<svc>.<ns>.svc.cluster.local:80). When the backend runs out of cluster
// (e.g. `make run` locally), the target won't resolve — that's by design;
// the feature is only useful in-cluster.
func ViewerReverseProxy(namespace, pvc string) http.Handler {
	name := viewerName(pvc)
	target := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("%s.%s.svc.cluster.local:80", name, namespace),
	}
	rp := httputil.NewSingleHostReverseProxy(target)
	// The default Director sets Host to the original — flip it to the
	// upstream so filebrowser's host check (if any) doesn't reject us.
	origDirector := rp.Director
	rp.Director = func(req *http.Request) {
		origDirector(req)
		req.Host = target.Host
	}
	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		http.Error(w, "PVC viewer not reachable: "+err.Error(), http.StatusBadGateway)
	}
	return rp
}

// EnsurePVCExists is exposed so the HTTP layer can validate up front
// before invoking StartViewer (avoids creating viewer resources when the
// PVC has been deleted out from under us).
func (s *Service) EnsurePVCExists(ctx context.Context, namespace, pvc string) error {
	_, err := s.typed.CoreV1().PersistentVolumeClaims(namespace).Get(ctx, pvc, metav1.GetOptions{})
	return err
}

// CreatePVCRequest is the body for POST /aistorage/pvc.
type CreatePVCRequest struct {
	Name         string `json:"name"`
	StorageClass string `json:"storageClass,omitempty"`
	Capacity     string `json:"capacity"`
	AccessMode   string `json:"accessMode,omitempty"` // "ReadWriteOnce" | "ReadWriteMany" | ...
}

func (s *Service) CreatePVC(ctx context.Context, namespace string, req CreatePVCRequest) (PVCEntry, error) {
	if req.Name == "" || req.Capacity == "" {
		return PVCEntry{}, errors.New("name and capacity are required")
	}
	qty, err := resource.ParseQuantity(req.Capacity)
	if err != nil {
		return PVCEntry{}, fmt.Errorf("invalid capacity %q: %w", req.Capacity, err)
	}
	mode := corev1.ReadWriteOnce
	if req.AccessMode != "" {
		mode = corev1.PersistentVolumeAccessMode(req.AccessMode)
	}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      req.Name,
			Namespace: namespace,
			Labels: map[string]string{
				labelManaged:   "true",
				labelComponent: componentValue,
			},
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{mode},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceStorage: qty,
				},
			},
		},
	}
	if req.StorageClass != "" {
		sc := req.StorageClass
		pvc.Spec.StorageClassName = &sc
	}
	created, err := s.typed.CoreV1().PersistentVolumeClaims(namespace).Create(ctx, pvc, metav1.CreateOptions{})
	if err != nil {
		return PVCEntry{}, err
	}
	entry := PVCEntry{
		Name:      created.Name,
		Phase:     string(created.Status.Phase),
		CreatedAt: created.CreationTimestamp.Format(time.RFC3339),
	}
	if created.Spec.StorageClassName != nil {
		entry.StorageClass = *created.Spec.StorageClassName
	}
	if q, ok := created.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
		entry.Capacity = q.String()
	}
	if len(created.Spec.AccessModes) > 0 {
		entry.AccessMode = string(created.Spec.AccessModes[0])
	}
	return entry, nil
}

func (s *Service) DeletePVC(ctx context.Context, namespace, name string) error {
	// Tear down the viewer first so the PVC isn't held by a Pod when we
	// try to delete it. The Stop is idempotent — fine to call even if no
	// viewer is running.
	_ = s.StopViewer(ctx, namespace, name)
	return s.typed.CoreV1().PersistentVolumeClaims(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}
