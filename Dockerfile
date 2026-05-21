# Single image for the knaic console: Go API + bundled React UI + opencode CLI.
#
# Stages:
#   1. ui-build         — npm install + vite build
#   2. api-build        — go build ./cmd/knaic-api
#   3. opencode-fetch   — download + extract the opencode CLI used by the
#                         playground agent runner
#   4. runtime          — distroless base-debian12 (glibc; opencode is a
#                         Bun-compiled native binary that links libc.so.6
#                         / libpthread / libdl / libm)
#
# Base images default to the upstream registries; override the ARGs below
# at build time if your buildkitd has to pull from a mirror or internal
# Harbor instead.
#
# Build:
#   docker build -t knaic:<tag> .
ARG NODE_IMAGE=node:22-slim
ARG GOLANG_IMAGE=golang:1.24
ARG RUNTIME_IMAGE=gcr.io/distroless/base-debian12:nonroot
ARG OPENCODE_VERSION=v1.14.41
# The opencode CLI is downloaded from GitHub Releases at build time. If
# your build environment can't reach github.com directly, set
# OPENCODE_PROXY to an HTTP(S) proxy.
ARG OPENCODE_PROXY=
ARG OPENCODE_URL=https://github.com/sst/opencode/releases/download/${OPENCODE_VERSION}/opencode-linux-x64.tar.gz

FROM ${NODE_IMAGE} AS ui-build
WORKDIR /ui

COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY frontend/ ./
ENV VITE_KNAIC_API=""
RUN npm run build

FROM ${GOLANG_IMAGE} AS api-build
WORKDIR /src

# GOPROXY is overridable so build environments without direct access to
# proxy.golang.org can point at an internal Nexus / goproxy.cn mirror.
ARG GOPROXY=https://proxy.golang.org,direct

ENV CGO_ENABLED=0 \
    GOFLAGS=-trimpath \
    GOPROXY=${GOPROXY}

COPY backend/go.mod backend/go.sum ./
# `go mod download` here is purely a cache-warming step — when go.sum is
# fully populated for the deps in go.mod this layer is reused across
# source-only changes. We tolerate failure (`|| true`) so the build still
# proceeds when a dev has added a require directive without running
# `go mod tidy` locally; the tidy step below will fix it up.
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download || true

COPY backend/ ./

# `go mod tidy` reconciles go.sum with what the source actually imports.
# It's a no-op when go.sum is already complete. With the module cache
# warmed by the step above, this typically only hits the network for
# genuinely new deps.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod tidy && \
    go build -ldflags='-s -w' -o /out/knaic-api ./cmd/knaic-api

FROM ${GOLANG_IMAGE} AS opencode-fetch
ARG OPENCODE_URL
ARG OPENCODE_PROXY
# The golang image already ships curl + ca-certificates. The proxy is
# expected to NOT intercept github.com TLS; we pass --proto =https so
# any redirect to a plain-http mirror is refused. retry 3 covers the
# occasional buildkit-side mid-stream reset that motivated vendoring
# this file in the first place.
RUN mkdir /out \
    && HTTPS_PROXY="${OPENCODE_PROXY}" HTTP_PROXY="${OPENCODE_PROXY}" \
       curl -fL --proto '=https' --retry 3 --retry-delay 2 \
            -o /tmp/opencode.tgz "${OPENCODE_URL}" \
    && tar -xzf /tmp/opencode.tgz -C /out \
    && chmod +x /out/opencode \
    && rm /tmp/opencode.tgz

# opencode's file-watcher native binding (Bun-compiled) dynamically loads
# libstdc++ and libgcc_s. distroless/base-debian12 ships libc / libm /
# libpthread / libdl but neither of these C++ runtime libs — so without
# them opencode logs "file.watcher … cannot open shared object file" at
# startup and bails before running the prompt. We stage the .so files
# out of the Node Debian image (already cached for the UI build) rather
# than pulling another base.
FROM ${NODE_IMAGE} AS libs
RUN mkdir -p /libs \
    && cp -L /usr/lib/x86_64-linux-gnu/libstdc++.so.6 /libs/ \
    && cp -L /lib/x86_64-linux-gnu/libgcc_s.so.1 /libs/

FROM ${RUNTIME_IMAGE}
COPY --from=libs           /libs/libstdc++.so.6 /usr/lib/x86_64-linux-gnu/libstdc++.so.6
COPY --from=libs           /libs/libgcc_s.so.1  /lib/x86_64-linux-gnu/libgcc_s.so.1
COPY --from=api-build      /out/knaic-api /usr/local/bin/knaic-api
COPY --from=opencode-fetch /out/opencode  /usr/local/bin/opencode
COPY --from=ui-build       /ui/dist       /web
ENV KNAIC_STATIC_DIR=/web \
    KNAIC_OPENCODE_BIN=/usr/local/bin/opencode
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/knaic-api"]
