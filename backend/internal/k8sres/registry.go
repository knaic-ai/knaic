// Package k8sres exposes a generic CRUD façade over the Kubernetes API for
// the "Containers" pages of the knaic console.
//
// One Kind entry per resource registers its GroupVersionResource, scope, and
// a server-side Projection function that turns a *unstructured.Unstructured
// into the shape the React tables expect. This keeps the frontend free of
// raw K8s field-walking while still using a single dispatcher on the backend.
package k8sres

import (
	"errors"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// Projection is the shape returned to the frontend (a JSON-friendly map).
type Projection map[string]any

// Projector turns a raw unstructured object into a Projection.
type Projector func(*unstructured.Unstructured) Projection

type Kind struct {
	Slug       string                      // URL segment, e.g. "deployments"
	GVR        schema.GroupVersionResource // typed identifier
	Namespaced bool
	Project    Projector
}

// ErrUnknownKind is returned when a slug doesn't match any registered kind.
var ErrUnknownKind = errors.New("unknown resource kind")

var kinds = map[string]Kind{}

func register(k Kind) {
	kinds[k.Slug] = k
}

// Lookup returns the Kind for a slug.
func Lookup(slug string) (Kind, error) {
	k, ok := kinds[slug]
	if !ok {
		return Kind{}, ErrUnknownKind
	}
	return k, nil
}

// All returns the registered kinds (deterministic order isn't important here
// since callers either look up by slug or iterate for documentation only).
func All() []Kind {
	out := make([]Kind, 0, len(kinds))
	for _, k := range kinds {
		out = append(out, k)
	}
	return out
}

func init() {
	register(Kind{
		Slug:       "deployments",
		GVR:        schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"},
		Namespaced: true,
		Project:    projectDeployment,
	})
	register(Kind{
		Slug:       "statefulsets",
		GVR:        schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "statefulsets"},
		Namespaced: true,
		Project:    projectStatefulSet,
	})
	register(Kind{
		Slug:       "pods",
		GVR:        schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"},
		Namespaced: true,
		Project:    projectPod,
	})
	register(Kind{
		Slug:       "services",
		GVR:        schema.GroupVersionResource{Group: "", Version: "v1", Resource: "services"},
		Namespaced: true,
		Project:    projectService,
	})
	register(Kind{
		Slug:       "configmaps",
		GVR:        schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"},
		Namespaced: true,
		Project:    projectConfigMap,
	})
	register(Kind{
		Slug:       "secrets",
		GVR:        schema.GroupVersionResource{Group: "", Version: "v1", Resource: "secrets"},
		Namespaced: true,
		Project:    projectSecret,
	})
	register(Kind{
		Slug:       "pvcs",
		GVR:        schema.GroupVersionResource{Group: "", Version: "v1", Resource: "persistentvolumeclaims"},
		Namespaced: true,
		Project:    projectPVC,
	})
	register(Kind{
		Slug:       "gateways",
		GVR:        schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "gateways"},
		Namespaced: true,
		Project:    projectGateway,
	})
	register(Kind{
		Slug:       "httproutes",
		GVR:        schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "httproutes"},
		Namespaced: true,
		Project:    projectHTTPRoute,
	})
	register(Kind{
		Slug:       "gatewayclasses",
		GVR:        schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "gatewayclasses"},
		Namespaced: false,
		Project:    projectGatewayClass,
	})
	register(Kind{
		Slug:       "inferenceservices",
		GVR:        schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1beta1", Resource: "inferenceservices"},
		Namespaced: true,
		Project:    projectInferenceService,
	})
	register(Kind{
		Slug:       "llminferenceservices",
		GVR:        schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1alpha2", Resource: "llminferenceservices"},
		Namespaced: true,
		Project:    projectLLMInferenceService,
	})
	register(Kind{
		Slug:       "servingruntimes",
		GVR:        schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1alpha1", Resource: "servingruntimes"},
		Namespaced: true,
		Project:    projectServingRuntime,
	})
	register(Kind{
		Slug:       "clusterservingruntimes",
		GVR:        schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1alpha1", Resource: "clusterservingruntimes"},
		Namespaced: false,
		Project:    projectServingRuntime,
	})
	register(Kind{
		Slug:       "clusterstoragecontainers",
		GVR:        schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1alpha1", Resource: "clusterstoragecontainers"},
		Namespaced: false,
		Project:    projectClusterStorageContainer,
	})
	register(Kind{
		Slug:       "llminferenceserviceconfigs",
		GVR:        schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1alpha2", Resource: "llminferenceserviceconfigs"},
		Namespaced: true,
		Project:    projectLLMInferenceServiceConfig,
	})
	// KServe local model cache CRDs (cluster-scoped). The DaemonSet
	// `kserve-localmodelnode-agent` watches LocalModelCaches and pre-downloads
	// model blobs into the node-local hostPath defined by the NodeGroup's
	// persistentVolumeSpec.local.path.
	register(Kind{
		Slug:       "localmodelnodegroups",
		GVR:        schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1alpha1", Resource: "localmodelnodegroups"},
		Namespaced: false,
		Project:    projectLocalModelNodeGroup,
	})
	register(Kind{
		Slug:       "localmodelcaches",
		GVR:        schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1alpha1", Resource: "localmodelcaches"},
		Namespaced: false,
		Project:    projectLocalModelCache,
	})
	register(Kind{
		Slug:       "notebooks",
		GVR:        schema.GroupVersionResource{Group: "kubeflow.org", Version: "v1", Resource: "notebooks"},
		Namespaced: true,
		Project:    projectNotebook,
	})
	register(Kind{
		Slug:       "trainjobs",
		GVR:        schema.GroupVersionResource{Group: "trainer.kubeflow.org", Version: "v1alpha1", Resource: "trainjobs"},
		Namespaced: true,
		Project:    projectTrainJob,
	})
	register(Kind{
		Slug:       "trainingruntimes",
		GVR:        schema.GroupVersionResource{Group: "trainer.kubeflow.org", Version: "v1alpha1", Resource: "trainingruntimes"},
		Namespaced: true,
		Project:    projectTrainingRuntime,
	})
	register(Kind{
		Slug:       "clustertrainingruntimes",
		GVR:        schema.GroupVersionResource{Group: "trainer.kubeflow.org", Version: "v1alpha1", Resource: "clustertrainingruntimes"},
		Namespaced: false,
		Project:    projectTrainingRuntime,
	})
}
