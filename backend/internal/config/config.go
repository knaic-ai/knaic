package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Addr            string
	SystemNamespace string
	KubeconfigPath  string

	OIDCIssuer     string
	OIDCClientID   string
	OIDCAdminGroup string
	AuthDisabled   bool

	RegistryEndpoint string
	RegistryProject  string
	RegistryUseEmbed bool

	DatabaseURL string

	PrometheusURL string

	CORSOrigins []string
}

func Load() (*Config, error) {
	c := &Config{
		Addr:             env("KNAIC_ADDR", ":8080"),
		SystemNamespace:  env("KNAIC_SYSTEM_NAMESPACE", "knaic-system"),
		KubeconfigPath:   env("KUBECONFIG", ""),
		OIDCIssuer:       env("KNAIC_OIDC_ISSUER", ""),
		OIDCClientID:     env("KNAIC_OIDC_CLIENT_ID", "knaic"),
		OIDCAdminGroup:   env("KNAIC_OIDC_ADMIN_GROUP", "knaic:platform-admins"),
		AuthDisabled:     boolEnv("KNAIC_AUTH_DISABLED", false),
		RegistryEndpoint: env("KNAIC_REGISTRY_ENDPOINT", "registry.knaic.local"),
		RegistryProject:  env("KNAIC_REGISTRY_PROJECT", "components"),
		RegistryUseEmbed: boolEnv("KNAIC_REGISTRY_USE_EMBED", true),
		DatabaseURL:      env("KNAIC_DB_URL", ""),
		PrometheusURL:    env("KNAIC_PROMETHEUS_URL", ""),
		CORSOrigins:      splitCSV(env("KNAIC_CORS_ORIGINS", "http://localhost:4300,http://localhost:5173")),
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
