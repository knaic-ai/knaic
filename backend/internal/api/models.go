package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/knaic/knaic-backend/internal/auth"
	"github.com/knaic/knaic-backend/internal/models"
)

type modelsAPI struct {
	svc    *models.Service
	source *k8sClientSource
}

func newModelsAPI(svc *models.Service) *modelsAPI {
	return &modelsAPI{svc: svc}
}

// withK8sSource attaches an impersonating client source so the /inference-services
// sub-handler can list InferenceService / LLMInferenceService CRs in the user's
// namespace.
func (a *modelsAPI) withK8sSource(src k8sClientSource) *modelsAPI {
	a.source = &src
	return a
}

func (a *modelsAPI) routes(r chi.Router) {
	r.Get("/", a.list)
	r.Post("/", a.create)
	r.Post("/import", a.importURL)
	r.Post("/upload", a.upload)
	r.Get("/{id}", a.get)
	r.Patch("/{id}", a.patch)
	r.Delete("/{id}", a.delete)
	r.Get("/{id}/tree", a.tree)
	r.Get("/{id}/inference-services", a.inferenceServices)
}

func (a *modelsAPI) list(w http.ResponseWriter, r *http.Request) {
	scope := models.Scope(r.URL.Query().Get("scope"))
	if scope == "" {
		scope = models.ScopePublic
	}
	ns := r.URL.Query().Get("namespace")
	items, err := a.svc.List(r.Context(), scope, ns)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *modelsAPI) get(w http.ResponseWriter, r *http.Request) {
	m, err := a.svc.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeModelsError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (a *modelsAPI) create(w http.ResponseWriter, r *http.Request) {
	var req models.CreateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	u := auth.MustFromContext(r.Context())
	m, err := a.svc.Create(r.Context(), u, req)
	if err != nil {
		writeModelsError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (a *modelsAPI) importURL(w http.ResponseWriter, r *http.Request) {
	var req models.ImportRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	u := auth.MustFromContext(r.Context())
	m, err := a.svc.Import(r.Context(), u, req)
	if err != nil {
		writeModelsError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (a *modelsAPI) upload(w http.ResponseWriter, r *http.Request) {
	var req models.UploadRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	u := auth.MustFromContext(r.Context())
	m, err := a.svc.Upload(r.Context(), u, req)
	if err != nil {
		writeModelsError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (a *modelsAPI) patch(w http.ResponseWriter, r *http.Request) {
	var req models.PatchRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	u := auth.MustFromContext(r.Context())
	m, err := a.svc.Patch(r.Context(), u, chi.URLParam(r, "id"), req)
	if err != nil {
		writeModelsError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (a *modelsAPI) delete(w http.ResponseWriter, r *http.Request) {
	u := auth.MustFromContext(r.Context())
	if err := a.svc.Delete(r.Context(), u, chi.URLParam(r, "id")); err != nil {
		writeModelsError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// TreeNode is the shape returned by GET /models/{id}/tree.
type modelTreeNode struct {
	Parent   *models.Model           `json:"parent,omitempty"`
	Self     models.Model            `json:"self"`
	Children map[string][]models.Model `json:"children"`
}

func (a *modelsAPI) tree(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	self, err := a.svc.Get(r.Context(), id)
	if err != nil {
		writeModelsError(w, err)
		return
	}
	var parent *models.Model
	if self.ParentModelID != "" {
		p, err := a.svc.Get(r.Context(), self.ParentModelID)
		if err == nil {
			parent = &p
		}
	}
	// List the same scope/namespace as self so derived models are found
	// without leaking other namespaces' private models.
	siblings, err := a.svc.List(r.Context(), self.Scope, self.Namespace)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
		return
	}
	children := map[string][]models.Model{
		string(models.DerivedFinetune):     {},
		string(models.DerivedQuantization): {},
		string(models.DerivedAdapter):      {},
	}
	for _, m := range siblings {
		if m.ParentModelID != self.ID {
			continue
		}
		key := string(m.DerivedKind)
		if key == "" {
			continue
		}
		children[key] = append(children[key], m)
	}
	writeJSON(w, http.StatusOK, modelTreeNode{Parent: parent, Self: self, Children: children})
}

// inferenceServiceRef is the minimal projection returned by
// GET /models/{id}/inference-services.
type inferenceServiceRef struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	ModelURI  string `json:"modelUri"`
	Ready     string `json:"ready,omitempty"`
}

var (
	isGVR  = schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1beta1", Resource: "inferenceservices"}
	llmGVR = schema.GroupVersionResource{Group: "serving.kserve.io", Version: "v1alpha2", Resource: "llminferenceservices"}
)

func (a *modelsAPI) inferenceServices(w http.ResponseWriter, r *http.Request) {
	if a.source == nil {
		writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "k8s client not configured"})
		return
	}
	m, err := a.svc.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeModelsError(w, err)
		return
	}
	namespace := r.URL.Query().Get("namespace")
	if namespace == "" && m.Scope == models.ScopePrivate {
		namespace = m.Namespace
	}
	if namespace == "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "namespace query parameter is required for public models"})
		return
	}
	uc, err := a.source.clientsForRequest(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	out := []inferenceServiceRef{}
	if list, err := uc.Dynamic.Resource(isGVR).Namespace(namespace).List(r.Context(), metav1.ListOptions{}); err == nil {
		for i := range list.Items {
			obj := &list.Items[i]
			uri, _, _ := unstructured.NestedString(obj.Object, "spec", "predictor", "model", "storageUri")
			if !matchModelURI(uri, m.URI, m.Name) {
				continue
			}
			out = append(out, inferenceServiceRef{
				Namespace: obj.GetNamespace(),
				Name:      obj.GetName(),
				Kind:      "InferenceService",
				ModelURI:  uri,
				Ready:     conditionStatus(obj, "Ready"),
			})
		}
	}
	if list, err := uc.Dynamic.Resource(llmGVR).Namespace(namespace).List(r.Context(), metav1.ListOptions{}); err == nil {
		for i := range list.Items {
			obj := &list.Items[i]
			uri, _, _ := unstructured.NestedString(obj.Object, "spec", "model", "uri")
			if uri == "" {
				uri, _, _ = unstructured.NestedString(obj.Object, "spec", "model", "storageUri")
			}
			if !matchModelURI(uri, m.URI, m.Name) {
				continue
			}
			out = append(out, inferenceServiceRef{
				Namespace: obj.GetNamespace(),
				Name:      obj.GetName(),
				Kind:      "LLMInferenceService",
				ModelURI:  uri,
				Ready:     conditionStatus(obj, "Ready"),
			})
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// matchModelURI reports whether the inference-service's modelUri references
// the given model. Direct URI match catches the common cases; the name-suffix
// fallback handles "hf://owner/name" matching when one side carries hf-mirror
// and the other hf.
func matchModelURI(serviceURI, modelURI, modelName string) bool {
	if serviceURI == "" {
		return false
	}
	if serviceURI == modelURI {
		return true
	}
	stripScheme := func(u string) string {
		i := strings.Index(u, "://")
		if i < 0 {
			return u
		}
		return u[i+3:]
	}
	if stripScheme(serviceURI) == stripScheme(modelURI) {
		return true
	}
	if modelName != "" && strings.HasSuffix(stripScheme(serviceURI), modelName) {
		return true
	}
	return false
}

func conditionStatus(obj *unstructured.Unstructured, condType string) string {
	conds, found, _ := unstructured.NestedSlice(obj.Object, "status", "conditions")
	if !found {
		return ""
	}
	for _, c := range conds {
		cm, ok := c.(map[string]any)
		if !ok {
			continue
		}
		if t, _ := cm["type"].(string); t == condType {
			s, _ := cm["status"].(string)
			return s
		}
	}
	return ""
}

func writeModelsError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, models.ErrNotFound):
		writeJSON(w, http.StatusNotFound, apiError{Error: err.Error()})
	case errors.Is(err, models.ErrConflict):
		writeJSON(w, http.StatusConflict, apiError{Error: err.Error()})
	case errors.Is(err, models.ErrForbidden):
		writeJSON(w, http.StatusForbidden, apiError{Error: err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
	}
}
