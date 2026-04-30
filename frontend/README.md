# knaic — Kubernetes Native AI Console

A fully-interactive Web UI for the **knaic** console described in
`../knaic-desc.md`. By default the frontend calls the backend API and requires
backend authentication before loading cluster data. A prototype-only mode is
still available for design review.

Visual tokens (blue primary `#2468f2`, 2px radius, compact density) are tuned
to match the `aml-fe` / `@alauda/ui` look-and-feel.

## Stack

| Area | Choice |
|---|---|
| Bundler | Vite 5 |
| Framework | React 18 + TypeScript |
| UI kit | Ant Design 5 |
| Routing | react-router-dom 6 |
| Charts | recharts |
| Markdown | react-markdown + remark-gfm |

## Getting started

```bash
cd knaic
npm install          # or: pnpm install / yarn install
npm run dev          # http://localhost:4300
npm run build        # tsc -b && vite build
npm run typecheck
```

## Backend API and OIDC

Local development defaults to same-origin API calls under `/api/v1`; the Vite
proxy forwards those requests to `http://localhost:8080`.

Run the backend with the same OIDC variables used in deployment:

```bash
KNAIC_OIDC_ISSUER=https://dex.example.com \
KNAIC_OIDC_CLIENT_ID=knaic \
KNAIC_OIDC_ADMIN_GROUP=knaic:platform-admins \
KNAIC_OIDC_SCOPES="openid profile email groups" \
go run ./cmd/knaic-api
```

When auth is enabled, the frontend first probes `/api/v1/whoami`. A `401`
causes it to fetch `/api/v1/auth/config`, discover the OIDC provider, and start
Authorization Code + PKCE login at `/auth/callback`.

For prototype-only mode without backend calls:

```bash
VITE_KNAIC_API=disabled npm run dev
```

## Feature coverage (from `knaic-desc.md`)

| # | Feature | Pages |
|---|---|---|
| 1 | Components management (admin) | `/admin/components` — install / uninstall / version select, image-registry sync state |
| 2 | Model Hub — public & private | `/models/public`, `/models/private` — register, import by URL (HF/MS), upload, download, README viewer |
| 3 | Resource monitoring | `/monitoring` — CPU / Memory / GPU / Disk / Network at cluster · node · namespace · pod scope, usage/requests/limits |
| 4 | Container management | `/containers/{deployments, statefulsets, pods, pvcs}` with logs |
| 5 | Users & RBAC | `/users`, `/users/roles` — roles, rolebindings, rule editor |
| 6 | Inference | `/inference/serving-runtimes`, `/inference/services` — built-in vLLM / SGLang runtimes, YAML preview, logs |
| 7 | LLM Playground | `/playground/{registry, chat, agent}` — cluster auto-discovery + external providers, OpenAI-style streaming, ReAct agent trace |
| 8 | Training | `/training/{runtimes, jobs}` — TrainingRuntime and TrainJob CRUD with progress + logs |
| 9 | Notebooks | `/notebooks` — Jupyter / VSCode spawners with start/stop |
| 10 | Theme | aml-fe / `@alauda/ui` tokens applied via Ant Design `ConfigProvider` |

## Header controls

- **Namespace switcher** — acts as the tenant scope; list pages filter by the
  selected namespace.
- **User dropdown** — flip the *cluster admin* switch to toggle visibility of
  the `Admin Area` sub-menu and public-model write actions.

## Directory layout

```
knaic/
├─ src/
│  ├─ App.tsx               # routes
│  ├─ theme.ts              # Ant Design tokens tuned to aml-fe
│  ├─ layouts/MainLayout.tsx
│  ├─ context/AppContext.tsx
│  ├─ components/           # shared UI (PageHeader, StatusTag, LogViewer, YamlViewer)
│  ├─ data/                 # in-memory stores + synthetic seed data
│  └─ pages/
│     ├─ Dashboard.tsx
│     ├─ admin/             # Components, Namespaces, Nodes
│     ├─ models/ModelHub.tsx
│     ├─ monitoring/Monitoring.tsx
│     ├─ containers/        # Deployments, StatefulSets, Pods, PVCs
│     ├─ users/             # Users, Roles & Bindings
│     ├─ inference/         # ServingRuntimes, InferenceServices
│     ├─ playground/        # Registry, Chat, Agent, fakeStream.ts
│     ├─ training/          # TrainingRuntimes, TrainJobs
│     └─ notebooks/Notebooks.tsx
├─ index.html
├─ vite.config.ts
└─ tsconfig*.json
```

## Prototype-only non-goals

- `VITE_KNAIC_API=disabled` uses in-memory seed data and fake streaming.
- No persistence in prototype-only mode — refreshing the page resets edits.
- HuggingFace / ModelScope URL import only parses the URL; no actual syncing
  is performed.
