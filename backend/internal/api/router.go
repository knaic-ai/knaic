package api

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/alauda/knaic-backend/internal/admin"
	"github.com/alauda/knaic-backend/internal/auth"
	"github.com/alauda/knaic-backend/internal/components"
	"github.com/alauda/knaic-backend/internal/gpu"
	"github.com/alauda/knaic-backend/internal/inference"
	"github.com/alauda/knaic-backend/internal/k8s"
	"github.com/alauda/knaic-backend/internal/k8sres"
	"github.com/alauda/knaic-backend/internal/models"
	"github.com/alauda/knaic-backend/internal/monitoring"
	"github.com/alauda/knaic-backend/internal/notebook"
	"github.com/alauda/knaic-backend/internal/playground"
	"github.com/alauda/knaic-backend/internal/registry"
	"github.com/alauda/knaic-backend/internal/training"
)

type Deps struct {
	Verifier        *auth.Verifier
	AuthProxy       *auth.Proxy
	AuthConfig      AuthConfig
	AuthDisabled    bool
	K8s             *k8s.Clients
	UserClaim       string // OIDC claim used as the impersonated apiserver username
	UserPrefix      string // optional prefix prepended to the impersonated username
	Components      *components.Service
	GPU             *gpu.Service
	GPUProfiles     *gpu.ProfileStore
	Registry        *registry.Store
	K8sRes          *k8sres.Service
	Admin           *admin.Service
	Inference       *inference.Service
	Notebook        *notebook.Service
	Models          *models.Service
	Training        *training.Service
	Monitoring      *monitoring.Service
	Playground      *playground.Service
	AgentAPIBaseURL string
	CORSOrigins     []string
}

type AuthConfig struct {
	Issuer      string `json:"issuer"`
	ClientID    string `json:"clientId"`
	Scopes      string `json:"scopes"`
	RedirectURI string `json:"redirectUri,omitempty"`
}

func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()

	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)
	r.Use(chimw.Timeout(60 * time.Second))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   originsOrAll(d.CORSOrigins),
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	r.Get("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
	})

	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/auth/config", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, d.AuthConfig)
		})
		if d.AuthProxy != nil {
			// Browser-originating OIDC calls Dex directly are blocked by CORS;
			// proxy through the API instead so the same TLS config is reused.
			r.Get("/auth/discovery", d.AuthProxy.Discovery)
			r.Post("/auth/token", d.AuthProxy.Token)
		}

		r.Group(func(r chi.Router) {
			r.Use(d.Verifier.Middleware)

			r.Get("/whoami", func(w http.ResponseWriter, req *http.Request) {
				u := auth.MustFromContext(req.Context())
				if d.Admin != nil {
					d.Admin.ObserveUser(u)
				}
				writeJSON(w, http.StatusOK, u)
			})

			// Cluster identity (cluster name + platform URL) for the
			// header bar. Sourced from kube-public/global-info, which is
			// safe for any authenticated user to read.
			if d.K8s != nil {
				r.Get("/cluster-info", newClusterInfoHandler(d.K8s.Typed))
			}

			r.Route("/components", func(r chi.Router) {
				// Read paths are open to any authenticated user; mutations
				// require platform-admin.
				cmp := newComponentsAPI(d.Components)
				r.Get("/", cmp.list)
				// /status takes ?name=foo (query string) so the catalog can be
				// extended with names that don't fit nicely in a path segment.
				r.Get("/status", cmp.status)
				r.Get("/{name}", cmp.get)
				r.Group(func(r chi.Router) {
					r.Use(auth.RequirePlatformAdmin)
					r.Post("/", cmp.importChart)
					r.Patch("/{name}", cmp.patch)
					r.Delete("/{name}", cmp.remove)
					r.Post("/{name}/install", cmp.install)
					r.Post("/{name}/uninstall", cmp.uninstall)
					r.Post("/{name}/reconcile", cmp.reconcile)
				})
			})

			r.Route("/registry", func(r chi.Router) {
				reg := newRegistryAPI(d.Registry)
				r.Get("/", reg.get)
				r.Group(func(r chi.Router) {
					r.Use(auth.RequirePlatformAdmin)
					r.Patch("/", reg.patch)
					r.Post("/sync", reg.sync)
				})
			})

			if d.K8sRes != nil {
				newK8sresAPI(d.K8sRes, newK8sClientSource(d)).routes(r)
			}
			if d.Admin != nil {
				// Lightweight name+status list, used by the namespace selector.
				// Open to any authenticated user; the heavier admin shape lives
				// under /admin/namespaces.
				//
				// Platform admins get the full SA-backed list so the selector
				// matches the rest of the admin views. Other users are listed
				// via apiserver impersonation so K8s RBAC filters the result.
				r.Get("/namespaces", newMyNamespacesHandler(d))
				r.Group(func(r chi.Router) {
					r.Use(auth.RequirePlatformAdmin)
					newAdminAPI(d.Admin).routes(r)
				})
			}
			if d.Inference != nil {
				infAPI := newInferenceAPI(d.Inference, newK8sClientSource(d))
				r.Route("/namespaces/{namespace}/inference", func(r chi.Router) {
					infAPI.routes(r)
				})
				// Cluster-wide endpoints (no {namespace}). Both look at
				// cluster-scoped state — base configs live in the kserve
				// namespace and the deployment-mode list comes from KServe's
				// configmap + Knative discovery.
				r.Get("/inference/llm-configs", infAPI.LLMConfigsHandler)
				r.Get("/inference/deployment-modes", infAPI.DeploymentModesHandler)
			}
			if d.Notebook != nil {
				// Mounted under singular "notebook" so it doesn't shadow the
				// generic /namespaces/{ns}/notebooks list GET handled by the
				// k8sres dispatcher.
				r.Route("/namespaces/{namespace}/notebook", func(r chi.Router) {
					newNotebookAPI(d.Notebook, newK8sClientSource(d)).routes(r)
				})
			}
			if d.Models != nil {
				r.Route("/models", func(r chi.Router) {
					newModelsAPI(d.Models).routes(r)
				})
			}
			if d.Training != nil {
				r.Route("/namespaces/{namespace}/training", func(r chi.Router) {
					newTrainingAPI(d.Training, newK8sClientSource(d)).routes(r)
				})
			}
			if d.Monitoring != nil {
				newMonitoringAPI(d.Monitoring).routes(r)
			}
			if d.GPU != nil {
				gpuAPI := newGPUAPI(newK8sClientSource(d), d.GPU, d.Monitoring, d.GPUProfiles)
				// Status: cluster scope is admin-gated by the handler
				// itself (it picks the SA-backed service for admins and
				// rejects cluster-wide reads from non-admins via the
				// impersonating fallback). Namespace scope is open to any
				// authenticated user with read on pods in that namespace.
				r.Get("/gpu/status", gpuAPI.status)
				// GPU profiles: list is open to any authenticated user
				// (the picker on every workload form reads from here);
				// CRUD is admin-only.
				r.Get("/gpu/profiles", gpuAPI.listProfiles)
				r.Group(func(r chi.Router) {
					r.Use(auth.RequirePlatformAdmin)
					r.Post("/gpu/profiles", gpuAPI.createProfile)
					r.Put("/gpu/profiles/{id}", gpuAPI.updateProfile)
					r.Delete("/gpu/profiles/{id}", gpuAPI.deleteProfile)
					// Per-card DCGM utilisation — cluster-wide metrics, admin only.
					r.Get("/gpu/device-usage", gpuAPI.deviceUsage)
				})
			}
			if d.Playground != nil {
				newPlaygroundAPI(d.Playground, d.AgentAPIBaseURL).routes(r)
			}
		})
	})

	return r
}

func originsOrAll(in []string) []string {
	if len(in) == 0 {
		return []string{"*"}
	}
	return in
}
