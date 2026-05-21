package aistorage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GitLabTransport is the shared http.Transport used for all GitLab egress
// — both the typed handlers in this package and the passthrough proxy in
// internal/api/aistorage.go. We default to InsecureSkipVerify because dev
// GitLab instances commonly run with self-signed or expired certs (which
// otherwise surface as `tls: certificate has expired or is not yet valid`).
// Operators that want strict TLS can opt back in by setting
// KNAIC_GITLAB_TLS_VERIFY=true on the knaic-backend deployment.
//
// Reused as a package-level singleton so connection pooling works across
// requests. http.Transport is safe for concurrent use.
func GitLabTransport() *http.Transport {
	gitlabTransportOnce.Do(func() {
		strict := truthy(os.Getenv("KNAIC_GITLAB_TLS_VERIFY"))
		gitlabTransportVal = &http.Transport{
			Proxy:           http.ProxyFromEnvironment,
			TLSClientConfig: &tls.Config{InsecureSkipVerify: !strict}, //nolint:gosec // by design — see doc
			MaxIdleConns:    10,
			IdleConnTimeout: 90 * time.Second,
		}
	})
	return gitlabTransportVal
}

var (
	gitlabTransportOnce sync.Once
	gitlabTransportVal  *http.Transport
)

func truthy(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// GitLabConfig is one GitLab account configured in a namespace. Multiple
// configs per namespace are allowed (e.g. one per group/project), which is
// why each is a distinct Secret.
type GitLabConfig struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	URL       string `json:"url"`
	Username  string `json:"username,omitempty"`
	// Token is intentionally NOT included in projections. Reveal endpoints
	// are not exposed.
	CreatedAt string `json:"createdAt,omitempty"`
}

type CreateGitLabConfigRequest struct {
	Name     string `json:"name"`
	URL      string `json:"url"`
	Username string `json:"username,omitempty"`
	Token    string `json:"token"`
}

type PatchGitLabConfigRequest struct {
	URL      *string `json:"url,omitempty"`
	Username *string `json:"username,omitempty"`
	Token    string  `json:"token,omitempty"`
}

const (
	annGitLabURL      = "knaic.io/aistorage-gitlab-url"
	annGitLabUsername = "knaic.io/aistorage-gitlab-username"
)

func (s *Service) ListGitLabConfigs(ctx context.Context, namespace string) ([]GitLabConfig, error) {
	list, err := s.typed.CoreV1().Secrets(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("%s=%s,%s=gitlab", labelComponent, componentValue, labelKind),
	})
	if err != nil {
		return nil, err
	}
	out := make([]GitLabConfig, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, projectGitLabConfig(&list.Items[i]))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *Service) CreateGitLabConfig(ctx context.Context, namespace string, req CreateGitLabConfigRequest) (GitLabConfig, error) {
	if req.Name == "" || req.URL == "" || req.Token == "" {
		return GitLabConfig{}, errors.New("name, url, and token are required")
	}
	if _, err := url.ParseRequestURI(req.URL); err != nil {
		return GitLabConfig{}, fmt.Errorf("invalid url: %w", err)
	}
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      req.Name,
			Namespace: namespace,
			Labels: map[string]string{
				labelManaged:   "true",
				labelComponent: componentValue,
				labelKind:      "gitlab",
			},
			Annotations: map[string]string{
				annGitLabURL:      strings.TrimRight(req.URL, "/"),
				annGitLabUsername: req.Username,
			},
		},
		Type: corev1.SecretTypeOpaque,
		StringData: map[string]string{
			"GITLAB_TOKEN": req.Token,
		},
	}
	created, err := s.typed.CoreV1().Secrets(namespace).Create(ctx, sec, metav1.CreateOptions{})
	if err != nil {
		return GitLabConfig{}, err
	}
	return projectGitLabConfig(created), nil
}

func (s *Service) PatchGitLabConfig(ctx context.Context, namespace, name string, req PatchGitLabConfigRequest) (GitLabConfig, error) {
	sec, err := s.typed.CoreV1().Secrets(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return GitLabConfig{}, err
	}
	if !isOurs(sec.Labels, "gitlab") {
		return GitLabConfig{}, errors.New("not an AI-Storage GitLab secret")
	}
	if sec.Annotations == nil {
		sec.Annotations = map[string]string{}
	}
	if req.URL != nil {
		sec.Annotations[annGitLabURL] = strings.TrimRight(*req.URL, "/")
	}
	if req.Username != nil {
		sec.Annotations[annGitLabUsername] = *req.Username
	}
	if req.Token != "" {
		if sec.Data == nil {
			sec.Data = map[string][]byte{}
		}
		sec.Data["GITLAB_TOKEN"] = []byte(req.Token)
	}
	updated, err := s.typed.CoreV1().Secrets(namespace).Update(ctx, sec, metav1.UpdateOptions{})
	if err != nil {
		return GitLabConfig{}, err
	}
	return projectGitLabConfig(updated), nil
}

func (s *Service) DeleteGitLabConfig(ctx context.Context, namespace, name string) error {
	sec, err := s.typed.CoreV1().Secrets(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	if !isOurs(sec.Labels, "gitlab") {
		return errors.New("not an AI-Storage GitLab secret")
	}
	return s.typed.CoreV1().Secrets(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func projectGitLabConfig(sec *corev1.Secret) GitLabConfig {
	return GitLabConfig{
		Name:      sec.Name,
		Namespace: sec.Namespace,
		URL:       sec.Annotations[annGitLabURL],
		Username:  sec.Annotations[annGitLabUsername],
		CreatedAt: sec.CreationTimestamp.Format(time.RFC3339),
	}
}

// -------------------- GitLab file ops --------------------

// GitLabProject is one project the configured token can reach. The list is
// paged through (max 100 per page) until we run out.
type GitLabProject struct {
	ID            int    `json:"id"`
	PathWithNs    string `json:"pathWithNamespace"`
	DefaultBranch string `json:"defaultBranch,omitempty"`
	WebURL        string `json:"webUrl,omitempty"`
	LFSEnabled    bool   `json:"lfsEnabled"`
}

type GitLabTreeEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Type string `json:"type"` // "tree" | "blob"
	Mode string `json:"mode,omitempty"`
	IsLFS bool  `json:"isLfs"`
	Size  int64 `json:"size,omitempty"`
}

// gitlabClient wraps the per-config GitLab address + token along with a
// shared http.Client. Constructed per request from the Secret so we don't
// have to think about token rotation.
type gitlabClient struct {
	base   string
	token  string
	http   *http.Client
}

// GitLabUpstream returns the configured GitLab base URL and token for the
// given config secret. This is the entry point for the HTTP passthrough
// proxy in internal/api/aistorage.go — the proxy can't reuse gitlabClient
// directly because it streams a raw http.Request instead of building one
// from a typed shape.
func (s *Service) GitLabUpstream(ctx context.Context, namespace, secretName string) (baseURL, token string, err error) {
	g, err := s.gitlabClient(ctx, namespace, secretName)
	if err != nil {
		return "", "", err
	}
	return g.base, g.token, nil
}

func (s *Service) gitlabClient(ctx context.Context, namespace, secretName string) (*gitlabClient, error) {
	sec, err := s.typed.CoreV1().Secrets(namespace).Get(ctx, secretName, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	if !isOurs(sec.Labels, "gitlab") {
		return nil, errors.New("not an AI-Storage GitLab secret")
	}
	base := sec.Annotations[annGitLabURL]
	if base == "" {
		return nil, errors.New("gitlab url not configured on secret")
	}
	tok := string(sec.Data["GITLAB_TOKEN"])
	if tok == "" {
		return nil, errors.New("gitlab token missing")
	}
	return &gitlabClient{
		base:  strings.TrimRight(base, "/"),
		token: tok,
		http:  &http.Client{Timeout: 60 * time.Second, Transport: GitLabTransport()},
	}, nil
}

func (g *gitlabClient) do(ctx context.Context, method, path string, body io.Reader, headers map[string]string) (*http.Response, error) {
	u := g.base + path
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("PRIVATE-TOKEN", g.token)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := g.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024))
		return nil, fmt.Errorf("gitlab %s %s: %s — %s", method, path, resp.Status, strings.TrimSpace(string(b)))
	}
	return resp, nil
}

// GitLabListProjects lists projects accessible to the token, sorted by
// path. The GitLab REST endpoint is GET /api/v4/projects?membership=true.
func (s *Service) GitLabListProjects(ctx context.Context, namespace, secretName string) ([]GitLabProject, error) {
	g, err := s.gitlabClient(ctx, namespace, secretName)
	if err != nil {
		return nil, err
	}
	out := []GitLabProject{}
	page := 1
	for {
		resp, err := g.do(ctx, "GET", fmt.Sprintf("/api/v4/projects?membership=true&simple=false&per_page=100&page=%d", page), nil, nil)
		if err != nil {
			return nil, err
		}
		var batch []struct {
			ID            int    `json:"id"`
			PathWithNs    string `json:"path_with_namespace"`
			DefaultBranch string `json:"default_branch"`
			WebURL        string `json:"web_url"`
			LFSEnabled    bool   `json:"lfs_enabled"`
		}
		dec := json.NewDecoder(resp.Body)
		if err := dec.Decode(&batch); err != nil {
			_ = resp.Body.Close()
			return nil, err
		}
		_ = resp.Body.Close()
		for _, p := range batch {
			out = append(out, GitLabProject{
				ID:            p.ID,
				PathWithNs:    p.PathWithNs,
				DefaultBranch: p.DefaultBranch,
				WebURL:        p.WebURL,
				LFSEnabled:    p.LFSEnabled,
			})
		}
		if len(batch) < 100 {
			break
		}
		page++
		if page > 50 { // hard cap so a runaway pager can't hang us
			break
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PathWithNs < out[j].PathWithNs })
	return out, nil
}

// GitLabListTree lists entries in a project's repo path. Use ref="" to
// default to the project's default branch.
func (s *Service) GitLabListTree(ctx context.Context, namespace, secretName string, projectID int, path, ref string) ([]GitLabTreeEntry, error) {
	g, err := s.gitlabClient(ctx, namespace, secretName)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	if path != "" {
		q.Set("path", path)
	}
	if ref != "" {
		q.Set("ref", ref)
	}
	q.Set("per_page", "100")
	resp, err := g.do(ctx, "GET", fmt.Sprintf("/api/v4/projects/%d/repository/tree?%s", projectID, q.Encode()), nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var batch []struct {
		Name string `json:"name"`
		Path string `json:"path"`
		Type string `json:"type"`
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&batch); err != nil {
		return nil, err
	}
	// To mark LFS entries we'd need to either inspect `.gitattributes` or
	// peek at the blob's first bytes (LFS pointers are tiny YAML-like
	// files: "version https://git-lfs.github.com/spec/v1\noid sha256:..").
	// For the tree listing we do the cheap pass: look up `.gitattributes`
	// at the project root and surface entries that match any `filter=lfs`
	// pattern.
	lfsPatterns, _ := g.fetchLFSPatterns(ctx, projectID, ref)

	out := make([]GitLabTreeEntry, 0, len(batch))
	for _, e := range batch {
		entry := GitLabTreeEntry{
			Name: e.Name, Path: e.Path, Type: e.Type, Mode: e.Mode,
		}
		if entry.Type == "blob" {
			for _, pat := range lfsPatterns {
				if matchLFSPattern(pat, entry.Path) {
					entry.IsLFS = true
					break
				}
			}
		}
		out = append(out, entry)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Type != out[j].Type {
			return out[i].Type == "tree" // trees first
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// GitLabDownload streams a file's content. For LFS-backed files this
// transparently follows the LFS batch protocol to fetch from the LFS store.
func (s *Service) GitLabDownload(ctx context.Context, namespace, secretName string, projectID int, path, ref string) (io.ReadCloser, int64, error) {
	g, err := s.gitlabClient(ctx, namespace, secretName)
	if err != nil {
		return nil, 0, err
	}
	q := url.Values{}
	if ref != "" {
		q.Set("ref", ref)
	} else {
		q.Set("ref", "HEAD")
	}
	resp, err := g.do(ctx, "GET", fmt.Sprintf("/api/v4/projects/%d/repository/files/%s/raw?%s", projectID, url.PathEscape(path), q.Encode()), nil, nil)
	if err != nil {
		return nil, 0, err
	}
	// Peek the first 200 bytes to detect an LFS pointer file. The raw
	// content endpoint returns the pointer itself for LFS-backed blobs;
	// we have to follow it through the LFS batch API.
	const pointerProbe = 200
	head := make([]byte, pointerProbe)
	n, _ := io.ReadFull(resp.Body, head)
	headSlice := head[:n]
	if isLFSPointer(headSlice) {
		_ = resp.Body.Close()
		oid, size, err := parseLFSPointer(headSlice)
		if err != nil {
			return nil, 0, fmt.Errorf("parse LFS pointer: %w", err)
		}
		return g.lfsDownload(ctx, projectID, oid, size)
	}
	size := int64(-1)
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		if v, err := strconv.ParseInt(cl, 10, 64); err == nil {
			size = v
		}
	}
	// We already read the head — splice it back onto the stream.
	combined := struct {
		io.Reader
		io.Closer
	}{
		Reader: io.MultiReader(bytes.NewReader(headSlice), resp.Body),
		Closer: resp.Body,
	}
	return combined, size, nil
}

// GitLabUpload commits a file to the repo at path. When markAsLFS is true,
// we first upload the bytes via the LFS batch protocol, then commit a
// pointer file in their place. Also patches `.gitattributes` so future
// reads recognise the file as LFS.
func (s *Service) GitLabUpload(ctx context.Context, namespace, secretName string, projectID int, path, branch, commitMsg string, body io.Reader, markAsLFS bool) error {
	g, err := s.gitlabClient(ctx, namespace, secretName)
	if err != nil {
		return err
	}
	if commitMsg == "" {
		commitMsg = "Upload " + path + " via knaic AI Storage"
	}
	if branch == "" {
		branch = "main"
	}
	// Always read the full body into memory — we need the SHA256 for LFS,
	// and uploads via the regular /repository/files endpoint take base64
	// in the JSON body, which can't stream.
	buf, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	if markAsLFS {
		oid := sha256.Sum256(buf)
		oidHex := hex.EncodeToString(oid[:])
		if err := g.lfsUpload(ctx, projectID, oidHex, int64(len(buf)), buf); err != nil {
			return err
		}
		pointer := buildLFSPointer(oidHex, int64(len(buf)))
		if err := g.commitFile(ctx, projectID, branch, path, commitMsg, pointer); err != nil {
			return err
		}
		return g.ensureLFSPattern(ctx, projectID, branch, path)
	}
	return g.commitFile(ctx, projectID, branch, path, commitMsg, buf)
}

// commitFile creates-or-updates a file at path on branch. We always try
// POST first and fall back to PUT on 400 conflict ("already exists") so
// the caller doesn't have to probe existence beforehand.
func (g *gitlabClient) commitFile(ctx context.Context, projectID int, branch, path, msg string, content []byte) error {
	payload := map[string]any{
		"branch":         branch,
		"commit_message": msg,
		"content":        base64.StdEncoding.EncodeToString(content),
		"encoding":       "base64",
	}
	body, _ := json.Marshal(payload)
	headers := map[string]string{"Content-Type": "application/json"}
	resp, err := g.do(ctx, "POST", fmt.Sprintf("/api/v4/projects/%d/repository/files/%s", projectID, url.PathEscape(path)), bytes.NewReader(body), headers)
	if err == nil {
		_ = resp.Body.Close()
		return nil
	}
	// Try PUT — file already exists.
	resp2, err2 := g.do(ctx, "PUT", fmt.Sprintf("/api/v4/projects/%d/repository/files/%s", projectID, url.PathEscape(path)), bytes.NewReader(body), headers)
	if err2 != nil {
		// Return original error if both failed; PUT failure is usually a
		// secondary symptom of whatever made POST fail.
		return err
	}
	_ = resp2.Body.Close()
	return nil
}

// ----------------- LFS bits ---------------------

// LFS batch protocol — single object at a time, since the UI sends one file
// per request.
type lfsBatchReq struct {
	Operation string          `json:"operation"`
	Transfers []string        `json:"transfers"`
	Objects   []lfsBatchObj   `json:"objects"`
}
type lfsBatchObj struct {
	OID  string `json:"oid"`
	Size int64  `json:"size"`
}
type lfsBatchResp struct {
	Objects []struct {
		OID     string `json:"oid"`
		Size    int64  `json:"size"`
		Actions struct {
			Download *lfsAction `json:"download,omitempty"`
			Upload   *lfsAction `json:"upload,omitempty"`
			Verify   *lfsAction `json:"verify,omitempty"`
		} `json:"actions"`
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error,omitempty"`
	} `json:"objects"`
}
type lfsAction struct {
	Href   string            `json:"href"`
	Header map[string]string `json:"header,omitempty"`
}

// lfsBatch hits the project's LFS batch endpoint. The path is
// {base}/{path_with_namespace}.git/info/lfs/objects/batch — GitLab uses
// the same path under api/v4 too, but the .git form is what the LFS spec
// mandates. We build it via the /projects/:id endpoint which GitLab
// resolves into the canonical .git path internally.
func (g *gitlabClient) lfsBatch(ctx context.Context, projectID int, operation, oid string, size int64) (*lfsBatchResp, error) {
	pathWithNs, err := g.projectPath(ctx, projectID)
	if err != nil {
		return nil, err
	}
	req := lfsBatchReq{
		Operation: operation,
		Transfers: []string{"basic"},
		Objects:   []lfsBatchObj{{OID: oid, Size: size}},
	}
	body, _ := json.Marshal(req)
	resp, err := g.do(ctx, "POST",
		"/"+pathWithNs+".git/info/lfs/objects/batch",
		bytes.NewReader(body),
		map[string]string{
			"Accept":       "application/vnd.git-lfs+json",
			"Content-Type": "application/vnd.git-lfs+json",
		},
	)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out lfsBatchResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (g *gitlabClient) lfsDownload(ctx context.Context, projectID int, oid string, size int64) (io.ReadCloser, int64, error) {
	batch, err := g.lfsBatch(ctx, projectID, "download", oid, size)
	if err != nil {
		return nil, 0, err
	}
	if len(batch.Objects) == 0 || batch.Objects[0].Actions.Download == nil {
		return nil, 0, errors.New("LFS batch returned no download action")
	}
	act := batch.Objects[0].Actions.Download
	req, err := http.NewRequestWithContext(ctx, "GET", act.Href, nil)
	if err != nil {
		return nil, 0, err
	}
	for k, v := range act.Header {
		req.Header.Set(k, v)
	}
	resp, err := g.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	if resp.StatusCode >= 400 {
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, 0, fmt.Errorf("LFS download: %s — %s", resp.Status, string(b))
	}
	return resp.Body, size, nil
}

func (g *gitlabClient) lfsUpload(ctx context.Context, projectID int, oid string, size int64, content []byte) error {
	batch, err := g.lfsBatch(ctx, projectID, "upload", oid, size)
	if err != nil {
		return err
	}
	if len(batch.Objects) == 0 {
		return errors.New("LFS batch returned no objects")
	}
	obj := batch.Objects[0]
	if obj.Error != nil {
		return fmt.Errorf("LFS batch error %d: %s", obj.Error.Code, obj.Error.Message)
	}
	if obj.Actions.Upload == nil {
		// LFS server says it already has this object — nothing to do.
		return nil
	}
	upReq, err := http.NewRequestWithContext(ctx, "PUT", obj.Actions.Upload.Href, bytes.NewReader(content))
	if err != nil {
		return err
	}
	for k, v := range obj.Actions.Upload.Header {
		upReq.Header.Set(k, v)
	}
	resp, err := g.http.Do(upReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("LFS upload: %s — %s", resp.Status, string(b))
	}
	if obj.Actions.Verify != nil {
		vbody, _ := json.Marshal(map[string]any{"oid": oid, "size": size})
		vreq, err := http.NewRequestWithContext(ctx, "POST", obj.Actions.Verify.Href, bytes.NewReader(vbody))
		if err != nil {
			return err
		}
		vreq.Header.Set("Content-Type", "application/vnd.git-lfs+json")
		for k, v := range obj.Actions.Verify.Header {
			vreq.Header.Set(k, v)
		}
		vresp, err := g.http.Do(vreq)
		if err != nil {
			return err
		}
		_ = vresp.Body.Close()
	}
	return nil
}

// projectPath caches nothing — looking up the project path is cheap and
// happens at most twice per upload/download.
func (g *gitlabClient) projectPath(ctx context.Context, projectID int) (string, error) {
	resp, err := g.do(ctx, "GET", fmt.Sprintf("/api/v4/projects/%d", projectID), nil, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var meta struct {
		PathWithNs string `json:"path_with_namespace"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
		return "", err
	}
	if meta.PathWithNs == "" {
		return "", errors.New("project has no path_with_namespace")
	}
	return meta.PathWithNs, nil
}

// fetchLFSPatterns reads .gitattributes at the default branch root and
// returns the list of path patterns that have `filter=lfs`. Failure is
// soft — we just return an empty list so the tree still renders.
func (g *gitlabClient) fetchLFSPatterns(ctx context.Context, projectID int, ref string) ([]string, error) {
	if ref == "" {
		ref = "HEAD"
	}
	q := url.Values{"ref": []string{ref}}
	resp, err := g.do(ctx, "GET", fmt.Sprintf("/api/v4/projects/%d/repository/files/.gitattributes/raw?%s", projectID, q.Encode()), nil, nil)
	if err != nil {
		return nil, nil // ignore — .gitattributes may not exist
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, nil
	}
	out := []string{}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.Contains(line, "filter=lfs") {
			fields := strings.Fields(line)
			if len(fields) > 0 {
				out = append(out, fields[0])
			}
		}
	}
	return out, nil
}

// ensureLFSPattern appends `<path> filter=lfs diff=lfs merge=lfs -text` to
// .gitattributes if no matching line is already there. Best-effort: any
// failure here is non-fatal because the upload itself already succeeded;
// the file just won't be re-discovered as LFS by future tree listings
// from this UI.
func (g *gitlabClient) ensureLFSPattern(ctx context.Context, projectID int, branch, path string) error {
	pat := path
	resp, err := g.do(ctx, "GET", fmt.Sprintf("/api/v4/projects/%d/repository/files/.gitattributes/raw?ref=%s", projectID, branch), nil, nil)
	var existing []byte
	if err == nil {
		defer resp.Body.Close()
		existing, _ = io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		for _, line := range strings.Split(string(existing), "\n") {
			fields := strings.Fields(strings.TrimSpace(line))
			if len(fields) > 0 && fields[0] == pat && strings.Contains(line, "filter=lfs") {
				return nil
			}
		}
	}
	updated := append([]byte{}, existing...)
	if len(updated) > 0 && updated[len(updated)-1] != '\n' {
		updated = append(updated, '\n')
	}
	updated = append(updated, []byte(pat+" filter=lfs diff=lfs merge=lfs -text\n")...)
	return g.commitFile(ctx, projectID, branch, ".gitattributes", "Mark "+path+" as LFS via knaic AI Storage", updated)
}

// isLFSPointer is the cheapest possible heuristic — the spec's first line.
func isLFSPointer(b []byte) bool {
	return bytes.HasPrefix(b, []byte("version https://git-lfs.github.com/spec/v1"))
}

// parseLFSPointer pulls oid + size out of a pointer file. Pointer files
// are tiny (~140 bytes) and structured as key-value lines.
func parseLFSPointer(b []byte) (oid string, size int64, err error) {
	for _, line := range strings.Split(string(b), "\n") {
		switch {
		case strings.HasPrefix(line, "oid sha256:"):
			oid = strings.TrimPrefix(line, "oid sha256:")
		case strings.HasPrefix(line, "size "):
			v, perr := strconv.ParseInt(strings.TrimPrefix(line, "size "), 10, 64)
			if perr != nil {
				return "", 0, perr
			}
			size = v
		}
	}
	if oid == "" || size == 0 {
		return "", 0, errors.New("not a valid LFS pointer")
	}
	return oid, size, nil
}

// buildLFSPointer is the inverse of parseLFSPointer — emits the canonical
// pointer file content.
func buildLFSPointer(oid string, size int64) []byte {
	return []byte(fmt.Sprintf("version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %d\n", oid, size))
}

// matchLFSPattern is a tiny glob that only handles the patterns commonly
// used in .gitattributes for LFS: literal paths and `*.ext`. Anything
// fancier we accept as "best effort match against the basename".
func matchLFSPattern(pattern, path string) bool {
	if pattern == path {
		return true
	}
	if strings.HasPrefix(pattern, "*.") {
		return strings.HasSuffix(path, pattern[1:])
	}
	if strings.HasSuffix(pattern, "/*") {
		dir := strings.TrimSuffix(pattern, "/*")
		return strings.HasPrefix(path, dir+"/") && !strings.Contains(path[len(dir)+1:], "/")
	}
	return false
}
