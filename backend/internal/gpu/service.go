package gpu

import (
	"context"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

type Service struct {
	typed kubernetes.Interface
}

func New(typed kubernetes.Interface) *Service { return &Service{typed: typed} }

// Options selects what the caller can see. Cluster scope requires
// node-list/pod-list-all permissions on the apiserver — knaic gates it to
// platform admins. Namespace scope only requires read on pods in that ns.
type Options struct {
	Scope     string // "cluster" or "namespace"
	Namespace string // when Scope=="namespace"
	IsAdmin   bool
}

// Status assembles the full status payload. Returns a usable result even
// when partial data is available (e.g. node listing fails for a non-admin).
func (s *Service) Status(ctx context.Context, opts Options) (Status, error) {
	out := Status{
		Scope:   opts.Scope,
		Target:  opts.Namespace,
		Vendors: []VendorSummary{},
		Nodes:   []NodeSummary{},
		Pods:    []PodUsage{},
	}

	// Node inventory — only for admins (and only when scope=cluster, which
	// is also admin-gated upstream). When the caller can't read nodes, the
	// UI shows the pod-derived data alone.
	nodeAlloc := map[string]int64{} // resource key -> allocatable across cluster
	nodes := []NodeSummary{}
	if opts.IsAdmin {
		list, err := s.typed.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
		if err == nil {
			for _, n := range list.Items {
				ns := NodeSummary{
					Node:      n.Name,
					Capacity:  map[string]int64{},
					Allocated: map[string]int64{},
				}
				for k, v := range n.Status.Allocatable {
					if !isAcceleratorKey(string(k)) {
						continue
					}
					count := quantityToInt64(v)
					ns.Capacity[string(k)] = count
					nodeAlloc[string(k)] += count
				}
				if len(ns.Capacity) > 0 {
					nodes = append(nodes, ns)
				}
			}
		}
	}

	// Pod listing — cluster-wide for admins, namespace-scoped otherwise.
	listOpts := metav1.ListOptions{}
	pods := []corev1.Pod{}
	if opts.Scope == "cluster" && opts.IsAdmin {
		l, err := s.typed.CoreV1().Pods("").List(ctx, listOpts)
		if err == nil {
			pods = l.Items
		}
	} else if opts.Namespace != "" {
		l, err := s.typed.CoreV1().Pods(opts.Namespace).List(ctx, listOpts)
		if err == nil {
			pods = l.Items
		}
	}

	usedByKey := map[string]int64{}
	usedPerNode := map[string]map[string]int64{} // node -> key -> count
	podsPerNode := map[string]int{}
	podRows := []PodUsage{}
	for _, pod := range pods {
		// Skip pods that have terminated; their resources have been freed.
		if pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed {
			continue
		}
		row, has := podRowFor(&pod)
		if !has {
			continue
		}
		// Aggregate per-pod usage into the cluster-wide tallies.
		for k, v := range row.Resources {
			usedByKey[k] += v
		}
		if pod.Spec.NodeName != "" {
			node := pod.Spec.NodeName
			if usedPerNode[node] == nil {
				usedPerNode[node] = map[string]int64{}
			}
			for k, v := range row.Resources {
				usedPerNode[node][k] += v
			}
			podsPerNode[node]++
		}
		podRows = append(podRows, row)
	}

	// Sort pod rows: namespace, then name, for stable rendering.
	sort.Slice(podRows, func(i, j int) bool {
		if podRows[i].Namespace != podRows[j].Namespace {
			return podRows[i].Namespace < podRows[j].Namespace
		}
		return podRows[i].Name < podRows[j].Name
	})

	// Fold per-node allocated values into the NodeSummary list.
	for i := range nodes {
		nodes[i].Allocated = usedPerNode[nodes[i].Node]
		nodes[i].Pods = podsPerNode[nodes[i].Node]
		// `usedPerNode` may include keys that aren't in the node's
		// allocatable (e.g. when a pod requests a key that no longer exists
		// on that node). The frontend tolerates that; we leave it as-is.
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Node < nodes[j].Node })

	// Pick the universe of resource keys we know about. For non-admins we
	// only saw pods; we still surface the keys the pods consume so the UI
	// has something to render even without node visibility.
	keys := map[string]struct{}{}
	for k := range nodeAlloc {
		keys[k] = struct{}{}
	}
	for k := range usedByKey {
		keys[k] = struct{}{}
	}
	keyList := make([]string, 0, len(keys))
	for k := range keys {
		keyList = append(keyList, k)
	}
	sort.Strings(keyList)

	out.Vendors = groupByVendor(keyList, nodeAlloc, usedByKey)
	out.Nodes = nodes
	out.Pods = podRows

	// Headline summary uses each vendor's "primary" key — that's the
	// physical-card metric (nvidia.com/gpu, amd.com/gpu, …) when present,
	// and the only metric for non-virtualised vendors. This avoids
	// double-counting when HAMi's gpualloc accompanies nvidia.com/gpu.
	for _, v := range out.Vendors {
		out.Summary.Total += v.Counts.Total
		out.Summary.Used += v.Counts.Used
		out.Summary.Available += v.Counts.Available
	}
	return out, nil
}

// isAcceleratorKey returns true for any resource key we want to surface
// on the GPU page. We exclude built-in compute/storage keys but accept
// every vendor-prefixed accelerator key — that's the industry convention
// for device-plugin resources.
func isAcceleratorKey(k string) bool {
	switch k {
	case "cpu", "memory", "pods", "ephemeral-storage":
		return false
	}
	if strings.HasPrefix(k, "hugepages-") || strings.HasPrefix(k, "attachable-volumes-") || strings.HasPrefix(k, "storage-") {
		return false
	}
	// Vendor-specific keys carry a slash — built-ins do not.
	return strings.Contains(k, "/")
}

func quantityToInt64(q resource.Quantity) int64 {
	if v, ok := q.AsInt64(); ok {
		return v
	}
	return q.Value()
}

// vendorOf classifies a resource key into a human-readable vendor label and
// (for HAMi-style multi-key vendors) declares which key is the "primary"
// count — that's the one summed into the headline total to avoid
// double-counting auxiliary keys like gpucores / gpumem.
func vendorOf(key string) (vendor string, primary bool) {
	k := strings.ToLower(key)
	switch {
	case strings.HasPrefix(k, "nvidia.com/"):
		// HAMi exposes nvidia.com/gpualloc + gpucores + gpumem on the same
		// node; gpualloc is the slot count, the others are quantities. When
		// vanilla NVIDIA is in play we just have nvidia.com/gpu.
		switch k {
		case "nvidia.com/gpu", "nvidia.com/gpualloc":
			return "NVIDIA", true
		}
		return "NVIDIA", false
	case strings.HasPrefix(k, "amd.com/"):
		return "AMD", k == "amd.com/gpu"
	case strings.HasPrefix(k, "huawei.com/ascend") || strings.HasPrefix(k, "huawei.com/npu"):
		return "Huawei NPU", true
	case strings.HasPrefix(k, "hami.io/"):
		return "HAMi", k == "hami.io/vgpu"
	case strings.HasPrefix(k, "intel.com/"):
		return "Intel", k == "intel.com/gpu"
	case strings.HasPrefix(k, "aliyun.com/"):
		return "Aliyun", strings.HasSuffix(k, "/gpu")
	case strings.HasPrefix(k, "rocm.amd.com/"):
		return "AMD ROCm", k == "rocm.amd.com/gpu"
	}
	// Fallback: take the part before the slash as the vendor label.
	if i := strings.Index(k, "/"); i > 0 {
		return strings.ToUpper(k[:1]) + k[1:i], true
	}
	return key, true
}

// groupByVendor folds the per-key tallies into one summary row per vendor.
// A vendor's headline counts come from its "primary" key (avoids
// double-counting HAMi's auxiliary cores/mem keys), but byKey carries every
// key so the UI can drill down.
func groupByVendor(keys []string, alloc, used map[string]int64) []VendorSummary {
	bucket := map[string]*VendorSummary{}
	for _, k := range keys {
		vendor, primary := vendorOf(k)
		v, ok := bucket[vendor]
		if !ok {
			v = &VendorSummary{Vendor: vendor, ByKey: map[string]Counts{}}
			bucket[vendor] = v
		}
		v.Keys = append(v.Keys, k)
		c := Counts{Total: alloc[k], Used: used[k], Available: alloc[k] - used[k]}
		if c.Available < 0 {
			// Pod requests can exceed allocatable when pods are pending and
			// will never schedule; surface the headline as 0 rather than
			// negative so the UI stays sane.
			c.Available = 0
		}
		v.ByKey[k] = c
		if primary && v.Primary == "" {
			v.Primary = k
			v.Counts = c
		}
	}
	out := make([]VendorSummary, 0, len(bucket))
	for _, v := range bucket {
		// If no primary was found (rare — only when the vendor exposes only
		// auxiliary keys), pick the first key so the row still has numbers.
		if v.Primary == "" && len(v.Keys) > 0 {
			v.Primary = v.Keys[0]
			v.Counts = v.ByKey[v.Primary]
		}
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Vendor < out[j].Vendor })
	return out
}

// podRowFor extracts the per-container accelerator usage for a pod.
// Returns ok=false when the pod has no accelerator requests.
func podRowFor(pod *corev1.Pod) (PodUsage, bool) {
	row := PodUsage{
		Namespace: pod.Namespace,
		Name:      pod.Name,
		Node:      pod.Spec.NodeName,
		Phase:     string(pod.Status.Phase),
		Resources: map[string]int64{},
	}
	any := false
	for _, c := range pod.Spec.Containers {
		cr := ContainerUsage{Name: c.Name, Resources: map[string]int64{}}
		// Prefer requests; fall back to limits for vendors that only set
		// limits (NVIDIA's plugin technically wants requests==limits, but
		// real-world manifests vary).
		for k, v := range c.Resources.Requests {
			if !isAcceleratorKey(string(k)) {
				continue
			}
			n := quantityToInt64(v)
			cr.Resources[string(k)] = n
			row.Resources[string(k)] += n
			any = true
		}
		for k, v := range c.Resources.Limits {
			if !isAcceleratorKey(string(k)) {
				continue
			}
			if _, has := cr.Resources[string(k)]; has {
				continue
			}
			n := quantityToInt64(v)
			cr.Resources[string(k)] = n
			row.Resources[string(k)] += n
			any = true
		}
		if len(cr.Resources) > 0 {
			row.Containers = append(row.Containers, cr)
		}
	}
	return row, any
}
