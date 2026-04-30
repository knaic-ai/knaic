package auth

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// proxyTokenPath is what the discovery doc advertises to the browser in
// place of the upstream token_endpoint. Keep in sync with the route mounted
// in api.NewRouter.
const proxyTokenPath = "/api/v1/auth/token"

// Proxy forwards browser-originating OIDC calls (discovery + token) to the
// upstream issuer. Dex typically does not return CORS headers, so the
// frontend cannot fetch /.well-known/openid-configuration or POST to /token
// directly. The same http.Client that the verifier uses is reused here so
// self-signed-cert handling stays consistent.
type Proxy struct {
	issuer       string
	discovery    []byte
	tokenURL     string
	clientID     string
	clientSecret string
	client       *http.Client
}

// NewProxy fetches the discovery document once and caches it. Returns nil if
// issuer is empty (e.g. AuthDisabled), in which case callers should skip
// mounting the proxy routes. clientID/clientSecret are stamped onto every
// token-exchange request so the frontend can stay a public PKCE client even
// when the upstream is configured as confidential.
func NewProxy(ctx context.Context, issuer, clientID, clientSecret string, insecureSkipVerify bool) (*Proxy, error) {
	if issuer == "" {
		return nil, nil
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: insecureSkipVerify}
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second}

	discURL := strings.TrimRight(issuer, "/") + "/.well-known/openid-configuration"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, discURL, nil)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery request: %w", err)
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery fetch: %w", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery read: %w", err)
	}
	if res.StatusCode/100 != 2 {
		return nil, fmt.Errorf("oidc discovery HTTP %d", res.StatusCode)
	}
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("oidc discovery decode: %w", err)
	}
	tokenURL, _ := doc["token_endpoint"].(string)
	if tokenURL == "" {
		return nil, fmt.Errorf("oidc discovery missing token_endpoint")
	}
	// Advertise the local proxy path so the browser doesn't hit Dex's
	// /token (which has no CORS headers).
	doc["token_endpoint"] = proxyTokenPath
	rewritten, err := json.Marshal(doc)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery re-encode: %w", err)
	}
	return &Proxy{
		issuer:       issuer,
		discovery:    rewritten,
		tokenURL:     tokenURL,
		clientID:     clientID,
		clientSecret: clientSecret,
		client:       client,
	}, nil
}

// Discovery serves the cached discovery JSON.
func (p *Proxy) Discovery(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(p.discovery)
}

// Token forwards a form-encoded POST to the upstream token endpoint, stamping
// the configured client_id/client_secret onto every request so the frontend
// can stay a public PKCE client. Refused for any non-POST method.
func (p *Proxy) Token(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}
	form, err := url.ParseQuery(string(body))
	if err != nil {
		http.Error(w, "parse form: "+err.Error(), http.StatusBadRequest)
		return
	}
	if p.clientID != "" {
		form.Set("client_id", p.clientID)
	}
	if p.clientSecret != "" {
		form.Set("client_secret", p.clientSecret)
	}
	encoded := form.Encode()

	upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost, p.tokenURL, strings.NewReader(encoded))
	if err != nil {
		http.Error(w, "build upstream request: "+err.Error(), http.StatusInternalServerError)
		return
	}
	upstream.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	upstream.ContentLength = int64(len(encoded))
	res, err := p.client.Do(upstream)
	if err != nil {
		http.Error(w, "token endpoint: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer res.Body.Close()
	if rct := res.Header.Get("Content-Type"); rct != "" {
		w.Header().Set("Content-Type", rct)
	}
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, res.Body)
}
