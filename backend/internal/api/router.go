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
	"github.com/alauda/knaic-backend/internal/inference"
	"github.com/alauda/knaic-backend/internal/k8sres"
	"github.com/alauda/knaic-backend/internal/models"
	"github.com/alauda/knaic-backend/internal/monitoring"
	"github.com/alauda/knaic-backend/internal/notebook"
	"github.com/alauda/knaic-backend/internal/playground"
	"github.com/alauda/knaic-backend/internal/registry"
	"github.com/alauda/knaic-backend/internal/training"
)

type Deps struct {
	Verifier    *auth.Verifier
	Components  *components.Service
	Registry    *registry.Store
	K8sRes      *k8sres.Service
	Admin       *admin.Service
	Inference   *inference.Service
	Notebook    *notebook.Service
	Models      *models.Service
	Training    *training.Service
	Monitoring  *monitoring.Service
	Playground  *playground.Service
	CORSOrigins []string
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
		r.Use(d.Verifier.Middleware)

		r.Get("/whoami", func(w http.ResponseWriter, req *http.Request) {
			u := auth.MustFromContext(req.Context())
			if d.Admin != nil {
				d.Admin.ObserveUser(u)
			}
			writeJSON(w, http.StatusOK, u)
		})

		r.Route("/components", func(r chi.Router) {
			// Read paths are open to any authenticated user; mutations
			// require platform-admin.
			cmp := newComponentsAPI(d.Components)
			r.Get("/", cmp.list)
			r.Get("/{name}", cmp.get)
			r.Group(func(r chi.Router) {
				r.Use(auth.RequirePlatformAdmin)
				r.Post("/", cmp.importChart)
				r.Patch("/{name}", cmp.patch)
				r.Delete("/{name}", cmp.remove)
				r.Post("/{name}/install", cmp.install)
				r.Post("/{name}/uninstall", cmp.uninstall)
				r.Post("/{name}/reconcile", cmp.reconcile)
				r.Post("/{name}/adopt", cmp.adopt)
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
			newK8sresAPI(d.K8sRes).routes(r)
		}
		if d.Admin != nil {
			r.Group(func(r chi.Router) {
				r.Use(auth.RequirePlatformAdmin)
				newAdminAPI(d.Admin).routes(r)
			})
		}
		if d.Inference != nil {
			r.Route("/namespaces/{namespace}/inference", func(r chi.Router) {
				newInferenceAPI(d.Inference).routes(r)
			})
		}
		if d.Notebook != nil {
			// Mounted under singular "notebook" so it doesn't shadow the
			// generic /namespaces/{ns}/notebooks list GET handled by the
			// k8sres dispatcher.
			r.Route("/namespaces/{namespace}/notebook", func(r chi.Router) {
				newNotebookAPI(d.Notebook).routes(r)
			})
		}
		if d.Models != nil {
			r.Route("/models", func(r chi.Router) {
				newModelsAPI(d.Models).routes(r)
			})
		}
		if d.Training != nil {
			r.Route("/namespaces/{namespace}/training", func(r chi.Router) {
				newTrainingAPI(d.Training).routes(r)
			})
		}
		if d.Monitoring != nil {
			newMonitoringAPI(d.Monitoring).routes(r)
		}
		if d.Playground != nil {
			newPlaygroundAPI(d.Playground).routes(r)
		}
	})

	return r
}

func originsOrAll(in []string) []string {
	if len(in) == 0 {
		return []string{"*"}
	}
	return in
}
