package notebook

import (
	"context"
	"errors"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

var gvrNotebook = schema.GroupVersionResource{
	Group:    "kubeflow.org",
	Version:  "v1",
	Resource: "notebooks",
}

const (
	// stoppedAnnotation toggles the Kubeflow Notebook controller's
	// scale-to-zero behaviour. Setting it to an RFC3339 timestamp stops the
	// notebook; clearing it brings it back up.
	stoppedAnnotation = "kubeflow-resource-stopped"

	defaultMountPath = "/home/jovyan"
	defaultShm       = "2Gi"
)

type Service struct {
	dyn   dynamic.Interface
	typed kubernetes.Interface
}

func New(dyn dynamic.Interface, typed kubernetes.Interface) *Service {
	return &Service{dyn: dyn, typed: typed}
}

// Create builds and applies the Notebook CR. When req.Volume.Kind == "new"
// it pre-creates a matching PVC so the Notebook controller can reference it
// directly without owning the volume lifecycle.
func (s *Service) Create(ctx context.Context, namespace string, req CreateRequest) (*unstructured.Unstructured, error) {
	if req.Name == "" || req.Image == "" {
		return nil, errors.New("name and image are required")
	}
	if req.CPULimit == "" {
		req.CPULimit = req.CPURequest
	}
	if req.MemoryLimit == "" {
		req.MemoryLimit = req.MemoryRequest
	}
	if req.SharedMemory == "" {
		req.SharedMemory = defaultShm
	}
	if req.Volume.MountPath == "" {
		req.Volume.MountPath = defaultMountPath
	}

	pvcName, err := s.ensurePVC(ctx, namespace, req)
	if err != nil {
		return nil, err
	}

	container := s.buildContainer(req, pvcName)
	volumes := s.buildVolumes(req, pvcName)

	labels := map[string]any{
		"knaic.io/managed":   "true",
		"knaic.io/component": "notebook",
	}
	if req.Owner != "" {
		labels["knaic.io/owner"] = req.Owner
	}

	obj := &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": "kubeflow.org/v1",
			"kind":       "Notebook",
			"metadata": map[string]any{
				"name":      req.Name,
				"namespace": namespace,
				"labels":    labels,
			},
			"spec": map[string]any{
				"template": map[string]any{
					"spec": map[string]any{
						"containers": []any{container},
						"volumes":    volumes,
					},
				},
			},
		},
	}
	return s.dyn.Resource(gvrNotebook).Namespace(namespace).Create(ctx, obj, metav1.CreateOptions{})
}

// Stop / Start use the Kubeflow Notebook controller annotation contract.
func (s *Service) Stop(ctx context.Context, namespace, name string) (*unstructured.Unstructured, error) {
	patch := []byte(fmt.Sprintf(
		`{"metadata":{"annotations":{%q:%q}}}`,
		stoppedAnnotation,
		time.Now().UTC().Format(time.RFC3339),
	))
	return s.dyn.Resource(gvrNotebook).Namespace(namespace).Patch(
		ctx, name, "application/merge-patch+json", patch, metav1.PatchOptions{},
	)
}

func (s *Service) Start(ctx context.Context, namespace, name string) (*unstructured.Unstructured, error) {
	// Setting to null in a merge-patch removes the key.
	patch := []byte(fmt.Sprintf(`{"metadata":{"annotations":{%q:null}}}`, stoppedAnnotation))
	return s.dyn.Resource(gvrNotebook).Namespace(namespace).Patch(
		ctx, name, "application/merge-patch+json", patch, metav1.PatchOptions{},
	)
}

// ensurePVC returns the PVC name to mount. For Kind=new we create the PVC
// (or reuse one with the same name if it already exists). For Kind=existing
// we just validate it exists. For Kind=none we return "" and the volumes
// list will skip the workspace mount.
func (s *Service) ensurePVC(ctx context.Context, namespace string, req CreateRequest) (string, error) {
	switch req.Volume.Kind {
	case VolumeNone, "":
		return "", nil
	case VolumeExisting:
		if req.Volume.PVCName == "" {
			return "", errors.New("volume.pvcName is required when volume.kind is existing")
		}
		_, err := s.typed.CoreV1().PersistentVolumeClaims(namespace).Get(ctx, req.Volume.PVCName, metav1.GetOptions{})
		if err != nil {
			return "", fmt.Errorf("existing PVC %q: %w", req.Volume.PVCName, err)
		}
		return req.Volume.PVCName, nil
	case VolumeNew:
		name := req.Volume.PVCName
		if name == "" {
			name = "notebook-" + req.Name + "-home"
		}
		if _, err := s.typed.CoreV1().PersistentVolumeClaims(namespace).Get(ctx, name, metav1.GetOptions{}); err == nil {
			// Already exists — reuse so re-creates with the same name don't fail.
			return name, nil
		} else if !apierrors.IsNotFound(err) {
			return "", err
		}
		capacity := req.Volume.Capacity
		if capacity == "" {
			capacity = "20Gi"
		}
		qty, err := resource.ParseQuantity(capacity)
		if err != nil {
			return "", fmt.Errorf("invalid capacity %q: %w", capacity, err)
		}
		pvc := &corev1.PersistentVolumeClaim{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name,
				Namespace: namespace,
				Labels: map[string]string{
					"knaic.io/managed":   "true",
					"knaic.io/component": "notebook",
				},
			},
			Spec: corev1.PersistentVolumeClaimSpec{
				AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
				Resources: corev1.VolumeResourceRequirements{
					Requests: corev1.ResourceList{corev1.ResourceStorage: qty},
				},
			},
		}
		if sc := req.Volume.StorageClass; sc != "" {
			pvc.Spec.StorageClassName = &sc
		}
		if _, err := s.typed.CoreV1().PersistentVolumeClaims(namespace).Create(ctx, pvc, metav1.CreateOptions{}); err != nil {
			return "", fmt.Errorf("create PVC %q: %w", name, err)
		}
		return name, nil
	default:
		return "", fmt.Errorf("unknown volume.kind %q", req.Volume.Kind)
	}
}

func (s *Service) buildContainer(req CreateRequest, pvcName string) map[string]any {
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

	mounts := []any{
		map[string]any{"name": "dshm", "mountPath": "/dev/shm"},
	}
	if pvcName != "" {
		mounts = append(mounts, map[string]any{
			"name":      "workspace",
			"mountPath": req.Volume.MountPath,
		})
	}

	container := map[string]any{
		"name":         "notebook",
		"image":        req.Image,
		"resources":    map[string]any{"requests": requests, "limits": limits},
		"volumeMounts": mounts,
	}
	if len(req.Env) > 0 {
		envs := make([]any, 0, len(req.Env))
		for _, e := range req.Env {
			envs = append(envs, map[string]any{"name": e.Name, "value": e.Value})
		}
		container["env"] = envs
	}
	return container
}

func (s *Service) buildVolumes(req CreateRequest, pvcName string) []any {
	shm := req.SharedMemory
	if shm == "" {
		shm = defaultShm
	}
	volumes := []any{
		map[string]any{
			"name": "dshm",
			"emptyDir": map[string]any{
				"medium":    "Memory",
				"sizeLimit": shm,
			},
		},
	}
	if pvcName != "" {
		volumes = append(volumes, map[string]any{
			"name": "workspace",
			"persistentVolumeClaim": map[string]any{
				"claimName": pvcName,
			},
		})
	}
	return volumes
}
