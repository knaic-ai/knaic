package main

import (
	"context"
	"errors"

	"helm.sh/helm/v3/pkg/release"

	"github.com/knaic/knaic-backend/internal/components"
)

// noopHelm is used when the binary is started without a reachable cluster.
// It lets the API still serve component listings (built-in catalog) and
// import requests, but every install/uninstall returns an explicit error so
// the UI can surface "no cluster connected" instead of silently succeeding.
type noopHelm struct{}

func (noopHelm) Install(context.Context, components.Component) (*release.Release, error) {
	return nil, errors.New("no kubernetes cluster reachable: install disabled")
}

func (noopHelm) Upgrade(context.Context, components.Component) (*release.Release, error) {
	return nil, errors.New("no kubernetes cluster reachable: upgrade disabled")
}

func (noopHelm) Uninstall(context.Context, components.Component) error {
	return errors.New("no kubernetes cluster reachable: uninstall disabled")
}

func (noopHelm) ListAll(context.Context) ([]*release.Release, error) {
	return nil, nil
}
