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

	PrometheusURL    string
	PrometheusAuth   string // "", "forward", or "bearer"
	PrometheusBearer string

	OpenCodeBin     string
	AgentWorkDir    string
	AgentAPIBaseURL string

	CORSOrigins []string
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
		PrometheusURL:          env("KNAIC_PROMETHEUS_URL", ""),
		PrometheusAuth:         env("KNAIC_PROMETHEUS_AUTH", ""),
		PrometheusBearer:       env("KNAIC_PROMETHEUS_BEARER", ""),
		OpenCodeBin:            env("KNAIC_OPENCODE_BIN", "opencode"),
		AgentWorkDir:           env("KNAIC_AGENT_WORKDIR", ""),
		AgentAPIBaseURL:        env("KNAIC_AGENT_API_BASE", ""),
		CORSOrigins:            splitCSV(env("KNAIC_CORS_ORIGINS", "http://localhost:4300,http://localhost:5173")),
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
