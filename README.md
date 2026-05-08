# knaic — Kubernetes Native AI Console

Multi-tenant PaaS console for managing AI workloads on Kubernetes — model
hub, inference services, training jobs, notebooks, monitoring, and platform
admin (components, image registry, RBAC, nodes).

## Repository layout

```
knaic/
├─ backend/        Go HTTP API (chi + Helm SDK + dynamic client + OIDC)
│  ├─ cmd/knaic-api/         entrypoint
│  ├─ internal/api/          chi routes
│  ├─ internal/auth/         OIDC bearer middleware (Dex-compatible)
│  ├─ internal/charts/       embed.FS of built-in Helm charts
│  ├─ internal/components/   Helm install/uninstall + Unmanaged detection
│  ├─ internal/k8s/          rest.Config + typed/dynamic/discovery clients
│  ├─ internal/k8sres/       generic CRUD over K8s resources + log streaming
│  ├─ internal/registry/     built-in image-registry config
│  └─ build/sync-images.sh   skopeo-based offline image mirror
└─ frontend/      React + TypeScript + Vite + Ant Design 5 console
   ├─ src/api/               typed bindings for the backend
   ├─ src/data/              stores + cache (API-backed when reachable)
   ├─ src/pages/             one folder per top-level menu
   └─ vite.config.ts         dev proxy /api → backend on :8080
```

## Run locally

```bash
# 1. backend (separate terminal)
cd backend
KNAIC_AUTH_DISABLED=true KNAIC_ADDR=:8080 KUBECONFIG=$HOME/.kube/config make run

# 2. frontend
cd frontend
npm install      # first time only
npm run dev      # http://localhost:4300
```

The vite dev server proxies `/api` to `http://localhost:8080` by default.
Override with `VITE_KNAIC_API_TARGET=http://other:8080 npm run dev`.

## Production deploy

The frontend builds to a static bundle (`frontend/dist/`) which the Go binary
serves under `/`. Build both then run a single binary:

```bash
cd frontend && npm run build
cd ../backend && make build
./backend/bin/knaic-api
```

Production deployment additionally requires:
- A reachable Dex (or other OIDC) issuer — set `KNAIC_OIDC_ISSUER`.
- A kubeconfig or in-cluster ServiceAccount with permission to install Helm
  releases in `knaic-system` and read across all namespaces the user can
  access.
- An image registry the platform admin will mirror component images into;
  see `backend/build/sync-images.sh`.

## What's implemented

| v2 spec section | Backend | Frontend |
|---|---|---|
| 2.1–2.3 Components mgmt + Unmanaged detect + Helm install | ✅ | ✅ wired |
| 3.   Image registry config + sync trigger | ✅ | ✅ wired |
| 6.   Container resources (Deployments, StatefulSets, Pods, PVCs, …) | ✅ list/get/create/update/yaml/delete + pod log streaming | ✅ Pods/Deployments/StatefulSets/PVCs wired; ConfigMaps/Secrets/Services/Gateways still use prototype data |
| 1, 2.4–2.6 Admin users/RBAC/namespaces/nodes | ✅ backend APIs | UI prototype stores |
| 4.   Model Hub | ✅ in-memory or Postgres metadata | ✅ wired |
| 5.   Resource monitoring | ✅ Prometheus query proxy + dev fallback | UI prototype charts |
| 7.   Inference services / serving runtimes | ✅ structured create + generic CRUD | ✅ wired |
| 8.   LLM playground | ✅ provider registry + OpenAI-compatible chat/stream proxy + opencode-backed agent | ✅ wired |
| 9.   Training runtimes / TrainJobs | ✅ structured create + MLflow proxy | ✅ wired |
| 10.  Notebooks | ✅ create/start/stop + PVC support | ✅ wired |

## Configuration reference

See `backend/README.md` for the full env-var matrix. Key flags:

- `KNAIC_OIDC_ISSUER`, `KNAIC_OIDC_CLIENT_ID`, `KNAIC_OIDC_ADMIN_GROUP`
- `KUBECONFIG` (omit to use in-cluster ServiceAccount)
- `KNAIC_AUTH_DISABLED=true` (dev only — injects a fake admin)
- `KNAIC_SYSTEM_NAMESPACE` (default `knaic-system`)
- `KNAIC_DB_URL` for Postgres-backed model metadata
- `KNAIC_PROMETHEUS_URL` for live monitoring data from Prometheus
- `KNAIC_OPENCODE_BIN` if `opencode` is not on the backend PATH
