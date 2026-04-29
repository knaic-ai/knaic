SHELL := /usr/bin/env bash
BIN   := bin/knaic-api
PKG   := ./cmd/knaic-api

.PHONY: all
all: build

.PHONY: tidy
tidy:
	go mod tidy

.PHONY: build
build:
	mkdir -p bin
	go build -o $(BIN) $(PKG)

.PHONY: run
run:
	KNAIC_AUTH_DISABLED=true KNAIC_ADDR=:8080 go run $(PKG)

.PHONY: test
test:
	go test ./...

.PHONY: vet
vet:
	go vet ./...

.PHONY: fmt
fmt:
	gofmt -w -s .

.PHONY: sync-images
sync-images:
	bash build/sync-images.sh

.PHONY: docker
docker:
	docker build -t knaic-api:dev .
