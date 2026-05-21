package api

import (
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/knaic/knaic-backend/internal/aistorage"
	"github.com/knaic/knaic-backend/internal/auth"
)

type aiStorageAPI struct {
	source k8sClientSource
	grants *auth.GrantStore
}

func newAIStorageAPI(source k8sClientSource, grants *auth.GrantStore) *aiStorageAPI {
	return &aiStorageAPI{source: source, grants: grants}
}

// routes is mounted under /api/v1/namespaces/{namespace}/aistorage.
//
// The high-level split inside this subtree:
//
//	GET    /s3/secrets, /gitlab/configs
//	POST   /s3/secrets, /gitlab/configs               (admin only — writes)
//	PATCH  /s3/secrets/{n}, /gitlab/configs/{n}       (admin only)
//	DELETE /s3/secrets/{n}, /gitlab/configs/{n}       (admin only)
//
//	/s3/secrets/{n}/buckets|objects                   (any user, impersonated)
//	/gitlab/configs/{n}/projects, tree, file/...      (any user)
//	/pvc[…], /pvc/{n}/viewer[/start|/stop|/status]    (any user)
//	/pvc/{n}/viewer/*                                 (reverse proxy)
func (a *aiStorageAPI) routes(r chi.Router) {
	r.Route("/s3", func(r chi.Router) {
		r.Get("/secrets", a.listS3Secrets)
		r.With(auth.RequirePlatformAdmin).Post("/secrets", a.createS3Secret)
		r.With(auth.RequirePlatformAdmin).Patch("/secrets/{name}", a.patchS3Secret)
		r.With(auth.RequirePlatformAdmin).Delete("/secrets/{name}", a.deleteS3Secret)
		r.Get("/secrets/{name}/buckets", a.listS3Buckets)
		r.Get("/secrets/{name}/objects", a.listS3Objects)
		r.Post("/secrets/{name}/objects", a.uploadS3Object)
		r.Get("/secrets/{name}/objects/raw", a.downloadS3Object)
		// Sets the path-scoped grant cookie that lets `<a href download>`
		// navigations work without an Authorization header. Frontend
		// POSTs here right before triggering a download click.
		r.Post("/secrets/{name}/objects/grant", a.s3DownloadGrant)
		r.Delete("/secrets/{name}/objects", a.deleteS3Object)
	})

	r.Route("/gitlab", func(r chi.Router) {
		r.Get("/configs", a.listGitLabConfigs)
		r.With(auth.RequirePlatformAdmin).Post("/configs", a.createGitLabConfig)
		r.With(auth.RequirePlatformAdmin).Patch("/configs/{name}", a.patchGitLabConfig)
		r.With(auth.RequirePlatformAdmin).Delete("/configs/{name}", a.deleteGitLabConfig)
		r.Get("/configs/{name}/projects", a.listGitLabProjects)
		r.Get("/configs/{name}/projects/{projectID}/tree", a.listGitLabTree)
		r.Get("/configs/{name}/projects/{projectID}/file/raw", a.downloadGitLabFile)
		r.Post("/configs/{name}/projects/{projectID}/file/grant", a.gitlabDownloadGrant)
		r.Post("/configs/{name}/projects/{projectID}/file", a.uploadGitLabFile)
		// Passthrough proxy. Anything under /api/ is forwarded to the
		// configured GitLab with the token attached server-side — this
		// covers both `/api/v4/...` (REST) and `/api/graphql` (the
		// GraphQL endpoint used for tree + size + LFS detection in one
		// query). The catch-all matches every method.
		r.HandleFunc("/configs/{name}/api/*", a.gitlabAPIProxy)
	})

	r.Route("/pvc", func(r chi.Router) {
		r.Get("/", a.listPVCs)
		r.Post("/", a.createPVC)
		r.Delete("/{name}", a.deletePVC)
		r.Get("/{name}/viewer/status", a.pvcViewerStatus)
		r.Post("/{name}/viewer/start", a.pvcViewerStart)
		r.Post("/{name}/viewer/stop", a.pvcViewerStop)
		// Mints + sets the path-scoped grant cookie that lets the
		// iframe load the proxy below without an Authorization header.
		r.Post("/{name}/viewer/grant", a.pvcViewerGrant)
		// The reverse proxy needs the rest of the path. chi gives us
		// chi.URLParam(r, "*") with the catch-all. Authenticated via
		// either bearer (developer tools / curl) or the grant cookie
		// (browser iframe).
		r.HandleFunc("/{name}/viewer/*", a.pvcViewerProxy)
	})
}

func (a *aiStorageAPI) service(r *http.Request) (*aistorage.Service, error) {
	clients, err := a.source.clientsForRequest(r)
	if err != nil {
		return nil, err
	}
	return aistorage.New(clients.Typed), nil
}

// ----------------- S3 -----------------

func (a *aiStorageAPI) listS3Secrets(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	items, err := svc.ListS3Secrets(r.Context(), chi.URLParam(r, "namespace"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *aiStorageAPI) createS3Secret(w http.ResponseWriter, r *http.Request) {
	var req aistorage.CreateS3SecretRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	out, err := svc.CreateS3Secret(r.Context(), chi.URLParam(r, "namespace"), req)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (a *aiStorageAPI) patchS3Secret(w http.ResponseWriter, r *http.Request) {
	var req aistorage.PatchS3SecretRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	out, err := svc.PatchS3Secret(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), req)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *aiStorageAPI) deleteS3Secret(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	if err := svc.DeleteS3Secret(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name")); err != nil {
		writeK8sError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *aiStorageAPI) listS3Buckets(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	buckets, err := svc.S3ListBuckets(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, buckets)
}

func (a *aiStorageAPI) listS3Objects(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	q := r.URL.Query()
	objs, err := svc.S3List(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), q.Get("bucket"), q.Get("prefix"))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, objs)
}

func (a *aiStorageAPI) uploadS3Object(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	q := r.URL.Query()
	key := q.Get("key")
	if key == "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "key is required"})
		return
	}
	// We accept the file body raw (Content-Type: application/octet-stream)
	// rather than multipart so the frontend can stream fetch() bodies with
	// no buffering. Content-Length isn't required — minio handles unknown
	// size by buffering each chunk.
	size := int64(-1)
	if cl := r.Header.Get("Content-Length"); cl != "" {
		if v, perr := strconv.ParseInt(cl, 10, 64); perr == nil {
			size = v
		}
	}
	ct := r.Header.Get("Content-Type")
	if err := svc.S3Upload(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), q.Get("bucket"), key, r.Body, size, ct); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *aiStorageAPI) downloadS3Object(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	q := r.URL.Query()
	key := q.Get("key")
	if key == "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "key is required"})
		return
	}
	body, info, err := svc.S3Download(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), q.Get("bucket"), key)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	defer body.Close()
	if info.ContentType != "" {
		w.Header().Set("Content-Type", info.ContentType)
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	if info.Size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size, 10))
	}
	// Force download in browsers — we don't want HTML previews running in
	// our origin.
	filename := key
	if idx := strings.LastIndex(filename, "/"); idx >= 0 {
		filename = filename[idx+1:]
	}
	w.Header().Set("Content-Disposition", `attachment; filename="`+sanitizeFilename(filename)+`"`)
	_, _ = io.Copy(w, body)
}

func (a *aiStorageAPI) deleteS3Object(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	q := r.URL.Query()
	key := q.Get("key")
	if key == "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "key is required"})
		return
	}
	if err := svc.S3Delete(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), q.Get("bucket"), key); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ----------------- GitLab -----------------

func (a *aiStorageAPI) listGitLabConfigs(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	items, err := svc.ListGitLabConfigs(r.Context(), chi.URLParam(r, "namespace"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *aiStorageAPI) createGitLabConfig(w http.ResponseWriter, r *http.Request) {
	var req aistorage.CreateGitLabConfigRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	out, err := svc.CreateGitLabConfig(r.Context(), chi.URLParam(r, "namespace"), req)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (a *aiStorageAPI) patchGitLabConfig(w http.ResponseWriter, r *http.Request) {
	var req aistorage.PatchGitLabConfigRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	out, err := svc.PatchGitLabConfig(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), req)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *aiStorageAPI) deleteGitLabConfig(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	if err := svc.DeleteGitLabConfig(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name")); err != nil {
		writeK8sError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *aiStorageAPI) listGitLabProjects(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	projects, err := svc.GitLabListProjects(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, projects)
}

func (a *aiStorageAPI) listGitLabTree(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	pid, err := strconv.Atoi(chi.URLParam(r, "projectID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid projectID"})
		return
	}
	q := r.URL.Query()
	tree, err := svc.GitLabListTree(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), pid, q.Get("path"), q.Get("ref"))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, tree)
}

func (a *aiStorageAPI) downloadGitLabFile(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	pid, err := strconv.Atoi(chi.URLParam(r, "projectID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid projectID"})
		return
	}
	q := r.URL.Query()
	path := q.Get("path")
	if path == "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "path is required"})
		return
	}
	body, size, err := svc.GitLabDownload(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), pid, path, q.Get("ref"))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	defer body.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	if size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	filename := path
	if idx := strings.LastIndex(filename, "/"); idx >= 0 {
		filename = filename[idx+1:]
	}
	w.Header().Set("Content-Disposition", `attachment; filename="`+sanitizeFilename(filename)+`"`)
	_, _ = io.Copy(w, body)
}

// gitlabAPIProxy reverse-proxies /aistorage/gitlab/configs/{name}/api/v4/*
// to the configured upstream GitLab, attaching the namespace-scoped
// PRIVATE-TOKEN server-side.
//
// Security notes:
//   - The route lives inside the verifier-protected group, so the caller is
//     already authenticated to knaic.
//   - We strip any client-provided Authorization / PRIVATE-TOKEN /
//     X-GitLab-* headers before injecting our own. The browser can't trick
//     us into forwarding a token it picked.
//   - The cookie header is dropped too. Cookies set on the knaic domain
//     would otherwise leak to the upstream.
//   - We don't pass the X-Forwarded-* triplet through. The upstream is
//     GitLab itself, not a downstream service, so it has no business
//     learning the original client's IP or our hostname.
func (a *aiStorageAPI) gitlabAPIProxy(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	rest := chi.URLParam(r, "*")

	baseURL, token, err := svc.GitLabUpstream(r.Context(), namespace, name)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	target, err := url.Parse(baseURL)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: "invalid gitlab url: " + err.Error()})
		return
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	// Share the package-level GitLab transport so the InsecureSkipVerify
	// default (controlled by KNAIC_GITLAB_TLS_VERIFY) and connection
	// pooling apply to passthrough calls just like they do to the typed
	// handlers.
	proxy.Transport = aistorage.GitLabTransport()
	// Wrap the default Director so we keep its Scheme/Host wiring and add
	// our own header / path tweaks on top.
	base := proxy.Director
	proxy.Director = func(req *http.Request) {
		base(req)
		req.URL.Path = "/api/" + rest
		req.URL.RawPath = "" // let net/url re-encode
		req.URL.RawQuery = r.URL.RawQuery
		req.Host = target.Host
		// Strip anything the caller may have set so we can't be fooled
		// into forwarding their credentials.
		req.Header.Del("Authorization")
		req.Header.Del("PRIVATE-TOKEN")
		req.Header.Del("Cookie")
		req.Header.Del("X-Forwarded-For")
		req.Header.Del("X-Forwarded-Host")
		req.Header.Del("X-Forwarded-Proto")
		req.Header.Set("PRIVATE-TOKEN", token)
		// Set a stable User-Agent so GitLab logs can identify the source.
		req.Header.Set("User-Agent", "knaic-gitlab-proxy/1")
	}
	proxy.ErrorHandler = func(rw http.ResponseWriter, _ *http.Request, e error) {
		writeJSON(rw, http.StatusBadGateway, apiError{Error: "gitlab proxy: " + e.Error()})
	}
	proxy.ServeHTTP(w, r)
}

func (a *aiStorageAPI) uploadGitLabFile(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	pid, err := strconv.Atoi(chi.URLParam(r, "projectID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid projectID"})
		return
	}
	q := r.URL.Query()
	path := q.Get("path")
	if path == "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "path is required"})
		return
	}
	branch := q.Get("branch")
	commitMsg := q.Get("message")
	lfs := q.Get("lfs") == "true" || q.Get("lfs") == "1"
	if err := svc.GitLabUpload(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), pid, path, branch, commitMsg, r.Body, lfs); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ----------------- PVC -----------------

func (a *aiStorageAPI) listPVCs(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	items, err := svc.ListPVCs(r.Context(), chi.URLParam(r, "namespace"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *aiStorageAPI) createPVC(w http.ResponseWriter, r *http.Request) {
	var req aistorage.CreatePVCRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	out, err := svc.CreatePVC(r.Context(), chi.URLParam(r, "namespace"), req)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (a *aiStorageAPI) deletePVC(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	if err := svc.DeletePVC(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name")); err != nil {
		writeK8sError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *aiStorageAPI) pvcViewerStatus(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	status, err := svc.ViewerStatus(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (a *aiStorageAPI) pvcViewerStart(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	opts := aistorage.PVCViewerOptions{
		Image: os.Getenv("KNAIC_PVC_VIEWER_IMAGE"),
	}
	status, err := svc.StartViewer(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), opts)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// pvcViewerGrant mints a short-lived HMAC-signed grant cookie scoped to
// the per-PVC viewer URL prefix. The frontend calls this once before
// loading the viewer iframe so the iframe's cookie-only requests can
// authenticate downstream.
//
// The grant is bearer-protected at this point (the route lives inside
// the verifier-protected group), so the caller has already proven their
// identity. We just convert that identity into a path-scoped, time-limited
// cookie the browser will attach to in-iframe requests automatically.
func (a *aiStorageAPI) pvcViewerGrant(w http.ResponseWriter, r *http.Request) {
	namespace := chi.URLParam(r, "namespace")
	pvc := chi.URLParam(r, "name")
	scope := "/api/v1/namespaces/" + namespace + "/aistorage/pvc/" + pvc + "/viewer/"
	a.mintGrantCookie(w, r, scope, "viewerPath")
}

// s3DownloadGrant mints a grant scoped to the S3 raw-download URL prefix
// for the given secret. The frontend calls this just before triggering an
// <a href download> click — without it, the navigation has no bearer
// header and the verifier rejects the request with "missing bearer token".
//
// The cookie's Path is the full raw-download endpoint (no key/bucket in
// the path; those are query strings). That keeps the scope as tight as it
// can be: the grant works for any object the user can already read via
// this secret, but nothing else under /api/v1/.
func (a *aiStorageAPI) s3DownloadGrant(w http.ResponseWriter, r *http.Request) {
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	scope := "/api/v1/namespaces/" + namespace + "/aistorage/s3/secrets/" + name + "/objects/raw"
	a.mintGrantCookie(w, r, scope, "downloadPath")
}

// gitlabDownloadGrant: same idea as s3DownloadGrant, scoped to the GitLab
// per-project raw-download URL.
func (a *aiStorageAPI) gitlabDownloadGrant(w http.ResponseWriter, r *http.Request) {
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	pid := chi.URLParam(r, "projectID")
	scope := "/api/v1/namespaces/" + namespace + "/aistorage/gitlab/configs/" + name + "/projects/" + pid + "/file/raw"
	a.mintGrantCookie(w, r, scope, "downloadPath")
}

// mintGrantCookie is the shared path between the three grant endpoints:
// validate that grants are configured, mint a token for the current user
// + scope, set the HttpOnly path-scoped cookie, and return the scope and
// expiry to the caller. pathField is the JSON field name used in the
// response body — historical reasons keep PVC viewer's "viewerPath" and
// the new endpoints use "downloadPath".
func (a *aiStorageAPI) mintGrantCookie(w http.ResponseWriter, r *http.Request, scope, pathField string) {
	if a.grants == nil {
		writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "grants not configured"})
		return
	}
	u := auth.MustFromContext(r.Context())
	const ttl = 10 * time.Minute
	token, exp, err := a.grants.Mint(u, scope, ttl)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
		return
	}
	// HttpOnly + path scope keep the cookie invisible to page JS and
	// scoped to just this URL subtree. SameSite=Lax is enough since the
	// download (and the iframe) loads from the same origin as the parent
	// page (the knaic UI is served from the same Go binary that hosts
	// the API).
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
		pathField:   scope,
		"expiresAt": exp.Format(time.RFC3339),
	})
}

func (a *aiStorageAPI) pvcViewerStop(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	if err := svc.StopViewer(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name")); err != nil {
		writeK8sError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// pvcViewerProxy reverse-proxies the catch-all path to the per-PVC Service.
// The route is /api/v1/namespaces/{ns}/aistorage/pvc/{name}/viewer/* — chi
// strips the matched prefix, leaving "*" as the remainder, which we mount
// at "/" on the target. filebrowser's --baseurl flag tells it to render
// links under the same prefix so JS+CSS resolve correctly inside the
// iframe.
func (a *aiStorageAPI) pvcViewerProxy(w http.ResponseWriter, r *http.Request) {
	namespace := chi.URLParam(r, "namespace")
	pvc := chi.URLParam(r, "name")
	// The catch-all path; chi exposes it as URLParam "*". We rewrite the
	// request to live under that path on the upstream.
	rest := chi.URLParam(r, "*")
	rp := aistorage.ViewerReverseProxy(namespace, pvc)
	r2 := r.Clone(r.Context())
	r2.URL.Path = "/" + rest
	// The upstream sees the basepath again because filebrowser's --baseurl
	// makes it write self-referential links with that prefix. Forwarding
	// the original X-Forwarded-* triplet so the upstream knows the real
	// public path for any redirects it issues.
	r2.Header.Set("X-Forwarded-Prefix", "/api/v1/namespaces/"+namespace+"/aistorage/pvc/"+pvc+"/viewer")
	rp.ServeHTTP(w, r2)
}

// sanitizeFilename drops characters that would break the
// Content-Disposition header. Keep it tight — only strip what really has
// to go (CR, LF, double-quote, backslash); everything else the browser
// happily echoes back.
func sanitizeFilename(s string) string {
	if s == "" {
		return "download"
	}
	repl := strings.NewReplacer(`"`, "", `\`, "", "\r", "", "\n", "")
	return repl.Replace(s)
}
