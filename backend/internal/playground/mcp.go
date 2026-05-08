package playground

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
)

var allowedK8sSlugs = map[string]bool{
	"pods":                 true,
	"deployments":          true,
	"statefulsets":         true,
	"services":             true,
	"configmaps":           true,
	"pvcs":                 true,
	"gateways":             true,
	"httproutes":           true,
	"inferenceservices":    true,
	"llminferenceservices": true,
	"servingruntimes":      true,
	"notebooks":            true,
	"trainjobs":            true,
	"trainingruntimes":     true,
}

type MCPServer struct {
	baseURL   string
	token     string
	namespace string
	client    *http.Client
}

func RunMCPServerFromEnv(ctx context.Context, in io.Reader, out io.Writer) error {
	s := &MCPServer{
		baseURL:   strings.TrimRight(os.Getenv("KNAIC_AGENT_API_BASE"), "/"),
		token:     os.Getenv("KNAIC_AGENT_TOKEN"),
		namespace: os.Getenv("KNAIC_AGENT_NAMESPACE"),
		client:    http.DefaultClient,
	}
	return s.Serve(ctx, in, out)
}

func (s *MCPServer) Serve(ctx context.Context, in io.Reader, out io.Writer) error {
	r := bufio.NewReader(in)
	for {
		raw, err := readMCPMessage(r)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		var req rpcRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			continue
		}
		if req.ID == nil {
			continue
		}
		result, rpcErr := s.handle(ctx, req.Method, req.Params)
		resp := rpcResponse{JSONRPC: "2.0", ID: req.ID}
		if rpcErr != nil {
			resp.Error = &rpcError{Code: -32000, Message: rpcErr.Error()}
		} else {
			resp.Result = result
		}
		if err := writeMCPMessage(out, resp); err != nil {
			return err
		}
	}
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      any       `json:"id,omitempty"`
	Result  any       `json:"result,omitempty"`
	Error   *rpcError `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (s *MCPServer) handle(ctx context.Context, method string, params json.RawMessage) (any, error) {
	switch method {
	case "initialize":
		return map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "knaic-tools", "version": "0.1.0"},
		}, nil
	case "tools/list":
		return map[string]any{"tools": mcpTools()}, nil
	case "tools/call":
		var call struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(params, &call); err != nil {
			return nil, err
		}
		text, err := s.callTool(ctx, call.Name, call.Arguments)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"content": []map[string]string{{"type": "text", "text": text}},
		}, nil
	default:
		return nil, fmt.Errorf("unsupported MCP method %q", method)
	}
}

func mcpTools() []map[string]any {
	stringProp := func(desc string) map[string]any {
		return map[string]any{"type": "string", "description": desc}
	}
	return []map[string]any{
		{
			"name":        "k8s_list",
			"description": "List read-only Kubernetes resources in a namespace.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{
				"resource":  stringProp("Resource slug, e.g. pods, deployments, inferenceservices."),
				"namespace": stringProp("Namespace. Defaults to selected namespace."),
			}, "required": []string{"resource"}},
		},
		{
			"name":        "k8s_yaml",
			"description": "Fetch read-only YAML for a Kubernetes resource.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{
				"resource":  stringProp("Resource slug."),
				"namespace": stringProp("Namespace. Defaults to selected namespace."),
				"name":      stringProp("Object name."),
			}, "required": []string{"resource", "name"}},
		},
		{
			"name":        "pod_logs",
			"description": "Fetch recent pod logs without following.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{
				"namespace": stringProp("Namespace. Defaults to selected namespace."),
				"pod":       stringProp("Pod name."),
				"container": stringProp("Container name."),
				"tailLines": map[string]any{"type": "number", "description": "Number of log lines."},
			}, "required": []string{"pod"}},
		},
		{
			"name":        "model_search",
			"description": "Search public and namespace-private model metadata.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{
				"query":     stringProp("Case-insensitive search query."),
				"namespace": stringProp("Namespace for private models."),
			}},
		},
		{
			"name":        "prometheus_query",
			"description": "Query resource usage metrics through knaic monitoring.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{
				"scope":    stringProp("cluster, namespace, node, or pod."),
				"target":   stringProp("Scope target when required."),
				"resource": stringProp("cpu, memory, gpu, disk, or network."),
				"kind":     stringProp("usage, requests, or limits."),
			}},
		},
	}
}

func (s *MCPServer) callTool(ctx context.Context, name string, args map[string]any) (string, error) {
	if s.baseURL == "" {
		return "", errors.New("KNAIC_AGENT_API_BASE is required")
	}
	switch name {
	case "k8s_list":
		resource := argString(args, "resource")
		if !allowedK8sSlugs[resource] {
			return "", fmt.Errorf("resource %q is not allowed", resource)
		}
		ns := s.namespaceOr(args)
		return s.get(ctx, fmt.Sprintf("/api/v1/namespaces/%s/%s", url.PathEscape(ns), url.PathEscape(resource)))
	case "k8s_yaml":
		resource := argString(args, "resource")
		if !allowedK8sSlugs[resource] {
			return "", fmt.Errorf("resource %q is not allowed", resource)
		}
		ns := s.namespaceOr(args)
		obj := argString(args, "name")
		if obj == "" {
			return "", errors.New("name is required")
		}
		return s.get(ctx, fmt.Sprintf("/api/v1/namespaces/%s/%s/%s/yaml", url.PathEscape(ns), url.PathEscape(resource), url.PathEscape(obj)))
	case "pod_logs":
		ns := s.namespaceOr(args)
		pod := argString(args, "pod")
		if pod == "" {
			return "", errors.New("pod is required")
		}
		q := url.Values{}
		q.Set("follow", "false")
		if c := argString(args, "container"); c != "" {
			q.Set("container", c)
		}
		tail := argInt(args, "tailLines", 100)
		q.Set("tailLines", strconv.Itoa(tail))
		raw, err := s.get(ctx, fmt.Sprintf("/api/v1/namespaces/%s/pods/%s/logs?%s", url.PathEscape(ns), url.PathEscape(pod), q.Encode()))
		if err != nil {
			return "", err
		}
		return stripSSE(raw), nil
	case "model_search":
		return s.modelSearch(ctx, argString(args, "query"), s.namespaceOr(args))
	case "prometheus_query":
		q := url.Values{}
		for _, k := range []string{"scope", "target", "resource", "kind"} {
			if v := argString(args, k); v != "" {
				q.Set(k, v)
			}
		}
		return s.get(ctx, "/api/v1/monitoring/query?"+q.Encode())
	default:
		return "", fmt.Errorf("tool %q is not available", name)
	}
}

func (s *MCPServer) modelSearch(ctx context.Context, query, namespace string) (string, error) {
	public, err := s.get(ctx, "/api/v1/models?scope=public")
	if err != nil {
		return "", err
	}
	combined := public
	if namespace != "" {
		private, err := s.get(ctx, "/api/v1/models?"+url.Values{"scope": {"private"}, "namespace": {namespace}}.Encode())
		if err == nil {
			combined += "\n" + private
		}
	}
	if strings.TrimSpace(query) == "" {
		return combined, nil
	}
	lower := strings.ToLower(query)
	lines := []string{}
	for _, line := range strings.Split(combined, "\n") {
		if strings.Contains(strings.ToLower(line), lower) {
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 {
		return combined, nil
	}
	return strings.Join(lines, "\n"), nil
}

func (s *MCPServer) get(ctx context.Context, path string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.baseURL+path, nil)
	if err != nil {
		return "", err
	}
	if s.token != "" {
		req.Header.Set("Authorization", s.token)
	}
	res, err := s.client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return "", err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("GET %s: HTTP %d: %s", path, res.StatusCode, strings.TrimSpace(string(body)))
	}
	return string(body), nil
}

func (s *MCPServer) namespaceOr(args map[string]any) string {
	if ns := argString(args, "namespace"); ns != "" {
		return ns
	}
	return s.namespace
}

func readMCPMessage(r *bufio.Reader) ([]byte, error) {
	first, err := r.Peek(1)
	if err != nil {
		return nil, err
	}
	if first[0] == '{' {
		line, err := r.ReadBytes('\n')
		return bytes.TrimSpace(line), err
	}
	contentLength := 0
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 && strings.EqualFold(strings.TrimSpace(parts[0]), "Content-Length") {
			contentLength, _ = strconv.Atoi(strings.TrimSpace(parts[1]))
		}
	}
	if contentLength <= 0 {
		return nil, errors.New("missing Content-Length")
	}
	body := make([]byte, contentLength)
	_, err = io.ReadFull(r, body)
	return body, err
}

func writeMCPMessage(w io.Writer, msg any) error {
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "Content-Length: %d\r\n\r\n", len(raw)); err != nil {
		return err
	}
	_, err = w.Write(raw)
	return err
}

func argString(args map[string]any, key string) string {
	if v, ok := args[key].(string); ok {
		return v
	}
	return ""
}

func argInt(args map[string]any, key string, def int) int {
	switch v := args[key].(type) {
	case int:
		if v > 0 {
			return v
		}
	case float64:
		if v > 0 {
			return int(v)
		}
	}
	return def
}

func stripSSE(raw string) string {
	out := []string{}
	for _, line := range strings.Split(raw, "\n") {
		if strings.HasPrefix(line, "data: ") {
			out = append(out, strings.TrimPrefix(line, "data: "))
		}
	}
	if len(out) == 0 {
		return raw
	}
	return strings.Join(out, "\n")
}
