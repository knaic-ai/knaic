# knaic — Kubernetes Native AI Console

> A lightweight LLM / MLOps / AI container platform that runs on a single
> node. A console built on top of the popular open-source MLOps components
> you already trust — KServe, Kubeflow, Volcano, MLflow, Prometheus.

[English](./README.md) · [简体中文](./README_CN.md)

knaic packs the day-to-day workflow of an internal AI platform — model hub,
inference, notebooks, training, monitoring, a chat playground, and a per-user
agent workspace — into one Go binary plus a React UI. It works on a single
k3s/k8s node for laptop demos, and scales the same way Kubernetes does for
real deployments.

## Screenshots

| Dashboard | Agent Workspace |
|---|---|
| ![dashboard](./screenshots/dashboard.png) | ![agent workspace](./screenshots/agentworkspace.png) |

## Features

**Model & inference**
- 🧩 **Components**: install KServe, Volcano, Hami, Kubeflow Notebooks /
  Trainer, MLflow and friends via a built-in Helm catalog. Detects
  unmanaged installs already on the cluster.
- 🧠 **Model Hub**: public model catalog + private metadata, Postgres or
  in-memory persistence.
- ⚡ **Inference**: structured create flows for KServe `InferenceService`
  and `ServingRuntime`, gateway config, LLM-specific configs, local model
  cache.

**Build & train**
- 📓 **Notebooks**: Kubeflow notebook lifecycle (create / start / stop / PVC).
- 🏋️ **Training**: TrainJobs + MLflow metrics proxy + training runtimes.
- 🤖 **Agent Workspace**: a per-user [Codex Web] pod with a persistent volume,
  provisioned on first visit. Drop-in coding agent in the browser.

[Codex Web]: https://github.com/sst/opencode

**Operate**
- 📊 **Monitoring**: Prometheus-backed dashboards for cluster, GPU, LLM
  services, and training jobs. Synthetic-data fallback for offline UI work.
- 🗂️ **AI Storage**: in-browser S3 / PVC / GitLab browsers, scoped per
  namespace.
- 💬 **LLM Playground**: pluggable provider registry + OpenAI-compatible
  chat proxy + an opencode-backed agent.

**Platform & access control**
- 🔐 **OIDC**: Dex (or any OIDC issuer) handles login; the backend
  impersonates the verified user when talking to the apiserver so K8s RBAC
  drives what the UI can do.
- 👥 **Admin**: nodes, namespaces, quotas, RBAC, GPU profiles, image
  registry, ServiceAccounts.
- 📦 **Single image**: Go API + React bundle + opencode sidecar all live in
  one container — easy to mirror into air-gapped clusters.

## What knaic does — Agent Workspace

Each user gets a personal **Agent Workspace** — an in-browser coding agent
(Codex Web) provisioned on first login, backed by a persistent volume. From
inside that workspace the agent can talk to the knaic API on the user's
behalf and drive AI training / inference workloads end-to-end:

- **Plan** — translate goals like "fine-tune model X on 4× A100" or "serve
  LLM Y with autoscaling" into the right KServe `InferenceService`,
  Kubeflow `TrainJob`, `ServingRuntime`, PVC and quota manifests, without
  the user hand-authoring YAML.
- **Schedule** — submit jobs through Volcano / Kueue-style gang scheduling,
  pack GPU and NPU shards via Hami, and bin-pack inference replicas against
  the cluster's live capacity. Per-namespace quota and GPU profiles are
  checked before submission, not after the pod is stuck Pending.
- **Optimize** — Prometheus, MLflow run metrics, and per-GPU / per-card
  utilization are all reachable through the same API, so the agent can
  flag under-used replicas, RAM/VRAM-bound training jobs, and inference
  services whose tail latency is drifting above target.
- **Iterate from the browser** — code, configs, notebooks and CLI history
  live on the workspace's PVC, so the next session picks up exactly where
  the previous one left off. No local dev environment required.

## Quick start

```bash
# 1. Backend (dev mode — no OIDC, fake admin)
cd backend
KNAIC_AUTH_DISABLED=true KNAIC_ADDR=:8080 KUBECONFIG=$HOME/.kube/config make run

# 2. Frontend (separate terminal)
cd frontend
npm install   # first time only
npm run dev   # http://localhost:4300
```

The Vite dev server proxies `/api` to `http://localhost:8080`. Override
with `VITE_KNAIC_API_TARGET=http://other:8080 npm run dev`.

### Production deploy

The frontend builds to a static bundle (`frontend/dist/`) that the Go binary
serves under `/`. Build both, then run a single binary or container:

```bash
cd frontend && npm run build
cd ../backend && make build
./backend/bin/knaic-api
```

A complete Kubernetes manifest (Deployment, Service, Gateway API,
cert-manager Certificate, ClusterRoleBinding) lives at
[`backend/deploy/knaic-backend.yaml`](./backend/deploy/knaic-backend.yaml).

Production deploys additionally need:
- A reachable Dex (or other OIDC) issuer — `KNAIC_OIDC_ISSUER`.
- A kubeconfig or in-cluster ServiceAccount with `impersonate` rights on
  users / groups / serviceaccounts in `authentication.k8s.io`.
- An image registry the platform admin will mirror component images into;
  see `backend/build/sync-images.sh`.

## Documentation

- [Architecture & code layout](./docs/architecture.md)
- [Backend reference](./backend/README.md) — env var matrix, OIDC and
  impersonation setup, Postgres-backed model metadata, persistence options.
- [Frontend reference](./frontend/README.md) — build modes,
  `VITE_KNAIC_API` resolution, synthetic-data flag.
- [PVC viewer auth model](./docs/pvcviewer-auth.md) — how iframe-embedded
  features authenticate without a bearer header.

## Contribute

Contributions are welcome. The workflow is:

1. **Open an issue first** for non-trivial changes — alignment on scope
   saves rebases.
2. **Branch off `main`** (or whatever default branch exists). Keep changes
   focused; one feature or fix per PR.
3. **Run the local checks** before pushing:
   ```bash
   cd backend  && go build ./... && go test ./... && go vet ./...
   cd frontend && npx tsc --noEmit -p tsconfig.app.json && npm run lint
   ```
4. **Conventional Commit subjects** — e.g. `feat(agentworkspace): …`,
   `fix(inference): …`. Keep the subject ≤ 72 chars, body wrapped at 100.
5. **Update docs** when behaviour changes. README first if the change is
   user-visible; `docs/` for architecture-level notes; `backend/README.md`
   for new env vars.
6. **PR description** should include: summary, screenshots for UI work,
   the commands you ran (build + test), and any follow-ups out of scope.

For code questions, ping the maintainers on the project's issue tracker.

## Roadmap

Rough priorities. PRs that advance any of these are very welcome.

**Near term**
- [ ] Vendor real Helm charts for the remaining built-in component catalog
      entries (currently catalog-only stubs).
- [ ] SubjectAccessReview-gated namespace admin paths so non-cluster-admins
      can fully manage their own namespace.
- [ ] Persistent observed-user registry (Postgres) so admin views survive
      restarts.
- [ ] Frontend bundle splitting — the main chunk is currently 2 MB
      uncompressed (~670 KB gzipped).

**Mid term**
- [ ] NPU dashboards (Ascend `npu-smi` series) alongside the existing GPU
      ones.
- [ ] Distributed-training visualizations: per-rank loss, HCCL/NCCL link
      health, gradient-norm timelines.
- [ ] Agent Workspace marketplace: install MCP servers and skills into a
      user's workspace from the UI.
- [ ] Read-only multi-tenant mode that surfaces a single cluster's state
      across the read-only views without requiring a backend per tenant.

**Long term**
- [ ] Multi-cluster federation — one console driving N clusters via a hub
      apiserver or per-cluster agents.
- [ ] Cost attribution: tie GPU / CPU / storage usage to teams,
      namespaces, or model owners.
- [ ] Cold-start "platform admin wizard" that bootstraps a fresh node from
      `k3s install` to a running knaic + cert-manager + ingress in one
      flow.

If you want to grab one, open an issue mentioning the bullet so we can
sync before you start.
