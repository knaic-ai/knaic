# knaic-backend

Go HTTP API for the **knaic** (Kubernetes Native AI Console). This is the
production backend that the React app in `../knaic/` talks to.

## Status

This is the first vertical slice. Implemented:

| Feature | Status |
|---|---|
| Server scaffold (chi, slog, graceful shutdown, CORS) | ✅ |
| OIDC bearer-token middleware (Dex-compatible) + dev bypass | ✅ |
| K8s client factory (in-cluster + kubeconfig) | ✅ |
| **Components**: list, install, uninstall, reconcile, adopt, import, remove | ✅ |
| Built-in component catalog (11 charts) + embedded Helm charts | ✅ stub chart for `kserve`; remaining 10 are catalog-only until vendored |
| Unmanaged detection (Helm release scan + OLM CSV scan + Deployment scan) | ✅ |
| Image registry: config + sync trigger | ✅ |
| Model Hub metadata | ✅ in-memory or Postgres via `KNAIC_DB_URL` |
| Generic Kubernetes resources | ✅ list/get/create/update/yaml/delete + pod log streaming |
| Inference services / serving runtimes | ✅ structured create + generic read/update/delete |
| Training runtimes / TrainJobs / MLflow metrics | ✅ structured create + MLflow proxy |
| Notebooks | ✅ create/start/stop + optional PVC creation |
| Admin: nodes, namespaces, quotas, RBAC, observed users | ✅ |
| Monitoring | ✅ Prometheus `query_range` proxy + bundled `llm` / `training` endpoints with dev synthetic fallback |
| Storage targets (Model Hub picker) | ✅ in-memory store + CRUD + builtin protection |
| Playground | ✅ LLM provider registry + OpenAI-compatible chat/stream proxy + opencode-backed read-only agent |
| Frontend wired to API | ✅ first slices wired; some new admin/monitoring/playground APIs are backend-ready |

Remaining backend-heavy work: real chart vendoring for the remaining built-in
components, namespace-admin SubjectAccessReview gates for namespace-scoped
admin operations, and production persistence for the observed-user registry.

## Layout

```
cmd/knaic-api/        # main.go + noop helm fallback
internal/
  admin/              # nodes, namespaces, ResourceQuotas, RBAC, observed users
  api/                # chi routes
  auth/               # OIDC verifier + middleware + ctx user
  charts/             # embed.FS of built-in Helm charts
  charts/data/<name>/ # one directory per chart (Helm v3 layout)
  components/         # types, store, helm, detection, service
  config/             # env-based Config loader
  k8sres/             # generic Kubernetes resource CRUD + projections
  k8s/                # rest.Config + typed/dynamic/discovery clients
  logx/               # slog wrapper
  monitoring/         # Prometheus query_range proxy
  playground/         # LLM provider registry, chat proxy, agent sessions/tools
  registry/           # built-in image registry config store
build/sync-images.sh  # skopeo-based mirror job
```

## Run locally

The backend can be started **without** a Kubernetes cluster — the components
list is served from the built-in catalog and install actions return an
explicit "no cluster reachable" error.

```bash
# dev: no auth, no cluster
make run

# real cluster, OIDC enabled
export KNAIC_OIDC_ISSUER=https://dex.example.com
export KNAIC_OIDC_CLIENT_ID=knaic
export KNAIC_OIDC_ADMIN_GROUP=knaic:platform-admins
export KUBECONFIG=$HOME/.kube/config
make build && ./bin/knaic-api
```

OIDC issuer discovery and JWKS fetch skip TLS verification by default. Set
`KNAIC_OIDC_INSECURE_SKIP_VERIFY=false` to require normal certificate
validation.

### Apiserver impersonation

User-facing Kubernetes requests are sent to the apiserver with impersonation
headers derived from the verified OIDC user. This makes Kubernetes RBAC
enforce list/get/yaml/log and create/update/delete calls for generic
resources, notebooks, inference resources, and training resources. When
`KNAIC_AUTH_DISABLED=true`, this is bypassed and the existing backend
kubeconfig / ServiceAccount is used for local development.

Bind a ClusterRole like the following to the backend's ServiceAccount:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: knaic-impersonator
rules:
  - apiGroups: [""]
    resources: ["users", "groups", "serviceaccounts"]
    verbs: ["impersonate"]
```

Make sure your `KNAIC_OIDC_USERNAME_CLAIM` and `KNAIC_OIDC_USERNAME_PREFIX`
match the apiserver flags (`--oidc-username-claim`, `--oidc-username-prefix`)
so the impersonated subject matches the names in `RoleBinding.subjects[].name`.

Private Model Hub writes are not direct Kubernetes API calls, so the backend
uses `SubjectAccessReview` instead. A non-admin user must be allowed to
`create` `configmaps` in the target namespace to create/import/upload/patch
private models in that namespace.

### Monitoring backends

The Monitoring service hits a single endpoint — `GET ${KNAIC_PROMETHEUS_URL}/api/v1/query_range` — and decodes the standard Prometheus matrix response. Anything wire-compatible with that endpoint works as a drop-in:

| Backend | `KNAIC_PROMETHEUS_URL` example |
|---|---|
| Prometheus | `http://prometheus.monitoring.svc.cluster.local:9090` |
| Thanos Querier | `http://thanos-query.monitoring.svc.cluster.local:9090` |
| VictoriaMetrics single-node (`victoria-metrics`) | `http://victoria-metrics.victoria-metrics.svc.cluster.local:8428` |
| VictoriaMetrics cluster (`vmselect`) | `http://vmselect.victoria-metrics.svc.cluster.local:8481/select/0/prometheus` |
| VictoriaMetrics with vmauth in front | `http://vmauth.victoria-metrics.svc.cluster.local:8427` |

For the VictoriaMetrics cluster path, note the trailing **`/select/<accountID>/prometheus`** — `vmselect`'s Prometheus-API surface is mounted under that prefix, and accountID is `0` unless you've explicitly partitioned tenants.

knaic only emits PromQL via `/api/v1/query_range`, so VM-specific extensions (MetricsQL operators, subquery shortcuts, `WITH` templates, etc.) aren't required — but they will work since VM accepts MetricsQL on the same endpoint.

If `KNAIC_PROMETHEUS_URL` is left empty the backend serves a deterministic synthetic series, useful for local UI development without a metrics stack.

#### Authenticating to the upstream

By default knaic sends queries unauthenticated, which works when the upstream is reachable in-cluster without a gate. When the upstream is fronted by an `oauth2-proxy` sidecar — a common deployment pattern for VictoriaMetrics — set:

| Env var | Default | Notes |
|---|---|---|
| `KNAIC_PROMETHEUS_AUTH` | _(empty)_ | `forward` to forward the verified Dex bearer of the calling user; `bearer` to send a fixed token; empty for no header. |
| `KNAIC_PROMETHEUS_BEARER` | _(empty)_ | Static bearer token. Used when `KNAIC_PROMETHEUS_AUTH=bearer`, or as a fallback when `forward` mode encounters a request with no caller token (background jobs etc.). |

**Production with a shared OIDC provider.** When both knaic and the VictoriaMetrics oauth2-proxy verify JWTs minted by the same OIDC issuer, configure oauth2-proxy with `--skip-jwt-bearer-tokens=true` (and the right `--oidc-issuer-url`) so it accepts an `Authorization: Bearer <jwt>` header instead of forcing a browser cookie flow. Then on the knaic side:

```bash
KNAIC_PROMETHEUS_URL=http://vmselect.monitoring.svc.cluster.local:8481/select/multitenant/prometheus
KNAIC_PROMETHEUS_AUTH=forward
```

Each `/api/v1/monitoring/query` request now reaches vmselect with the calling user's verified JWT, so VM tenant ACLs and the user's group claims drive what they can read — exactly like every other read knaic forwards to the apiserver via impersonation.

If you also want background / unauthenticated calls (none today, but e.g. a future warm-up job) to still authenticate, fill `KNAIC_PROMETHEUS_BEARER` with a long-lived service-account token.

### Configuration

| Env var | Default | Notes |
|---|---|---|
| `KNAIC_ADDR` | `:8080` | listen address |
| `KNAIC_SYSTEM_NAMESPACE` | `knaic-system` | install ns for built-in components |
| `KNAIC_COMPONENT_CATALOG` | _(embedded `catalog.yaml`)_ | path to a YAML file overriding the built-in component catalog |
| `KNAIC_PUBLIC_MODELS` | _(embedded `models.yaml`)_ | path to a YAML file overriding the public-scope Model Hub seed list. Only seeds when the public scope is empty. |
| `KUBECONFIG` | _(in-cluster)_ | path to kubeconfig |
| `KNAIC_OIDC_ISSUER` | _(required unless disabled)_ | Dex / OIDC issuer URL |
| `KNAIC_OIDC_CLIENT_ID` | `knaic` | OIDC client ID |
| `KNAIC_OIDC_CLIENT_SECRET` | _(empty)_ | injected on token-exchange and refresh by the `/api/v1/auth/token` proxy; set when the upstream client is confidential. Empty keeps the public-PKCE flow. |
| `KNAIC_OIDC_REDIRECT_URI` | _(empty → `${origin}/auth/callback`)_ | absolute redirect URI registered with the IdP. Set when the frontend is served behind a different external host than the browser's `window.location.origin`. Must exactly match the value registered in Dex. |
| `KNAIC_OIDC_ADMIN_GROUP` | `knaic:platform-admins` | group claim that grants platform-admin |
| `KNAIC_OIDC_SCOPES` | `openid profile email groups` | scopes requested by the frontend PKCE login |
| `KNAIC_OIDC_USERNAME_CLAIM` | `email` | OIDC claim used as the apiserver username when impersonating non-admin callers (`sub`, `email`, or `name`). Match your apiserver's `--oidc-username-claim`. |
| `KNAIC_OIDC_USERNAME_PREFIX` | _(empty)_ | optional prefix prepended to the impersonated username. Match your apiserver's `--oidc-username-prefix`. |
| `KNAIC_OIDC_INSECURE_SKIP_VERIFY` | `true` | skip TLS verification for OIDC discovery and JWKS fetches |
| `KNAIC_AUTH_DISABLED` | `false` | dev only — injects a fake admin |
| `KNAIC_REGISTRY_ENDPOINT` | `registry.knaic.local` | mirrored image registry host |
| `KNAIC_REGISTRY_PROJECT` | `components` | path under the registry |
| `KNAIC_REGISTRY_USE_EMBED` | `true` | use the in-cluster bundled registry |
| `KNAIC_CORS_ORIGINS` | dev defaults | comma-separated allow-list |
| `KNAIC_DB_URL` | _(empty)_ | Postgres DSN for model metadata and Playground agent sessions; empty uses in-memory stores |
| `KNAIC_PROMETHEUS_URL` | _(empty)_ | Prometheus-compatible base URL; empty uses deterministic synthetic dev series. See [Monitoring backends](#monitoring-backends) for VictoriaMetrics. |
| `KNAIC_PROMETHEUS_AUTH` | _(empty)_ | `forward` forwards the user's verified OIDC bearer to the upstream (use with an oauth2-proxy fronting the metrics endpoint with `--skip-jwt-bearer-tokens`); `bearer` sends `KNAIC_PROMETHEUS_BEARER`; empty sends no header. |
| `KNAIC_PROMETHEUS_BEARER` | _(empty)_ | Static bearer for `KNAIC_PROMETHEUS_AUTH=bearer`, or fallback used by `forward` mode when no caller token is present. |
| `KNAIC_OPENCODE_BIN` | `opencode` | opencode executable used by Playground Agent |
| `KNAIC_AGENT_WORKDIR` | OS temp dir | base directory for generated opencode configs, state, and data |
| `KNAIC_AGENT_API_BASE` | derived from `KNAIC_ADDR` | backend URL the local MCP tool server calls from opencode |

## API surface (v1)

```
GET    /healthz                              -> 200 ok
GET    /readyz                               -> 200 ready
GET    /api/v1/auth/config                   -> public OIDC login config
GET    /api/v1/whoami                        -> resolved User (auth req'd)

GET    /api/v1/components                    -> list (with cluster reconcile)
POST   /api/v1/components                    -> import a Helm chart  [admin]
GET    /api/v1/components/{name}             -> single component
PATCH  /api/v1/components/{name}             -> {selectedVersion}    [admin]
DELETE /api/v1/components/{name}             -> remove imported      [admin]
POST   /api/v1/components/{name}/install     -> Helm install         [admin]
POST   /api/v1/components/{name}/uninstall   -> Helm uninstall       [admin]
POST   /api/v1/components/{name}/reconcile   -> Helm upgrade         [admin]
POST   /api/v1/components/{name}/adopt       -> mark Unmanaged as ours [admin]

GET    /api/v1/registry                      -> registry config
PATCH  /api/v1/registry                      -> update config         [admin]
POST   /api/v1/registry/sync                 -> mark all images synced [admin]

GET    /api/v1/storage/targets               -> list storage targets
POST   /api/v1/storage/targets               -> register a target      [admin]
PATCH  /api/v1/storage/targets/{id}          -> update a target        [admin]
DELETE /api/v1/storage/targets/{id}          -> remove a target        [admin]

GET    /api/v1/models?scope=public|private&namespace=ns
POST   /api/v1/models                        -> create metadata
POST   /api/v1/models/import                 -> import HF/ModelScope URL
POST   /api/v1/models/upload                 -> register uploaded model metadata
GET    /api/v1/models/{id}
PATCH  /api/v1/models/{id}
DELETE /api/v1/models/{id}

GET    /api/v1/namespaces/{ns}/{slug}        -> list K8s resources
POST   /api/v1/namespaces/{ns}/{slug}        -> create JSON/YAML object [admin]
GET    /api/v1/namespaces/{ns}/{slug}/{name}
PUT    /api/v1/namespaces/{ns}/{slug}/{name} -> replace JSON/YAML object [admin]
PATCH  /api/v1/namespaces/{ns}/{slug}/{name} -> replace JSON/YAML object [admin]
DELETE /api/v1/namespaces/{ns}/{slug}/{name} [admin]
GET    /api/v1/namespaces/{ns}/pods/{name}/logs
GET    /api/v1/cluster/{slug}                -> cluster-scoped list

POST   /api/v1/namespaces/{ns}/inference/services
POST   /api/v1/namespaces/{ns}/inference/runtimes
POST   /api/v1/namespaces/{ns}/notebook
POST   /api/v1/namespaces/{ns}/notebook/{name}/stop
POST   /api/v1/namespaces/{ns}/notebook/{name}/start
POST   /api/v1/namespaces/{ns}/training/runtimes
POST   /api/v1/namespaces/{ns}/training/jobs
GET    /api/v1/namespaces/{ns}/training/jobs/{name}/mlflow

GET    /api/v1/admin/users                   [admin]
PATCH  /api/v1/admin/users/{id}              [admin]
GET    /api/v1/admin/nodes                   [admin]
PATCH  /api/v1/admin/nodes/{name}            [admin]
GET    /api/v1/admin/namespaces              [admin]
POST   /api/v1/admin/namespaces              [admin]
PATCH  /api/v1/admin/namespaces/{name}/quota [admin]
DELETE /api/v1/admin/namespaces/{name}       [admin]
GET    /api/v1/admin/namespaces/{ns}/roles   [admin]
POST   /api/v1/admin/namespaces/{ns}/roles   [admin]
PUT    /api/v1/admin/namespaces/{ns}/roles/{kind}/{name} [admin]
DELETE /api/v1/admin/namespaces/{ns}/roles/{kind}/{name} [admin]
GET    /api/v1/admin/namespaces/{ns}/rolebindings        [admin]
POST   /api/v1/admin/namespaces/{ns}/rolebindings        [admin]
PUT    /api/v1/admin/namespaces/{ns}/rolebindings/{name} [admin]
DELETE /api/v1/admin/namespaces/{ns}/rolebindings/{name} [admin]

GET    /api/v1/monitoring/query?scope=namespace&target=team-ml&resource=cpu&kind=usage
GET    /api/v1/monitoring/llm?namespace=team-ml&service=qwen3-5-7b
GET    /api/v1/monitoring/training?namespace=team-ml&job=llama3-finetune

GET    /api/v1/playground/providers
POST   /api/v1/playground/providers
PATCH  /api/v1/playground/providers/{id}
DELETE /api/v1/playground/providers/{id}
POST   /api/v1/playground/chat
POST   /api/v1/playground/chat/stream
GET    /api/v1/playground/agent/sessions
POST   /api/v1/playground/agent/sessions
GET    /api/v1/playground/agent/sessions/{id}
DELETE /api/v1/playground/agent/sessions/{id}
POST   /api/v1/playground/agent/sessions/{id}/run
```

## Image registry sync

The `build/sync-images.sh` script reads the configured registry from the API,
walks every component's image list, and uses `skopeo copy` to mirror each
image. It then POSTs `/api/v1/registry/sync` so the UI counters update. Run
this once before packaging knaic for an air-gapped cluster.

## Helm release identification

Every release knaic creates is named `knaic-<component>` and labeled with
`knaic.io/managed=true` + `knaic.io/component=<name>`. Detection treats any
release of the same chart that lacks these markers as **Unmanaged (manual)**;
matching OLM ClusterServiceVersions are reported as **Unmanaged (OLM)**.

## Set KUBECONFIG

Set the `KUBECONFIG` env var to the file path before starting `knaic-api`. It's already wired up in `internal/config/config.go:38` and consumed by `internal/k8s/client.go:50` (`loadConfig`):

```bash
KUBECONFIG=$HOME/.kube/dev-cluster.yaml ./bin/knaic-api
```

Resolution order (`internal/k8s/client.go:51-71`):
1. **`KUBECONFIG` set** → use that file as the explicit path.
2. **Empty + running inside a pod** → in-cluster config (`/var/run/secrets/kubernetes.io/serviceaccount/...`).
3. **Empty + outside cluster** → default loading rules (`$HOME/.kube/config`, plus any colon-separated `KUBECONFIG` chain — k8s standard).

It's already documented at `backend/README.md:82` (`KUBECONFIG | _(in-cluster)_ | path to kubeconfig`).

For Helm:

```yaml
# values.yaml
kubeconfig:
  existingSecret: ""        # if set, mount instead of using in-cluster SA
  secretKey: kubeconfig

# templates/deployment.yaml — pick one
{{- if .Values.kubeconfig.existingSecret }}
volumeMounts:
  - name: kubeconfig
    mountPath: /etc/knaic
    readOnly: true
env:
  - name: KUBECONFIG
    value: /etc/knaic/kubeconfig
volumes:
  - name: kubeconfig
    secret:
      secretName: {{ .Values.kubeconfig.existingSecret }}
      items:
        - key: {{ .Values.kubeconfig.secretKey }}
          path: kubeconfig
{{- end }}
```

In-cluster (no kubeconfig, run with the pod's ServiceAccount) is the recommended deploy mode, since impersonation rights are then bound to that SA.
