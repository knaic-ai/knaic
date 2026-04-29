# knaic — Kubernetes Native AI Console (prototype)

A fully-interactive Web UI prototype of the **knaic** console described in
`../knaic-desc.md`. All data is in-memory / synthetic; there is no backend.
Every page exercises the CRUD modals, fake streaming, charts, and admin flows
that the real product would expose.

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

## Non-goals (since this is a UI prototype)

- No real Kubernetes / OIDC / Prometheus / PostgreSQL backends.
- No persistence — refreshing the page resets edits.
- HuggingFace / ModelScope URL import only parses the URL; no actual syncing
  is performed.
