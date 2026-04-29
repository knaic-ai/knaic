package k8sres

import (
	"context"
	"errors"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/yaml"
)

// Service is the generic CRUD façade exposed to the API layer.
type Service struct {
	dyn   dynamic.Interface
	typed kubernetes.Interface
}

func NewService(dyn dynamic.Interface, typed kubernetes.Interface) *Service {
	return &Service{dyn: dyn, typed: typed}
}

// List returns all objects of a kind in a namespace, projected for the UI.
// Pass namespace="" with a cluster-scoped kind to list cluster-wide.
func (s *Service) List(ctx context.Context, k Kind, namespace string) ([]Projection, error) {
	if k.Namespaced && namespace == "" {
		return nil, fmt.Errorf("namespace required for %s", k.Slug)
	}
	var (
		list *unstructured.UnstructuredList
		err  error
	)
	if k.Namespaced {
		list, err = s.dyn.Resource(k.GVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
	} else {
		list, err = s.dyn.Resource(k.GVR).List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		return nil, err
	}
	out := make([]Projection, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, k.Project(&list.Items[i]))
	}
	return out, nil
}

// Get returns a single projected object.
func (s *Service) Get(ctx context.Context, k Kind, namespace, name string) (Projection, error) {
	o, err := s.fetch(ctx, k, namespace, name)
	if err != nil {
		return nil, err
	}
	return k.Project(o), nil
}

// Create creates an object of the registered kind and returns its projection.
// The namespace is always taken from the URL path for namespaced resources so
// callers cannot accidentally create across namespace boundaries.
func (s *Service) Create(ctx context.Context, k Kind, namespace string, obj map[string]any) (Projection, error) {
	u, err := normaliseObject(k, namespace, "", obj)
	if err != nil {
		return nil, err
	}
	var created *unstructured.Unstructured
	if k.Namespaced {
		created, err = s.dyn.Resource(k.GVR).Namespace(namespace).Create(ctx, u, metav1.CreateOptions{})
	} else {
		created, err = s.dyn.Resource(k.GVR).Create(ctx, u, metav1.CreateOptions{})
	}
	if err != nil {
		return nil, err
	}
	return k.Project(created), nil
}

// Update replaces an existing object and returns its projection.
func (s *Service) Update(ctx context.Context, k Kind, namespace, name string, obj map[string]any) (Projection, error) {
	if name == "" {
		return nil, errors.New("name is required")
	}
	u, err := normaliseObject(k, namespace, name, obj)
	if err != nil {
		return nil, err
	}
	if u.GetResourceVersion() == "" {
		existing, err := s.fetch(ctx, k, namespace, name)
		if err != nil {
			return nil, err
		}
		u.SetResourceVersion(existing.GetResourceVersion())
	}
	var updated *unstructured.Unstructured
	if k.Namespaced {
		updated, err = s.dyn.Resource(k.GVR).Namespace(namespace).Update(ctx, u, metav1.UpdateOptions{})
	} else {
		updated, err = s.dyn.Resource(k.GVR).Update(ctx, u, metav1.UpdateOptions{})
	}
	if err != nil {
		return nil, err
	}
	return k.Project(updated), nil
}

// YAML returns the canonical YAML serialisation of a single object. Server-
// stripped fields (managedFields) are removed so the output is compact and
// safe to display.
func (s *Service) YAML(ctx context.Context, k Kind, namespace, name string) ([]byte, error) {
	o, err := s.fetch(ctx, k, namespace, name)
	if err != nil {
		return nil, err
	}
	stripServerFields(o)
	return yaml.Marshal(o.Object)
}

// Delete removes the object. Foreground propagation so dependents go first.
func (s *Service) Delete(ctx context.Context, k Kind, namespace, name string) error {
	policy := metav1.DeletePropagationForeground
	opts := metav1.DeleteOptions{PropagationPolicy: &policy}
	if k.Namespaced {
		return s.dyn.Resource(k.GVR).Namespace(namespace).Delete(ctx, name, opts)
	}
	return s.dyn.Resource(k.GVR).Delete(ctx, name, opts)
}

func (s *Service) fetch(ctx context.Context, k Kind, namespace, name string) (*unstructured.Unstructured, error) {
	if k.Namespaced {
		return s.dyn.Resource(k.GVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	}
	return s.dyn.Resource(k.GVR).Get(ctx, name, metav1.GetOptions{})
}

func normaliseObject(k Kind, namespace, name string, obj map[string]any) (*unstructured.Unstructured, error) {
	if obj == nil {
		return nil, errors.New("object body is required")
	}
	u := &unstructured.Unstructured{Object: obj}
	meta := u.Object["metadata"]
	if meta == nil {
		meta = map[string]any{}
		u.Object["metadata"] = meta
	}
	metaMap, ok := meta.(map[string]any)
	if !ok {
		return nil, errors.New("metadata must be an object")
	}

	bodyName, _ := metaMap["name"].(string)
	if name == "" {
		if bodyName == "" {
			return nil, errors.New("metadata.name is required")
		}
	} else if bodyName == "" {
		metaMap["name"] = name
	} else if bodyName != name {
		return nil, fmt.Errorf("metadata.name %q does not match URL name %q", bodyName, name)
	}

	if k.Namespaced {
		if namespace == "" {
			return nil, fmt.Errorf("namespace required for %s", k.Slug)
		}
		bodyNS, _ := metaMap["namespace"].(string)
		if bodyNS != "" && bodyNS != namespace {
			return nil, fmt.Errorf("metadata.namespace %q does not match URL namespace %q", bodyNS, namespace)
		}
		metaMap["namespace"] = namespace
	} else {
		delete(metaMap, "namespace")
	}
	return u, nil
}

// stripServerFields removes noisy bookkeeping that's never useful in the UI.
func stripServerFields(o *unstructured.Unstructured) {
	meta, ok, _ := unstructured.NestedMap(o.Object, "metadata")
	if !ok {
		return
	}
	delete(meta, "managedFields")
	delete(meta, "resourceVersion")
	delete(meta, "generation")
	delete(meta, "selfLink")
	_ = unstructured.SetNestedMap(o.Object, meta, "metadata")
}
