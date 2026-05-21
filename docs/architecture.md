# Architecture

knaic is a single-binary Go API plus a React UI bundle. Both pieces ship in
the same container image; the Go binary serves the React build under `/` and
its own HTTP API under `/api/v1/`.

## Repository layout

```
knaic/
├─ backend/                   Go HTTP API
│  ├─ cmd/knaic-api/          process entrypoint
│  ├─ internal/
│  │  ├─ agentworkspace/      per-user Codex Web pod provisioning + reverse proxy
│  │  ├─ admin/               nodes, namespaces, ResourceQuotas, RBAC, observed users
│  │  ├─ aistorage/           S3 / PVC / GitLab browser backends
│  │  ├─ api/                 chi routes + handlers (one file per area)
│  │  ├─ auth/                OIDC verifier, bearer middleware, grant cookies
│  │  ├─ charts/              embed.FS of built-in Helm charts
│  │  ├─ collections/         model collections store
│  │  ├─ components/          Helm install/uninstall + unmanaged detection
│  │  ├─ config/              env-based Config loader
│  │  ├─ gpu/                 cluster + per-card GPU status, profile store
│  │  ├─ inference/           KServe ServingRuntime / InferenceService helpers
│  │  ├─ k8s/                 rest.Config + typed/dynamic/discovery clients + impersonation
│  │  ├─ k8sres/              generic Kubernetes resource CRUD + log streaming
│  │  ├─ logx/                slog wrapper
│  │  ├─ models/              model hub metadata (in-memory or Postgres)
│  │  ├─ monitoring/          Prometheus query_range proxy
│  │  ├─ notebook/            Kubeflow notebook lifecycle
│  │  ├─ playground/          LLM provider registry, chat proxy, opencode agent runner
│  │  ├─ publish/             model publish requests
│  │  ├─ registry/            built-in image registry config store
│  │  ├─ storage/             storage targets (Model Hub picker)
│  │  └─ training/            TrainJob + MLflow proxy
│  ├─ deploy/                 k8s manifests (Deployment + Service + Gateway + Cert)
│  └─ build/sync-images.sh    skopeo-based offline image mirror
└─ frontend/                  React + TypeScript + Vite + Ant Design 5
   ├─ src/
   │  ├─ api/                 typed bindings — one file per backend area
   │  ├─ auth/                AuthContext (Dex OIDC redirect flow)
   │  ├─ components/          shared widgets (PageHeader, StatusTag, YamlEditor, …)
   │  ├─ context/             AppContext (theme, namespace, user)
   │  ├─ data/                stores + cache hooks
   │  ├─ layouts/             MainLayout (sidebar + header)
   │  └─ pages/               one folder per top-level menu
   └─ vite.config.ts          dev proxy /api → backend on :8080
```

## Runtime model

- **Auth**: requests carry a Dex (OIDC) bearer token. The verifier checks it,
  extracts user + groups, and stamps a `*auth.User` onto the request context.
- **Cluster access**: each handler grabs a `*k8s.UserClients` bundle through a
  `k8sClientSource`. In production the bundle is built by impersonating the
  verified user (`UserName + Groups` headers), so the apiserver enforces
  per-user RBAC. In `KNAIC_AUTH_DISABLED=true` dev mode the source returns
  the backend's own SA client.
- **Iframe auth**: `<iframe src=…>` requests can't carry bearer headers, so
  endpoints that get embedded (PVC viewer, Agent Workspace) mint a path-
  scoped HMAC-signed HttpOnly cookie via a `/grant` endpoint before the
  iframe loads.
- **Agent Workspace**: provisioned with the backend's SA (not the impersonated
  user) so any authenticated caller can get their own Codex Web pod without
  needing namespace Deployment-create RBAC. The pod, PVC, and Service are
  keyed on a DNS-safe slug of the user's OIDC identity.

## Deep dives

- [backend/README.md](../backend/README.md) — env var matrix, OIDC and
  apiserver impersonation setup, persistence options.
- [frontend/README.md](../frontend/README.md) — Vite dev server, env-driven
  modes (`VITE_KNAIC_API`, `VITE_KNAIC_SYNTHETIC`).
- [pvcviewer-auth.md](./pvcviewer-auth.md) — how the PVC viewer iframe gets
  authenticated via short-lived path-scoped grant cookies.
