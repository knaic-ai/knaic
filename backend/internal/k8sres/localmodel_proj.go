package k8sres

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// projectLocalModelNodeGroup surfaces the fields the LocalModelCache page
// renders for a NodeGroup row: storage limit, the on-host model path (which
// must match the agent DaemonSet's `models` hostPath), storage class, a
// summary of the node affinity, and the controller-reported usage. The full
// PV/PVC templates are not surfaced — admins who need them open the YAML.
func projectLocalModelNodeGroup(o *unstructured.Unstructured) Projection {
	p := base(o)
	storageLimit, _, _ := unstructured.NestedString(o.Object, "spec", "storageLimit")
	if storageLimit == "" {
		// storageLimit is a Quantity; the apiserver typically serialises it
		// as a string, but accept an int64 just in case.
		if n, ok, _ := unstructured.NestedInt64(o.Object, "spec", "storageLimit"); ok {
			storageLimit = formatInt(int(n))
		}
	}
	hostPath, _, _ := unstructured.NestedString(o.Object, "spec", "persistentVolumeSpec", "local", "path")
	storageClass, _, _ := unstructured.NestedString(o.Object, "spec", "persistentVolumeSpec", "storageClassName")
	pvcStorageClass, _, _ := unstructured.NestedString(o.Object, "spec", "persistentVolumeClaimSpec", "storageClassName")
	if storageClass == "" {
		storageClass = pvcStorageClass
	}
	used, _, _ := unstructured.NestedString(o.Object, "status", "used")
	avail, _, _ := unstructured.NestedString(o.Object, "status", "available")

	// Flatten the first nodeAffinity matchExpression into a {key, op, values}
	// summary so the table can show "kubernetes.io/hostname In [worker-0,worker-1]"
	// without rendering the entire affinity tree.
	selectorKey, selectorOp := "", ""
	var selectorValues []string
	if terms, ok, _ := unstructured.NestedSlice(o.Object,
		"spec", "persistentVolumeSpec", "nodeAffinity", "required", "nodeSelectorTerms",
	); ok && len(terms) > 0 {
		if term, _ := terms[0].(map[string]any); term != nil {
			if exprs, _, _ := unstructured.NestedSlice(term, "matchExpressions"); len(exprs) > 0 {
				if e, _ := exprs[0].(map[string]any); e != nil {
					selectorKey, _, _ = unstructured.NestedString(e, "key")
					selectorOp, _, _ = unstructured.NestedString(e, "operator")
					if vs, _, _ := unstructured.NestedStringSlice(e, "values"); len(vs) > 0 {
						selectorValues = vs
					}
				}
			}
		}
	}

	p["storageLimit"] = storageLimit
	p["hostPath"] = hostPath
	p["storageClassName"] = storageClass
	p["used"] = used
	p["available"] = avail
	p["selectorKey"] = selectorKey
	p["selectorOp"] = selectorOp
	p["selectorValues"] = selectorValues
	p["age"] = age(o)
	return p
}

// projectLocalModelCache surfaces the cache name + source URI + size + which
// node groups it targets, plus the per-node download status (used to render
// the expandable row in the UI). KServe records each node's progress under
// `status.nodeStatus[nodeName]` as a string state like "NodeDownloaded".
func projectLocalModelCache(o *unstructured.Unstructured) Projection {
	p := base(o)
	source, _, _ := unstructured.NestedString(o.Object, "spec", "sourceModelUri")
	modelSize, _, _ := unstructured.NestedString(o.Object, "spec", "modelSize")
	nodeGroups, _, _ := unstructured.NestedStringSlice(o.Object, "spec", "nodeGroups")

	// status.nodeStatus is a map of node-name → state string. Project as a
	// stable []{node, state} slice — JSON map ordering isn't guaranteed, but
	// the React table sorts by node name anyway.
	var nodeStatus []map[string]any
	if m, ok, _ := unstructured.NestedMap(o.Object, "status", "nodeStatus"); ok {
		for name, raw := range m {
			state, _ := raw.(string)
			nodeStatus = append(nodeStatus, map[string]any{
				"node":  name,
				"state": state,
			})
		}
	}

	// status.copies = {available, total}
	copiesAvail, _, _ := unstructured.NestedInt64(o.Object, "status", "copies", "available")
	copiesTotal, _, _ := unstructured.NestedInt64(o.Object, "status", "copies", "total")

	// status.inferenceServices = [{name, namespace}]
	var infSvcs []map[string]any
	if raw, _, _ := unstructured.NestedSlice(o.Object, "status", "inferenceServices"); len(raw) > 0 {
		for _, item := range raw {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			name, _, _ := unstructured.NestedString(m, "name")
			ns, _, _ := unstructured.NestedString(m, "namespace")
			if name == "" {
				continue
			}
			infSvcs = append(infSvcs, map[string]any{"name": name, "namespace": ns})
		}
	}

	p["sourceModelUri"] = source
	p["modelSize"] = modelSize
	p["nodeGroups"] = nodeGroups
	p["nodeStatus"] = nodeStatus
	p["copiesAvailable"] = copiesAvail
	p["copiesTotal"] = copiesTotal
	p["inferenceServices"] = infSvcs
	p["age"] = age(o)
	return p
}
