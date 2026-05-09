package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/alauda/knaic-backend/internal/admin"
	"github.com/alauda/knaic-backend/internal/api"
	"github.com/alauda/knaic-backend/internal/auth"
	"github.com/alauda/knaic-backend/internal/charts"
	"github.com/alauda/knaic-backend/internal/components"
	"github.com/alauda/knaic-backend/internal/config"
	"github.com/alauda/knaic-backend/internal/gpu"
	"github.com/alauda/knaic-backend/internal/inference"
	"github.com/alauda/knaic-backend/internal/k8s"
	"github.com/alauda/knaic-backend/internal/k8sres"
	"github.com/alauda/knaic-backend/internal/logx"
	"github.com/alauda/knaic-backend/internal/models"
	"github.com/alauda/knaic-backend/internal/monitoring"
	"github.com/alauda/knaic-backend/internal/notebook"
	"github.com/alauda/knaic-backend/internal/playground"
	"github.com/alauda/knaic-backend/internal/registry"
	"github.com/alauda/knaic-backend/internal/training"
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

	var resSvc *k8sres.Service
	var adminSvc *admin.Service
	var infSvc *inference.Service
	var nbSvc *notebook.Service
	var trainSvc *training.Service
	var gpuSvc *gpu.Service
	var gpuProfiles *gpu.ProfileStore
	if clients != nil {
		resSvc = k8sres.NewService(clients.Dynamic, clients.Typed)
		adminSvc = admin.NewService(clients.Typed)
		infSvc = inference.New(clients.Typed, clients.Dynamic, clients.Discovery)
		nbSvc = notebook.New(clients.Dynamic, clients.Typed)
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
	if err := models.Seed(ctx, modelStore, cfg.PublicModelsSeed); err != nil {
		log.Warn("seed builtin models", "err", err)
	}
	var modelAuthorizer models.NamespaceAuthorizer
	if clients != nil {
		modelAuthorizer = k8s.NewAuthorizer(clients, cfg.OIDCUsernameClaim, cfg.OIDCUsernamePrefix, cfg.AuthDisabled)
	}
	modelSvc := models.NewServiceWithAuthorizer(modelStore, modelAuthorizer)
	monitoringSvc := monitoring.NewServiceWithOptions(cfg.PrometheusURL, nil, monitoring.Options{
		AuthMode:     monitoring.AuthMode(cfg.PrometheusAuth),
		StaticBearer: cfg.PrometheusBearer,
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
	playgroundSvc := playground.NewServiceWithAgentStore(
		agentStore,
		playground.NewOpenCodeRunner(playground.OpenCodeOptions{
			Binary:     cfg.OpenCodeBin,
			WorkDir:    cfg.AgentWorkDir,
			APIBaseURL: agentAPIBaseURL,
			MCPCommand: mcpCommand,
		}),
	)

	router := api.NewRouter(api.Deps{
		Verifier:        verifier,
		AuthProxy:       authProxy,
		AuthConfig:      api.AuthConfig{Issuer: cfg.OIDCIssuer, ClientID: cfg.OIDCClientID, Scopes: cfg.OIDCScopes, RedirectURI: cfg.OIDCRedirectURI},
		AuthDisabled:    cfg.AuthDisabled,
		K8s:             clients,
		UserClaim:       cfg.OIDCUsernameClaim,
		UserPrefix:      cfg.OIDCUsernamePrefix,
		Components:      compSvc,
		GPU:             gpuSvc,
		GPUProfiles:     gpuProfiles,
		Registry:        regStore,
		K8sRes:          resSvc,
		Admin:           adminSvc,
		Inference:       infSvc,
		Notebook:        nbSvc,
		Models:          modelSvc,
		Training:        trainSvc,
		Monitoring:      monitoringSvc,
		Playground:      playgroundSvc,
		AgentAPIBaseURL: agentAPIBaseURL,
		CORSOrigins:     cfg.CORSOrigins,
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
