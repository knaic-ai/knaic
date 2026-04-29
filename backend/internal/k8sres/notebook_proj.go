package k8sres

import "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

// projectNotebook mirrors data/notebooks.ts Notebook on the frontend. The
// Kubeflow Notebook CRD wraps a PodSpec under spec.template.spec — we walk
// the first container for image / resources, then read the workspace +
// dshm volumes back out so the UI can show them in the table.
func projectNotebook(o *unstructured.Unstructured) Projection {
	p := base(o)

	// Image + resources from spec.template.spec.containers[0].
	c, _ := nestedFirstContainer(o.Object, "spec", "template", "spec", "containers")
	var image string
	cpu, mem, gpu := "", "", int64(0)
	cpuLim, memLim := "", ""
	gpuValues := map[string]any{}
	if c != nil {
		image, _, _ = unstructured.NestedString(c, "image")
		cpu, _, _ = unstructured.NestedString(c, "resources", "requests", "cpu")
		mem, _, _ = unstructured.NestedString(c, "resources", "requests", "memory")
		cpuLim, _, _ = unstructured.NestedString(c, "resources", "limits", "cpu")
		memLim, _, _ = unstructured.NestedString(c, "resources", "limits", "memory")
		if limits, ok, _ := unstructured.NestedMap(c, "resources", "limits"); ok {
			for k, v := range limits {
				if k == "cpu" || k == "memory" {
					continue
				}
				switch tv := v.(type) {
				case int64:
					gpuValues[k] = tv
					gpu += tv
				case string:
					if n := parseInt64Quantity(tv); n > 0 {
						gpuValues[k] = n
						gpu += n
					}
				}
			}
		}
	}

	// Workspace volume + shared memory from spec.template.spec.volumes.
	volume := map[string]any{"kind": "none"}
	sharedMemory := ""
	mountByName := map[string]string{}
	if c != nil {
		mounts, _, _ := unstructured.NestedSlice(c, "volumeMounts")
		for _, raw := range mounts {
			if m, ok := raw.(map[string]any); ok {
				name, _, _ := unstructured.NestedString(m, "name")
				path, _, _ := unstructured.NestedString(m, "mountPath")
				if name != "" {
					mountByName[name] = path
				}
			}
		}
	}
	volumes, _, _ := unstructured.NestedSlice(o.Object, "spec", "template", "spec", "volumes")
	for _, raw := range volumes {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name, _, _ := unstructured.NestedString(m, "name")
		if name == "dshm" {
			if size, ok, _ := unstructured.NestedString(m, "emptyDir", "sizeLimit"); ok {
				sharedMemory = size
			}
			continue
		}
		if pvc, ok, _ := unstructured.NestedString(m, "persistentVolumeClaim", "claimName"); ok && pvc != "" {
			volume = map[string]any{
				"kind":      "existing",
				"pvcName":   pvc,
				"mountPath": mountByName[name],
			}
		}
	}

	// Status: Notebook controller reports a `state` field (Running / Stopped
	// / etc.) on .status. Some versions use conditions only; fall back to
	// "Progressing" if neither is set.
	status, _, _ := unstructured.NestedString(o.Object, "status", "containerState", "running")
	if status != "" {
		status = "Running"
	} else if state, ok, _ := unstructured.NestedString(o.Object, "status", "containerState", "waiting", "reason"); ok && state != "" {
		status = "Progressing"
	}
	if status == "" {
		conds, _, _ := unstructured.NestedSlice(o.Object, "status", "conditions")
		for _, raw := range conds {
			m, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			t, _, _ := unstructured.NestedString(m, "type")
			s, _, _ := unstructured.NestedString(m, "status")
			if t == "Ready" && s == "True" {
				status = "Running"
				break
			}
		}
	}
	if status == "" {
		status = "Progressing"
	}

	owner, _, _ := unstructured.NestedString(o.Object, "metadata", "labels", "knaic.io/owner")
	if owner == "" {
		owner, _, _ = unstructured.NestedString(o.Object, "metadata", "labels", "notebook.kubeflow.org/owner")
	}

	p["image"] = image
	p["cpu"] = cpu
	p["cpuLimit"] = cpuLim
	p["memory"] = mem
	p["memoryLimit"] = memLim
	p["gpu"] = gpu
	if len(gpuValues) > 0 {
		p["gpuValues"] = gpuValues
	}
	p["volume"] = volume
	p["sharedMemory"] = sharedMemory
	p["status"] = status
	p["url"] = "/notebook/" + o.GetNamespace() + "/" + o.GetName() + "/"
	p["owner"] = owner
	return p
}
