package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Addr             string
	SystemNamespace  string
	KubeconfigPath   string
	ComponentCatalog string
	PublicModelsSeed string

	OIDCIssuer             string
	OIDCClientID           string
	OIDCClientSecret       string
	OIDCRedirectURI        string
	OIDCAdminGroup         string
	OIDCScopes             string
	OIDCUsernameClaim      string
	OIDCUsernamePrefix     string
	OIDCInsecureSkipVerify bool
	AuthDisabled           bool

	RegistryEndpoint string
	RegistryProject  string
	RegistryUseEmbed bool

	DatabaseURL string

	PrometheusURL          string
	PrometheusAuth         string // "", "forward", "bearer", or "basic"
	PrometheusBearer       string
	PrometheusBasicUser    string
	PrometheusBasicPassword string

	OpenCodeBin     string
	AgentWorkDir    string
	AgentAPIBaseURL string
	// OpenCodeServerURL, when set, switches the playground agent runner from
	// the per-turn CLI fork to an HTTP client of `opencode serve` listening
	// at this URL. Typically http://127.0.0.1:4096 with a sidecar container.
	OpenCodeServerURL string
	// OpenCodeConfigPath is where this process writes opencode.json so the
	// sidecar can pick it up at startup. Must be on a volume shared with the
	// sidecar's $HOME/.config/opencode/.
	OpenCodeConfigPath string
	// OpenCodeInternalProxyURL is the OpenAI-compatible URL knaic-api
	// advertises to opencode as the upstream "knaic" provider. Default is
	// derived from Addr (localhost + port + /api/v1/internal/openai/v1).
	OpenCodeInternalProxyURL string

	StaticDir string

	CORSOrigins []string

	// ClusterName and PlatformURL populate the /api/v1/cluster-info payload
	// the frontend header reads. Both are optional — empty values surface as
	// a placeholder in the UI.
	ClusterName string
	PlatformURL string

	// AgentWorkspace* configure the per-user Codex Web pod provisioned for
	// the top-level "Agent Workspace" menu entry. AgentWorkspaceNamespace
	// defaults to SystemNamespace; the rest fall back to safe defaults in
	// the agentworkspace package.
	AgentWorkspaceNamespace        string
	AgentWorkspaceImage            string
	AgentWorkspaceStorage          string
	AgentWorkspaceCPURequest       string
	AgentWorkspaceCPULimit         string
	AgentWorkspaceMemoryRequest    string
	AgentWorkspaceMemoryLimit      string
	AgentWorkspaceStorageClass     string
	AgentWorkspaceImagePullSecrets []string
}

func Load() (*Config, error) {
	c := &Config{
		Addr:                   env("KNAIC_ADDR", ":8080"),
		SystemNamespace:        env("KNAIC_SYSTEM_NAMESPACE", "knaic-system"),
		KubeconfigPath:         env("KUBECONFIG", ""),
		ComponentCatalog:       env("KNAIC_COMPONENT_CATALOG", ""),
		PublicModelsSeed:       env("KNAIC_PUBLIC_MODELS", ""),
		OIDCIssuer:             env("KNAIC_OIDC_ISSUER", ""),
		OIDCClientID:           env("KNAIC_OIDC_CLIENT_ID", "knaic"),
		OIDCClientSecret:       env("KNAIC_OIDC_CLIENT_SECRET", ""),
		OIDCRedirectURI:        env("KNAIC_OIDC_REDIRECT_URI", ""),
		OIDCUsernameClaim:      env("KNAIC_OIDC_USERNAME_CLAIM", "email"),
		OIDCUsernamePrefix:     env("KNAIC_OIDC_USERNAME_PREFIX", ""),
		OIDCAdminGroup:         env("KNAIC_OIDC_ADMIN_GROUP", "knaic:platform-admins"),
		OIDCScopes:             env("KNAIC_OIDC_SCOPES", "openid profile email groups"),
		OIDCInsecureSkipVerify: boolEnv("KNAIC_OIDC_INSECURE_SKIP_VERIFY", true),
		AuthDisabled:           boolEnv("KNAIC_AUTH_DISABLED", false),
		RegistryEndpoint:       env("KNAIC_REGISTRY_ENDPOINT", "registry.knaic.local"),
		RegistryProject:        env("KNAIC_REGISTRY_PROJECT", "components"),
		RegistryUseEmbed:       boolEnv("KNAIC_REGISTRY_USE_EMBED", true),
		DatabaseURL:            env("KNAIC_DB_URL", ""),
		PrometheusURL:           env("KNAIC_PROMETHEUS_URL", ""),
		PrometheusAuth:          env("KNAIC_PROMETHEUS_AUTH", ""),
		PrometheusBearer:        env("KNAIC_PROMETHEUS_BEARER", ""),
		PrometheusBasicUser:     env("KNAIC_PROMETHEUS_BASIC_USER", ""),
		PrometheusBasicPassword: env("KNAIC_PROMETHEUS_BASIC_PASSWORD", ""),
		OpenCodeBin:              env("KNAIC_OPENCODE_BIN", "opencode"),
		AgentWorkDir:             env("KNAIC_AGENT_WORKDIR", ""),
		AgentAPIBaseURL:          env("KNAIC_AGENT_API_BASE", ""),
		OpenCodeServerURL:        env("KNAIC_OPENCODE_URL", ""),
		OpenCodeConfigPath:       env("KNAIC_OPENCODE_CONFIG", ""),
		OpenCodeInternalProxyURL: env("KNAIC_OPENCODE_PROXY_URL", ""),
		StaticDir:              env("KNAIC_STATIC_DIR", ""),
		CORSOrigins:            splitCSV(env("KNAIC_CORS_ORIGINS", "http://localhost:4300,http://localhost:5173")),
		ClusterName:            env("KNAIC_CLUSTER_NAME", ""),
		PlatformURL:            env("KNAIC_PLATFORM_URL", ""),

		AgentWorkspaceNamespace:        env("KNAIC_AGENT_WORKSPACE_NAMESPACE", ""),
		AgentWorkspaceImage:            env("KNAIC_AGENT_WORKSPACE_IMAGE", ""),
		AgentWorkspaceStorage:          env("KNAIC_AGENT_WORKSPACE_STORAGE", ""),
		AgentWorkspaceCPURequest:       env("KNAIC_AGENT_WORKSPACE_CPU_REQUEST", ""),
		AgentWorkspaceCPULimit:         env("KNAIC_AGENT_WORKSPACE_CPU_LIMIT", ""),
		AgentWorkspaceMemoryRequest:    env("KNAIC_AGENT_WORKSPACE_MEM_REQUEST", ""),
		AgentWorkspaceMemoryLimit:      env("KNAIC_AGENT_WORKSPACE_MEM_LIMIT", ""),
		AgentWorkspaceStorageClass:     env("KNAIC_AGENT_WORKSPACE_STORAGE_CLASS", ""),
		AgentWorkspaceImagePullSecrets: splitCSV(env("KNAIC_AGENT_WORKSPACE_IMAGE_PULL_SECRETS", "")),
	}
	if c.AgentWorkspaceNamespace == "" {
		c.AgentWorkspaceNamespace = c.SystemNamespace
	}
	if !c.AuthDisabled && c.OIDCIssuer == "" {
		return nil, fmt.Errorf("KNAIC_OIDC_ISSUER is required unless KNAIC_AUTH_DISABLED=true")
	}
	return c, nil
}

func env(k, def string) string {
	if v, ok := os.LookupEnv(k); ok {
		return v
	}
	return def
}

func boolEnv(k string, def bool) bool {
	v, ok := os.LookupEnv(k)
	if !ok {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	out := strings.Split(s, ",")
	for i, p := range out {
		out[i] = strings.TrimSpace(p)
	}
	return out
}
