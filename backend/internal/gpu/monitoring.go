package gpu

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/knaic/knaic-backend/internal/monitoring"
)

// MonitoringService computes the same Status payload as Service, but sources
// its data from a Prometheus-compatible upstream (VictoriaMetrics in our
// deployment) instead of the apiserver. Used for non-admin callers in
// cluster scope: they can't list nodes / pods cluster-wide via impersonation,
// but kube-state-metrics + DCGM expose the same numbers without requiring
// per-user RBAC.
//
// All resource keys returned by KSM are underscored
// (nvidia.com/gpualloc → nvidia_com_gpualloc). canonicalResourceKey converts
// them back to the canonical "<group>/<resource>" form so the response is
// indistinguishable from Service.Status() for the frontend.
type MonitoringService struct {
	mon *monitoring.Service
}

func NewMonitoringService(mon *monitoring.Service) *MonitoringService {
	return &MonitoringService{mon: mon}
}

// Available reports whether the upstream has been configured. The handler
// uses this to decide if a monitoring-backed fall-through is even possible.
func (s *MonitoringService) Available() bool {
	return s != nil && s.mon != nil && s.mon.BaseURL() != ""
}

// Status mirrors Service.Status() but reads from VM. Scope handling:
//   - cluster: cluster-wide capacity + every GPU-using pod.
//   - namespace: capacity stays cluster-wide (nodes aren't namespaced) but
//     pods are filtered to the target namespace.
func (s *MonitoringService) Status(ctx context.Context, opts Options) (Status, error) {
	out := Status{
		Scope:   opts.Scope,
		Target:  opts.Namespace,
		Vendors: []VendorSummary{},
		Nodes:   []NodeSummary{},
		Pods:    []PodUsage{},
	}
	if !s.Available() {
		return out, nil
	}

	// `.+_.+_.+` excludes cpu / memory / ephemeral_storage / hugepages_*
	// at the upstream so we don't pull every container's resource series.
	// isAcceleratorKey then trims the remainder (attachable_volumes_csi_*).
	capQuery := `kube_node_status_capacity{resource=~".+_.+_.+"}`
	caps, err := s.queryInstant(ctx, capQuery)
	if err != nil {
		return out, fmt.Errorf("query node capacity: %w", err)
	}

	// kube_pod_container_resource_requests{resource="<key>"} — one series per
	// (namespace, pod, node, container, key). We collapse containers into
	// pods on the Go side so we can still surface ContainerUsage rows.
	reqQuery := `kube_pod_container_resource_requests{resource=~".+_.+_.+"}`
	if opts.Scope == "namespace" && opts.Namespace != "" {
		reqQuery = fmt.Sprintf(`kube_pod_container_resource_requests{namespace=%q,resource=~".+_.+_.+"}`, opts.Namespace)
	}
	requests, err := s.queryInstant(ctx, reqQuery)
	if err != nil {
		return out, fmt.Errorf("query pod requests: %w", err)
	}

	nodeAlloc := map[string]int64{}
	nodes := map[string]*NodeSummary{}
	for _, sample := range caps {
		key := canonicalResourceKey(sample.metric["resource"])
		if !isAcceleratorKey(key) {
			continue
		}
		node := sample.metric["node"]
		if node == "" {
			continue
		}
		ns, ok := nodes[node]
		if !ok {
			ns = &NodeSummary{
				Node:      node,
				Capacity:  map[string]int64{},
				Allocated: map[string]int64{},
			}
			nodes[node] = ns
		}
		ns.Capacity[key] += int64(sample.value)
		nodeAlloc[key] += int64(sample.value)
	}

	// podKey groups containers back into pods.
	type podKey struct{ namespace, name string }
	podRows := map[podKey]*PodUsage{}
	usedByKey := map[string]int64{}
	usedPerNode := map[string]map[string]int64{}
	podsPerNode := map[string]int{}
	seenPodNode := map[podKey]bool{} // count each pod once per node
	for _, sample := range requests {
		key := canonicalResourceKey(sample.metric["resource"])
		if !isAcceleratorKey(key) {
			continue
		}
		pk := podKey{namespace: sample.metric["namespace"], name: sample.metric["pod"]}
		if pk.namespace == "" || pk.name == "" {
			continue
		}
		row, ok := podRows[pk]
		if !ok {
			row = &PodUsage{
				Namespace: pk.namespace,
				Name:      pk.name,
				Node:      sample.metric["node"],
				Phase:     "Running", // KSM only reports requests for live pods
				Resources: map[string]int64{},
			}
			podRows[pk] = row
		}
		// Find or create the matching ContainerUsage.
		cname := sample.metric["container"]
		var cu *ContainerUsage
		for i := range row.Containers {
			if row.Containers[i].Name == cname {
				cu = &row.Containers[i]
				break
			}
		}
		if cu == nil {
			row.Containers = append(row.Containers, ContainerUsage{Name: cname, Resources: map[string]int64{}})
			cu = &row.Containers[len(row.Containers)-1]
		}
		n := int64(sample.value)
		cu.Resources[key] += n
		row.Resources[key] += n
		usedByKey[key] += n
		if row.Node != "" {
			if usedPerNode[row.Node] == nil {
				usedPerNode[row.Node] = map[string]int64{}
			}
			usedPerNode[row.Node][key] += n
			if !seenPodNode[pk] {
				podsPerNode[row.Node]++
				seenPodNode[pk] = true
			}
		}
	}

	// Stable output ordering — namespace, then pod name.
	rows := make([]PodUsage, 0, len(podRows))
	for _, r := range podRows {
		rows = append(rows, *r)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Namespace != rows[j].Namespace {
			return rows[i].Namespace < rows[j].Namespace
		}
		return rows[i].Name < rows[j].Name
	})

	// Folder per-node tallies. Non-admins won't have node capacity in some
	// deployments — we still surface usedPerNode rows so the UI can list
	// nodes that have GPU-using pods scheduled to them.
	nodeList := make([]NodeSummary, 0, len(nodes))
	for _, ns := range nodes {
		ns.Allocated = usedPerNode[ns.Node]
		ns.Pods = podsPerNode[ns.Node]
		nodeList = append(nodeList, *ns)
	}
	sort.Slice(nodeList, func(i, j int) bool { return nodeList[i].Node < nodeList[j].Node })

	// Build the vendor summary using the same heuristic the apiserver path
	// uses — keeps the response shape identical.
	keySet := map[string]struct{}{}
	for k := range nodeAlloc {
		keySet[k] = struct{}{}
	}
	for k := range usedByKey {
		keySet[k] = struct{}{}
	}
	keyList := make([]string, 0, len(keySet))
	for k := range keySet {
		keyList = append(keyList, k)
	}
	sort.Strings(keyList)
	out.Vendors = groupByVendor(keyList, nodeAlloc, usedByKey)
	out.Nodes = nodeList
	out.Pods = rows
	for _, v := range out.Vendors {
		out.Summary.Total += v.Counts.Total
		out.Summary.Used += v.Counts.Used
		out.Summary.Available += v.Counts.Available
	}
	return out, nil
}

// sample is one row of a Prometheus /api/v1/query response. value is parsed
// as float64 to match Prometheus's wire format; we cast to int64 for resource
// counts (which are always integers in K8s).
type sample struct {
	metric map[string]string
	value  float64
}

func (s *MonitoringService) queryInstant(ctx context.Context, query string) ([]sample, error) {
	if !s.Available() {
		return nil, nil
	}
	u, err := url.Parse(s.mon.BaseURL() + "/api/v1/query")
	if err != nil {
		return nil, err
	}
	qp := u.Query()
	qp.Set("query", query)
	qp.Set("time", strconv.FormatInt(time.Now().Unix(), 10))
	u.RawQuery = qp.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	s.mon.ApplyAuth(ctx, req)
	res, err := s.mon.Client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var body struct {
		Status string `json:"status"`
		Data   struct {
			Result []struct {
				Metric map[string]string `json:"metric"`
				Value  []any             `json:"value"`
			} `json:"result"`
		} `json:"data"`
		Error string `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, err
	}
	if body.Status != "success" {
		return nil, fmt.Errorf("%s", body.Error)
	}
	out := make([]sample, 0, len(body.Data.Result))
	for _, r := range body.Data.Result {
		if len(r.Value) != 2 {
			continue
		}
		raw, _ := r.Value[1].(string)
		v, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			continue
		}
		out = append(out, sample{metric: r.Metric, value: v})
	}
	return out, nil
}

// canonicalResourceKey reverses kube-state-metrics's underscore mangling so
// the rest of the package (and the frontend) can keep working in the
// canonical "<group>/<resource>" form. KSM rewrites both "." and "/" to "_",
// so we restore the slash from the LAST underscore and dots from the others.
// That's accurate for the GPU/NPU resource keys we care about
// (nvidia_com_gpu / nvidia_com_gpualloc / huawei_com_Ascend910B / hami_io_vgpu).
// Resource names with their own dashes / underscores (rare for accelerators)
// may round-trip imperfectly, but won't cause a crash.
func canonicalResourceKey(ks string) string {
	if ks == "" {
		return ks
	}
	idx := strings.LastIndex(ks, "_")
	if idx < 0 {
		return ks
	}
	group := strings.ReplaceAll(ks[:idx], "_", ".")
	resource := ks[idx+1:]
	if group == "" {
		return resource
	}
	return group + "/" + resource
}
