package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/knaic/knaic-backend/internal/admin"
	"github.com/knaic/knaic-backend/internal/agentworkspace"
	"github.com/knaic/knaic-backend/internal/auth"
	"github.com/knaic/knaic-backend/internal/collections"
	"github.com/knaic/knaic-backend/internal/components"
	"github.com/knaic/knaic-backend/internal/gpu"
	"github.com/knaic/knaic-backend/internal/inference"
	"github.com/knaic/knaic-backend/internal/k8s"
	"github.com/knaic/knaic-backend/internal/k8sres"
	"github.com/knaic/knaic-backend/internal/models"
	"github.com/knaic/knaic-backend/internal/monitoring"
	"github.com/knaic/knaic-backend/internal/notebook"
	"github.com/knaic/knaic-backend/internal/playground"
	"github.com/knaic/knaic-backend/internal/publish"
	"github.com/knaic/knaic-backend/internal/registry"
	"github.com/knaic/knaic-backend/internal/storage"
	"github.com/knaic/knaic-backend/internal/training"
)

type Deps struct {
	Verifier        *auth.Verifier
	AuthProxy       *auth.Proxy
	AuthConfig      AuthConfig
	AuthDisabled    bool
	// GrantStore mints short-lived auth grants that get carried via
	// HttpOnly cookies. Used by the AI Storage PVC viewer iframe, since
	// `<iframe src=...>` requests can't set an Authorization header.
	// When nil the viewer grant endpoint returns 503 and the proxy
	// requires bearer auth like everything else.
	GrantStore      *auth.GrantStore
	K8s             *k8s.Clients
	UserClaim       string // OIDC claim used as the impersonated apiserver username
	UserPrefix      string // optional prefix prepended to the impersonated username
	Components      *components.Service
	GPU             *gpu.Service
	GPUProfiles     *gpu.ProfileStore
	Registry        *registry.Store
	Storage         *storage.Store
	K8sRes          *k8sres.Service
	Admin           *admin.Service
	AgentWorkspace  *agentworkspace.Service
	Inference       *inference.Service
	Notebook        *notebook.Service
	Models          *models.Service
	Collections     *collections.Service
	Publish         *publish.Service
	Training        *training.Service
	Monitoring      *monitoring.Service
	Playground      *playground.Service
	AgentAPIBaseURL string
	// InternalToken authenticates calls from the opencode sidecar to the
	// /api/v1/internal/openai/v1 proxy. Empty disables the route entirely.
	InternalToken string
	CORSOrigins   []string
	// StaticDir, when non-empty, makes the API binary also serve the React
	// build under /. Populated by the Docker image; empty in the local
	// `make run` workflow (where the frontend lives at vite :4300).
	StaticDir string
	// ClusterInfo is the static cluster identity surfaced at
	// /api/v1/cluster-info. Empty fields render as a placeholder in the UI.
	ClusterInfo ClusterInfo
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
	// chimw.Timeout is intentionally NOT applied globally. It runs the
	// handler in a goroutine and tries to write a 504 once the deadline
	// fires; for SSE streams (playground chat/stream, agent runs) the
	// upstream LLM legitimately holds the response for tens of seconds,
	// the handler has already flushed 200 + body, and the late
	// WriteHeader(504) shows up in the log as "superfluous response.
	// WriteHeader call". Slowloris is covered by Server.ReadHeaderTimeout
	// in main.go; per-handler deadlines should use r.Context() directly.
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
		// Internal proxy for the opencode sidecar. Mounted before the OIDC
		// gate so a bearer-less sidecar can reach it; gated by a per-process
		// shared token instead.
		mountInternalOpenAI(r, d.Playground, d.InternalToken)

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
			// header bar. Values come from KNAIC_CLUSTER_NAME /
			// KNAIC_PLATFORM_URL at process start.
			r.Get("/cluster-info", newClusterInfoHandler(d.ClusterInfo))

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

			if d.Storage != nil {
				r.Route("/storage", func(r chi.Router) {
					newStorageAPI(d.Storage).routes(r)
				})
			}

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
			if d.K8s != nil {
				// AI Storage is namespaced. Wired only when we have a real
				// k8s client bundle; gated per-request via apiserver
				// impersonation (write paths additionally require
				// platform-admin — see internal/api/aistorage.go).
				aiAPI := newAIStorageAPI(newK8sClientSource(d), d.GrantStore)
				r.Route("/namespaces/{namespace}/aistorage", func(r chi.Router) {
					aiAPI.routes(r)
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
				r.Get("/inference/gateway", infAPI.GatewayConfigHandler)
				r.Get("/inference/localmodel/status", infAPI.LocalModelStatusHandler)
				r.Get("/inference/localmodel/options", infAPI.LocalModelOptionsHandler)
			}
			if d.AgentWorkspace != nil {
				// Per-user Codex Web workspace (lifecycle + reverse
				// proxy). Singleton-per-caller; the workspace name is
				// derived from the OIDC identity inside the handler.
				r.Route("/me/workspace", func(r chi.Router) {
					newAgentWorkspaceAPI(d.AgentWorkspace, d.GrantStore).routes(r)
				})
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
					mapi := newModelsAPI(d.Models)
					if d.K8s != nil {
						mapi = mapi.withK8sSource(newK8sClientSource(d))
					}
					mapi.routes(r)
				})
			}
			if d.Collections != nil {
				r.Route("/collections", func(r chi.Router) {
					newCollectionsAPI(d.Collections).routes(r)
				})
			}
			if d.Publish != nil {
				r.Route("/model-publish-requests", func(r chi.Router) {
					newPublishAPI(d.Publish).routes(r)
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

	// Static UI: only mounted when StaticDir points at a real index.html.
	// chi falls through to NotFound for anything that didn't match an API
	// or probe route above; the static handler then serves the React bundle
	// with SPA fallback semantics.
	if h := staticHandler(d.StaticDir); h != nil {
		r.NotFound(h.ServeHTTP)
	}

	return r
}

func originsOrAll(in []string) []string {
	if len(in) == 0 {
		return []string{"*"}
	}
	return in
}
