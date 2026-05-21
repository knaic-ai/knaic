package api

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/knaic/knaic-backend/internal/agentworkspace"
	"github.com/knaic/knaic-backend/internal/auth"
)

// agentWorkspaceAPI exposes the per-user Codex Web workspace lifecycle plus a
// reverse proxy the React iframe consumes. The workspace is keyed on the
// caller's OIDC identity so first-login auto-creation is idempotent.
type agentWorkspaceAPI struct {
	svc    *agentworkspace.Service
	grants *auth.GrantStore
}

func newAgentWorkspaceAPI(svc *agentworkspace.Service, grants *auth.GrantStore) *agentWorkspaceAPI {
	return &agentWorkspaceAPI{svc: svc, grants: grants}
}

func (a *agentWorkspaceAPI) routes(r chi.Router) {
	// GET / POST distinguish "look up existing" vs "ensure created".
	r.Get("/", a.get)
	r.Post("/", a.ensure)
	r.Post("/restart", a.restart)
	r.Patch("/resources", a.updateResources)
	r.Delete("/", a.remove)
	// Mints a short-lived HttpOnly cookie scoped to /proxy/ so the iframe
	// can authenticate without an Authorization header. The frontend calls
	// this once before loading the iframe.
	r.Post("/grant", a.grant)
	// Wildcards under {path} carry the rest of the iframed app's URL. chi's
	// wildcard parameter is "*" — captured here and stripped before
	// forwarding upstream.
	r.HandleFunc("/proxy", a.proxy)
	r.HandleFunc("/proxy/*", a.proxy)
}

// grant mints a path-scoped HMAC-signed cookie the iframe carries
// automatically. Mirrors aiStorage's pvcViewerGrant — the route is bearer-
// protected (lives inside the verifier-gated group), so the user has
// already proven their identity. We trade that bearer for a 10-minute
// cookie scoped to the proxy subtree.
func (a *agentWorkspaceAPI) grant(w http.ResponseWriter, r *http.Request) {
	if a.grants == nil {
		writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "grants not configured"})
		return
	}
	u := auth.MustFromContext(r.Context())
	const scope = "/api/v1/me/workspace/proxy/"
	const ttl = 10 * time.Minute
	token, exp, err := a.grants.Mint(u, scope, ttl)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     auth.GrantCookieName,
		Value:    token,
		Path:     scope,
		Expires:  exp,
		MaxAge:   int(ttl.Seconds()),
		HttpOnly: true,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"proxyPath": scope,
		"expiresAt": exp.Format(time.RFC3339),
	})
}

func (a *agentWorkspaceAPI) ownerID(r *http.Request) string {
	u := auth.MustFromContext(r.Context())
	return ownerIDFromUser(u)
}

// ownerIDFromUser picks the most identity-stable claim available — Email
// first (matches knaic's apiserver-impersonation username convention), then
// Subject, then Name as a last resort. Service.WorkspaceName() handles the
// DNS-safe slugification.
func ownerIDFromUser(u *auth.User) string {
	if u == nil {
		return ""
	}
	switch {
	case u.Email != "":
		return u.Email
	case u.Subject != "":
		return u.Subject
	default:
		return u.Name
	}
}

func (a *agentWorkspaceAPI) get(w http.ResponseWriter, r *http.Request) {
	ws, err := a.svc.Get(r.Context(), a.ownerID(r))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ws)
}

func (a *agentWorkspaceAPI) ensure(w http.ResponseWriter, r *http.Request) {
	ws, err := a.svc.Ensure(r.Context(), a.ownerID(r))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ws)
}

func (a *agentWorkspaceAPI) restart(w http.ResponseWriter, r *http.Request) {
	if err := a.svc.Restart(r.Context(), a.ownerID(r)); err != nil {
		writeK8sError(w, err)
		return
	}
	ws, err := a.svc.Get(r.Context(), a.ownerID(r))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	// Restart flips the pod status to Starting until the new ReplicaSet
	// becomes ready; surface that immediately so the polling loop in the
	// frontend doesn't render a stale "Running" until the next refresh.
	ws.Status = "Starting"
	writeJSON(w, http.StatusOK, ws)
}

func (a *agentWorkspaceAPI) updateResources(w http.ResponseWriter, r *http.Request) {
	var spec agentworkspace.ResourceSpec
	if err := decodeJSON(r, &spec); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	ws, err := a.svc.UpdateResources(r.Context(), a.ownerID(r), spec)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	ws.Status = "Starting"
	writeJSON(w, http.StatusOK, ws)
}

func (a *agentWorkspaceAPI) remove(w http.ResponseWriter, r *http.Request) {
	if err := a.svc.Delete(r.Context(), a.ownerID(r)); err != nil {
		writeK8sError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// proxy reverse-proxies to the user's in-cluster codex-web Service. The
// iframed app runs as if mounted at "/api/v1/me/workspace/proxy/" — Location
// headers and HTML/JS/CSS bodies are rewritten so absolute "/foo" links work
// inside the subpath.
func (a *agentWorkspaceAPI) proxy(w http.ResponseWriter, r *http.Request) {
	ownerID := a.ownerID(r)
	if ownerID == "" {
		writeJSON(w, http.StatusForbidden, apiError{Error: "no caller identity"})
		return
	}
	// Confirm the workspace exists so we return a clean 404 (or 503 while
	// it's still rolling) instead of a raw BadGateway from the proxy.
	if _, err := a.svc.Get(r.Context(), ownerID); err != nil {
		if apierrors.IsNotFound(err) {
			writeJSON(w, http.StatusNotFound, apiError{Error: "workspace not provisioned"})
			return
		}
		writeK8sError(w, err)
		return
	}

	target, err := url.Parse(a.svc.ServiceDNS(ownerID))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}

	rest := chi.URLParam(r, "*")
	originalPath := r.URL.Path
	r.URL.Path = "/" + strings.TrimPrefix(rest, "/")
	r.URL.RawPath = ""
	const proxyPrefix = "/api/v1/me/workspace/proxy"
	// Drop client-side encoding so ModifyResponse can rewrite the body.
	r.Header.Del("Accept-Encoding")

	rp := httputil.NewSingleHostReverseProxy(target)
	rp.ModifyResponse = func(resp *http.Response) error {
		rewriteProxyLocation(resp, proxyPrefix)
		if !shouldRewriteProxyBody(resp.Header.Get("Content-Type")) {
			return nil
		}
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
		if err := resp.Body.Close(); err != nil {
			return err
		}
		rewritten := []byte(rewriteWorkspaceProxyBody(string(raw), proxyPrefix))
		resp.Body = io.NopCloser(bytes.NewReader(rewritten))
		resp.ContentLength = int64(len(rewritten))
		resp.Header.Set("Content-Length", strconv.Itoa(len(rewritten)))
		resp.Header.Del("Content-Encoding")
		return nil
	}
	rp.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
	}
	rp.ServeHTTP(w, r)
	r.URL.Path = originalPath
}

func rewriteProxyLocation(resp *http.Response, proxyPrefix string) {
	location := resp.Header.Get("Location")
	if location == "" {
		return
	}
	if strings.HasPrefix(location, "/") && !strings.HasPrefix(location, proxyPrefix+"/") {
		resp.Header.Set("Location", proxyPrefix+location)
		return
	}
	parsed, err := url.Parse(location)
	if err != nil || !parsed.IsAbs() || resp.Request == nil || parsed.Host != resp.Request.URL.Host {
		return
	}
	if strings.HasPrefix(parsed.Path, "/") && !strings.HasPrefix(parsed.Path, proxyPrefix+"/") {
		parsed.Path = proxyPrefix + parsed.Path
		resp.Header.Set("Location", parsed.String())
	}
}

func shouldRewriteProxyBody(contentType string) bool {
	media := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	return media == "text/html" ||
		media == "text/css" ||
		media == "application/javascript" ||
		media == "text/javascript"
}

func rewriteWorkspaceProxyBody(body, proxyPrefix string) string {
	replacer := strings.NewReplacer(
		`href="/`, `href="`+proxyPrefix+`/`,
		`src="/`, `src="`+proxyPrefix+`/`,
		`action="/`, `action="`+proxyPrefix+`/`,
		`content="/`, `content="`+proxyPrefix+`/`,
		`url(/`, `url(`+proxyPrefix+`/`,
		`href=\"/`, `href=\"`+proxyPrefix+`/`,
		`src=\"/`, `src=\"`+proxyPrefix+`/`,
		`action=\"/`, `action=\"`+proxyPrefix+`/`,
		`content=\"/`, `content=\"`+proxyPrefix+`/`,
		`\"/_next/`, `\"`+proxyPrefix+`/_next/`,
		`\"/api/`, `\"`+proxyPrefix+`/api/`,
		`"/_next/`, `"`+proxyPrefix+`/_next/`,
		`"/api/`, `"`+proxyPrefix+`/api/`,
		`'/_next/`, `'`+proxyPrefix+`/_next/`,
		`'/api/`, `'`+proxyPrefix+`/api/`,
	)
	return replacer.Replace(body)
}
