package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/knaic/knaic-backend/internal/admin"
	"github.com/knaic/knaic-backend/internal/agentworkspace"
	"github.com/knaic/knaic-backend/internal/api"
	"github.com/knaic/knaic-backend/internal/auth"
	"github.com/knaic/knaic-backend/internal/charts"
	"github.com/knaic/knaic-backend/internal/collections"
	"github.com/knaic/knaic-backend/internal/components"
	"github.com/knaic/knaic-backend/internal/config"
	"github.com/knaic/knaic-backend/internal/gpu"
	"github.com/knaic/knaic-backend/internal/inference"
	"github.com/knaic/knaic-backend/internal/k8s"
	"github.com/knaic/knaic-backend/internal/k8sres"
	"github.com/knaic/knaic-backend/internal/logx"
	"github.com/knaic/knaic-backend/internal/models"
	"github.com/knaic/knaic-backend/internal/monitoring"
	"github.com/knaic/knaic-backend/internal/notebook"
	"github.com/knaic/knaic-backend/internal/playground"
	"github.com/knaic/knaic-backend/internal/publish"
	"github.com/knaic/knaic-backend/internal/registry"
	"github.com/knaic/knaic-backend/internal/storage"
	"github.com/knaic/knaic-backend/internal/training"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "agent-mcp" {
		if err := playground.RunMCPServerFromEnv(context.Background(), os.Stdin, os.Stdout); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	log := logx.New()

	cfg, err := config.Load()
	if err != nil {
		log.Error("config load", "err", err)
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	verifier, err := auth.New(
		ctx,
		cfg.OIDCIssuer,
		cfg.OIDCClientID,
		cfg.OIDCAdminGroup,
		cfg.OIDCInsecureSkipVerify,
		cfg.AuthDisabled,
	)
	if err != nil {
		log.Error("oidc init", "err", err)
		os.Exit(1)
	}

	var authProxy *auth.Proxy
	if !cfg.AuthDisabled {
		authProxy, err = auth.NewProxy(ctx, cfg.OIDCIssuer, cfg.OIDCClientID, cfg.OIDCClientSecret, cfg.OIDCInsecureSkipVerify)
		if err != nil {
			log.Warn("oidc proxy init failed; frontend will fall back to direct issuer calls", "err", err)
		}
	}

	clients, err := k8s.New(cfg.KubeconfigPath)
	if err != nil {
		// Fail-soft so the binary still serves /healthz when no cluster is
		// reachable (e.g. during local frontend development).
		log.Warn("k8s client init failed; running without cluster access", "err", err)
	}

	// Grant store for in-browser embeds (AI Storage PVC viewer iframe)
	// that can't carry an Authorization header. The secret is regenerated
	// per process — short-lived grants don't need to survive restarts.
	grantStore, err := auth.NewGrantStore()
	if err != nil {
		log.Error("grant store init", "err", err)
		os.Exit(1)
	}
	verifier.SetGrantStore(grantStore)

	// Attach a CRB-backed admin resolver to the verifier once we have an
	// apiserver client. A user is a platform admin if EITHER:
	//   - their groups claim contains KNAIC_OIDC_ADMIN_GROUP (fast path), or
	//   - any ClusterRoleBinding to `cluster-admin` names them (User subject)
	//     or one of their groups (Group subject).
	if !cfg.AuthDisabled && clients != nil && clients.Typed != nil {
		usernameFn := func(u *auth.User) string {
			return k8s.UsernameFromUser(u, cfg.OIDCUsernameClaim, cfg.OIDCUsernamePrefix)
		}
		verifier.SetAdminResolver(auth.NewAdminResolver(
			clients.Typed,
			[]string{"cluster-admin"},
			usernameFn,
		))
	}

	store, err := components.NewStore(cfg.SystemNamespace, cfg.ComponentCatalog)
	if err != nil {
		log.Error("component catalog load", "err", err)
		os.Exit(1)
	}

	var helmClient components.HelmClient
	var detector *components.Detector
	if clients != nil {
		helmClient = components.NewHelmClient(clients.RESTGetter, charts.Load, log)
		detector = components.NewDetector(helmClient, clients.Typed, clients.Dynamic)
		if err := components.EnsureNamespace(ctx, clients.Typed, cfg.SystemNamespace); err != nil {
			log.Warn("ensure system namespace", "err", err)
		}
	} else {
		helmClient = noopHelm{}
		detector = components.NewDetector(helmClient, nil, nil)
	}

	compSvc := components.NewService(store, helmClient, detector, log)

	regStore := registry.New(cfg.RegistryEndpoint, cfg.RegistryProject, cfg.RegistryUseEmbed)
	storageStore := storage.New(cfg.RegistryEndpoint)

	var resSvc *k8sres.Service
	var adminSvc *admin.Service
	var infSvc *inference.Service
	var nbSvc *notebook.Service
	var agentSvc *agentworkspace.Service
	var trainSvc *training.Service
	var gpuSvc *gpu.Service
	var gpuProfiles *gpu.ProfileStore
	if clients != nil {
		resSvc = k8sres.NewService(clients.Dynamic, clients.Typed)
		adminSvc = admin.NewService(clients.Typed)
		infSvc = inference.New(clients.Typed, clients.Dynamic, clients.Discovery)
		nbSvc = notebook.New(clients.Dynamic, clients.Typed)
		// Agent workspace uses the backend SA client (not impersonation): any
		// authenticated user can provision their own Codex Web pod without
		// needing per-namespace Deployment-create RBAC.
		agentSvc = agentworkspace.New(clients.Typed, agentworkspace.Options{
			Namespace:        cfg.AgentWorkspaceNamespace,
			Image:            cfg.AgentWorkspaceImage,
			Storage:          cfg.AgentWorkspaceStorage,
			CPURequest:       cfg.AgentWorkspaceCPURequest,
			CPULimit:         cfg.AgentWorkspaceCPULimit,
			MemoryRequest:    cfg.AgentWorkspaceMemoryRequest,
			MemoryLimit:      cfg.AgentWorkspaceMemoryLimit,
			StorageClass:     cfg.AgentWorkspaceStorageClass,
			ImagePullSecrets: cfg.AgentWorkspaceImagePullSecrets,
		})
		trainSvc = training.New(clients.Dynamic, training.NewREST())
		gpuSvc = gpu.New(clients.Typed)
		gpuProfiles = gpu.NewProfileStore(clients.Typed, cfg.SystemNamespace)
	}
	if adminSvc == nil {
		adminSvc = admin.NewService(nil)
	}

	// Models: Postgres if KNAIC_DB_URL is set, otherwise in-memory.
	var modelStore models.Store
	if cfg.DatabaseURL != "" {
		pg, err := models.NewPostgresStore(ctx, cfg.DatabaseURL)
		if err != nil {
			log.Error("postgres init", "err", err)
			os.Exit(1)
		}
		defer pg.Close()
		modelStore = pg
		log.Info("model hub: postgres backend", "dsn", redactDSN(cfg.DatabaseURL))
	} else {
		modelStore = models.NewMemoryStore()
		log.Warn("model hub: in-memory backend (data resets on restart). Set KNAIC_DB_URL for persistence.")
	}
	// Collections: same backend selection as models. The seeder hook below
	// upserts any collections referenced by the public models seed file
	// before the models themselves are inserted, so foreign-key-style links
	// resolve on first boot.
	var collectionStore collections.Store
	if cfg.DatabaseURL != "" {
		pgCol, err := collections.NewPostgresStore(ctx, cfg.DatabaseURL)
		if err != nil {
			log.Error("collections postgres init", "err", err)
			os.Exit(1)
		}
		defer pgCol.Close()
		collectionStore = pgCol
	} else {
		collectionStore = collections.NewMemoryStore()
	}
	var modelAuthorizer models.NamespaceAuthorizer
	if clients != nil {
		modelAuthorizer = k8s.NewAuthorizer(clients, cfg.OIDCUsernameClaim, cfg.OIDCUsernamePrefix, cfg.AuthDisabled)
	}
	collectionSvc := collections.NewServiceWithAuthorizer(collectionStore, collectionsAuthorizerAdapter{modelAuthorizer})
	seedCollection := func(ctx context.Context, c models.SeedCollection) error {
		return collectionSvc.SeedPublic(ctx, collections.Collection{
			ID:          c.ID,
			Name:        c.Name,
			Description: c.Description,
			IconColor:   c.IconColor,
		})
	}
	if err := models.Seed(ctx, modelStore, cfg.PublicModelsSeed, seedCollection); err != nil {
		log.Warn("seed builtin models", "err", err)
	}
	modelSvc := models.NewServiceWithAuthorizer(modelStore, modelAuthorizer)

	// Publish requests: separate Postgres table when KNAIC_DB_URL is set.
	var publishStore publish.Store
	if cfg.DatabaseURL != "" {
		pgPub, err := publish.NewPostgresStore(ctx, cfg.DatabaseURL)
		if err != nil {
			log.Error("publish requests postgres init", "err", err)
			os.Exit(1)
		}
		defer pgPub.Close()
		publishStore = pgPub
	} else {
		publishStore = publish.NewMemoryStore()
	}
	publishSvc := publish.NewService(publishStore, modelGatewayAdapter{svc: modelSvc}, modelAuthorizer)
	monitoringSvc := monitoring.NewServiceWithOptions(cfg.PrometheusURL, nil, monitoring.Options{
		AuthMode:      monitoring.AuthMode(cfg.PrometheusAuth),
		StaticBearer:  cfg.PrometheusBearer,
		BasicUser:     cfg.PrometheusBasicUser,
		BasicPassword: cfg.PrometheusBasicPassword,
	})

	var agentStore playground.AgentStore
	if cfg.DatabaseURL != "" {
		pgAgent, err := playground.NewPostgresAgentStore(ctx, cfg.DatabaseURL)
		if err != nil {
			log.Error("agent postgres init", "err", err)
			os.Exit(1)
		}
		defer pgAgent.Close()
		agentStore = pgAgent
		log.Info("playground agent: postgres backend", "dsn", redactDSN(cfg.DatabaseURL))
	} else {
		agentStore = playground.NewMemoryAgentStore()
		log.Warn("playground agent: in-memory session backend (data resets on restart). Set KNAIC_DB_URL for persistence.")
	}
	mcpCommand := []string{os.Args[0], "agent-mcp"}
	if exe, err := os.Executable(); err == nil {
		mcpCommand = []string{exe, "agent-mcp"}
	}
	agentAPIBaseURL := resolveAgentAPIBaseURL(cfg)

	// The opencode sidecar — when configured — needs a shared bearer to
	// reach the localhost /api/v1/internal/openai/v1 proxy. Generate a
	// fresh one per process so leaking a token across reboots is
	// impossible.
	internalToken, err := newInternalToken()
	if err != nil {
		log.Error("internal token", "err", err)
		os.Exit(1)
	}

	var runner playground.AgentRunner
	var serverRunner *playground.OpenCodeServerRunner
	if cfg.OpenCodeServerURL != "" {
		proxyURL := cfg.OpenCodeInternalProxyURL
		if proxyURL == "" {
			proxyURL = defaultInternalProxyURL(cfg.Addr)
		}
		serverRunner = playground.NewOpenCodeServerRunner(playground.OpenCodeServerOptions{
			URL:           cfg.OpenCodeServerURL,
			ConfigPath:    cfg.OpenCodeConfigPath,
			ProxyURL:      proxyURL,
			InternalToken: internalToken,
		})
		runner = serverRunner
		log.Info("playground agent: opencode HTTP runner", "url", cfg.OpenCodeServerURL, "config", cfg.OpenCodeConfigPath, "proxy", proxyURL)
	} else {
		runner = playground.NewOpenCodeRunner(playground.OpenCodeOptions{
			Binary:     cfg.OpenCodeBin,
			WorkDir:    cfg.AgentWorkDir,
			APIBaseURL: agentAPIBaseURL,
			MCPCommand: mcpCommand,
		})
		log.Info("playground agent: opencode CLI runner", "binary", cfg.OpenCodeBin)
	}

	playgroundSvc := playground.NewServiceWithAgentStore(agentStore, runner)

	if serverRunner != nil {
		// The server runner needs access to the provider snapshot for config
		// generation, and to the session store so it can persist the opencode
		// session id after first contact. Wire those now that both halves
		// exist.
		serverRunner.AttachService(playgroundSvc, agentStore)
		playgroundSvc.SetProvidersChangedHook(func() {
			// Fire-and-forget: provider mutations are user-driven so we don't
			// want to block the HTTP response on a sidecar bounce. Errors
			// are surfaced through the log.
			go func() {
				if err := serverRunner.EnsureConfig(); err != nil {
					log.Warn("opencode config refresh failed", "err", err)
				}
			}()
		})
		if err := serverRunner.EnsureConfig(); err != nil {
			log.Warn("opencode initial config write failed", "err", err)
		}
	}

	router := api.NewRouter(api.Deps{
		Verifier:        verifier,
		AuthProxy:       authProxy,
		AuthConfig:      api.AuthConfig{Issuer: cfg.OIDCIssuer, ClientID: cfg.OIDCClientID, Scopes: cfg.OIDCScopes, RedirectURI: cfg.OIDCRedirectURI},
		AuthDisabled:    cfg.AuthDisabled,
		GrantStore:      grantStore,
		K8s:             clients,
		UserClaim:       cfg.OIDCUsernameClaim,
		UserPrefix:      cfg.OIDCUsernamePrefix,
		Components:      compSvc,
		GPU:             gpuSvc,
		GPUProfiles:     gpuProfiles,
		Registry:        regStore,
		Storage:         storageStore,
		K8sRes:          resSvc,
		Admin:           adminSvc,
		AgentWorkspace:  agentSvc,
		Inference:       infSvc,
		Notebook:        nbSvc,
		Models:          modelSvc,
		Collections:     collectionSvc,
		Publish:         publishSvc,
		Training:        trainSvc,
		Monitoring:      monitoringSvc,
		Playground:      playgroundSvc,
		AgentAPIBaseURL: agentAPIBaseURL,
		InternalToken:   internalToken,
		StaticDir:       cfg.StaticDir,
		CORSOrigins:     cfg.CORSOrigins,
		ClusterInfo: api.ClusterInfo{
			ClusterName: cfg.ClusterName,
			PlatformURL: cfg.PlatformURL,
		},
	})

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Info("knaic-api listening", "addr", cfg.Addr, "auth_disabled", cfg.AuthDisabled, "system_ns", cfg.SystemNamespace)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server error", "err", err)
			cancel()
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("shutdown", "err", err)
	}
}

// newInternalToken returns a fresh per-process bearer used to gate the
// /api/v1/internal/openai/v1 proxy. Regenerated on every restart so a leak
// across pods can't be reused.
func newInternalToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// defaultInternalProxyURL builds the URL knaic-api advertises to the opencode
// sidecar from the same listen address the API binds. The sidecar shares the
// pod's network namespace, so 127.0.0.1 + the configured port is enough; we
// just have to stitch the path on the end.
func defaultInternalProxyURL(addr string) string {
	addr = strings.TrimSpace(addr)
	host, port := "127.0.0.1", "8080"
	if addr != "" {
		h, p, err := net.SplitHostPort(addr)
		if err == nil {
			if p != "" {
				port = p
			}
			if h != "" && h != "0.0.0.0" && h != "::" {
				host = h
			}
		} else if strings.HasPrefix(addr, ":") {
			port = strings.TrimPrefix(addr, ":")
		}
	}
	return "http://" + net.JoinHostPort(host, port) + "/api/v1/internal/openai/v1"
}

// collectionsAuthorizerAdapter bridges models.NamespaceAuthorizer (which
// the models package exposes) into the slightly different interface name
// collections expects. The implementation is identical — both gate
// writes by namespace membership via the apiserver SubjectAccessReview.
type collectionsAuthorizerAdapter struct {
	inner models.NamespaceAuthorizer
}

func (a collectionsAuthorizerAdapter) CanWritePrivateModel(ctx context.Context, u *auth.User, namespace string) (bool, error) {
	if a.inner == nil {
		return false, nil
	}
	return a.inner.CanWritePrivateModel(ctx, u, namespace)
}

// modelGatewayAdapter satisfies publish.ModelGateway by translating its
// snapshot/copy types into the same shapes exposed by *models.Service.
// Lives in main so the two packages can stay independent.
type modelGatewayAdapter struct {
	svc *models.Service
}

func (a modelGatewayAdapter) GetPrivateForPublish(ctx context.Context, u *auth.User, id string) (publish.ModelSnapshot, error) {
	snap, err := a.svc.GetPrivateForPublish(ctx, u, id)
	if err != nil {
		return publish.ModelSnapshot{}, err
	}
	return publish.ModelSnapshot{
		ID:        snap.ID,
		Name:      snap.Name,
		Owner:     snap.Owner,
		Namespace: snap.Namespace,
		URI:       snap.URI,
		ModelType: snap.ModelType,
		SizeGB:    snap.SizeGB,
		Tags:      snap.Tags,
		Readme:    snap.Readme,
		SourceURL: snap.SourceURL,
	}, nil
}

func (a modelGatewayAdapter) CreatePublicFromRequest(ctx context.Context, u *auth.User, req publish.PublishCopyRequest) (string, error) {
	return a.svc.CreatePublicFromRequest(ctx, u, models.PublishCopy{
		Name:         req.Name,
		Owner:        req.Owner,
		URI:          req.URI,
		Tags:         req.Tags,
		ModelType:    req.ModelType,
		SizeGB:       req.SizeGB,
		Readme:       req.Readme,
		CollectionID: req.CollectionID,
		SourceURL:    req.SourceURL,
	})
}

func resolveAgentAPIBaseURL(cfg *config.Config) string {
	if base := strings.TrimSpace(cfg.AgentAPIBaseURL); base != "" {
		return strings.TrimRight(base, "/")
	}
	addr := strings.TrimSpace(cfg.Addr)
	if addr == "" {
		return ""
	}
	if strings.HasPrefix(addr, "http://") || strings.HasPrefix(addr, "https://") {
		return strings.TrimRight(addr, "/")
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		if strings.HasPrefix(addr, ":") {
			return "http://127.0.0.1" + addr
		}
		return "http://" + strings.TrimRight(addr, "/")
	}
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}
