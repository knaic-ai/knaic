package k8sres

import (
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// projectTrainingRuntime mirrors data/training.ts TrainingRuntime. The
// Kubeflow Trainer v2 TrainingRuntime CRD wraps a JobSet template; we walk
// the first replica → first container for image and resource hints, and
// pull the framework label.
func projectTrainingRuntime(o *unstructured.Unstructured) Projection {
	p := base(o)
	framework := frameworkOf(o)
	image, cpu, memory, gpu := firstReplicatedJobContainer(o)
	numNodes := nodesFor(o)
	p["framework"] = framework
	p["image"] = image
	p["numNodes"] = numNodes
	p["resourcesPerNode"] = map[string]any{"cpu": cpu, "memory": memory, "gpu": gpu}
	p["builtin"] = false
	return p
}

// projectTrainJob mirrors data/training.ts TrainJob. The Trainer v2 TrainJob
// CRD references a runtime by name and overlays trainer-specific fields
// (resources, command/args/env). MLflow tracking metadata is stashed in
// annotations so the dashboard tab can find it without a sidecar fetch.
func projectTrainJob(o *unstructured.Unstructured) Projection {
	p := base(o)
	runtime, _, _ := unstructured.NestedString(o.Object, "spec", "runtimeRef", "name")
	if runtime == "" {
		runtime, _, _ = unstructured.NestedString(o.Object, "spec", "trainingRuntimeRef", "name")
	}
	numNodes, _, _ := unstructured.NestedInt64(o.Object, "spec", "trainer", "numNodes")
	if numNodes == 0 {
		numNodes = 1
	}
	command, _, _ := unstructured.NestedStringSlice(o.Object, "spec", "trainer", "command")
	args, _, _ := unstructured.NestedStringSlice(o.Object, "spec", "trainer", "args")
	env := envSlice(o, "spec", "trainer", "env")

	cpu, _, _ := unstructured.NestedString(o.Object, "spec", "trainer", "resourcesPerNode", "requests", "cpu")
	memory, _, _ := unstructured.NestedString(o.Object, "spec", "trainer", "resourcesPerNode", "requests", "memory")
	cpuLim, _, _ := unstructured.NestedString(o.Object, "spec", "trainer", "resourcesPerNode", "limits", "cpu")
	memLim, _, _ := unstructured.NestedString(o.Object, "spec", "trainer", "resourcesPerNode", "limits", "memory")
	gpuValues := map[string]any{}
	if limits, ok, _ := unstructured.NestedMap(o.Object, "spec", "trainer", "resourcesPerNode", "limits"); ok {
		for k, v := range limits {
			if k == "cpu" || k == "memory" {
				continue
			}
			switch tv := v.(type) {
			case int64:
				gpuValues[k] = tv
			case string:
				if n := parseInt64Quantity(tv); n > 0 {
					gpuValues[k] = n
				}
			}
		}
	}

	modelUri, _, _ := unstructured.NestedString(o.Object, "spec", "trainer", "modelConfig", "input", "storageUri")
	datasetUri, _, _ := unstructured.NestedString(o.Object, "spec", "trainer", "datasetConfig", "input", "storageUri")

	p["runtime"] = runtime
	p["numNodes"] = numNodes
	p["command"] = command
	if len(args) > 0 {
		p["args"] = args
	}
	if len(env) > 0 {
		p["env"] = env
	}
	p["cpu"] = cpu
	p["cpuLimit"] = cpuLim
	p["memory"] = memory
	p["memoryLimit"] = memLim
	if len(gpuValues) > 0 {
		p["gpuValues"] = gpuValues
	}
	if modelUri != "" {
		p["modelUri"] = modelUri
	}
	if datasetUri != "" {
		p["datasetUri"] = datasetUri
	}
	p["status"], p["progress"] = trainJobStatus(o)
	if start := o.GetCreationTimestamp().Time; !start.IsZero() {
		p["startTime"] = start.UTC().Format(time.RFC3339)
		p["duration"] = formatDuration(time.Since(start))
	}
	if mlflow := mlflowFromAnnotations(o); mlflow != nil {
		p["mlflow"] = mlflow
	}
	return p
}

// frameworkOf reads spec.mlPolicy.{torch,deepspeed,mpi,tensorflow,jax}, or
// falls back to a label.
func frameworkOf(o *unstructured.Unstructured) string {
	if pol, ok, _ := unstructured.NestedMap(o.Object, "spec", "mlPolicy"); ok {
		for _, k := range []string{"torch", "deepspeed", "mpi", "tensorflow", "jax"} {
			if _, present := pol[k]; present {
				return k
			}
		}
	}
	if v, _, _ := unstructured.NestedString(o.Object, "metadata", "labels", "knaic.io/framework"); v != "" {
		return v
	}
	return "torch"
}

func nodesFor(o *unstructured.Unstructured) int64 {
	if v, ok, _ := unstructured.NestedInt64(o.Object, "spec", "numNodes"); ok && v > 0 {
		return v
	}
	if v, ok, _ := unstructured.NestedInt64(o.Object, "spec", "mlPolicy", "numNodes"); ok && v > 0 {
		return v
	}
	return 1
}

// firstReplicatedJobContainer drills into the JobSet template embedded in the
// runtime spec to surface the trainer container's image + resource hints.
// With pre-jobs (dataset/model initializers) sharing the replicatedJob list,
// the "first" replicatedJob isn't necessarily the trainer — we prefer the
// one carrying the `trainer.kubeflow.org/trainjob-ancestor-step: trainer`
// label, then fall back to one named "node" or "trainer", then the last
// entry (matches the dependsOn chain knaic emits), and finally the very
// first as a last resort for legacy runtimes.
func firstReplicatedJobContainer(o *unstructured.Unstructured) (image, cpu, memory string, gpu int64) {
	jobs, _, _ := unstructured.NestedSlice(o.Object, "spec", "template", "spec", "replicatedJobs")
	if len(jobs) == 0 {
		return
	}
	pickJob := func() map[string]any {
		var named, last map[string]any
		for _, raw := range jobs {
			m, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			last = m
			label, _, _ := unstructured.NestedString(m, "template", "metadata", "labels", "trainer.kubeflow.org/trainjob-ancestor-step")
			if label == "trainer" {
				return m
			}
			if name, _, _ := unstructured.NestedString(m, "name"); name == "node" || name == "trainer" {
				if named == nil {
					named = m
				}
			}
		}
		if named != nil {
			return named
		}
		if last != nil {
			return last
		}
		m, _ := jobs[0].(map[string]any)
		return m
	}
	m := pickJob()
	if m == nil {
		return
	}
	c, ok := nestedFirstContainer(m, "template", "spec", "template", "spec", "containers")
	if !ok || c == nil {
		return
	}
	image, _, _ = unstructured.NestedString(c, "image")
	cpu, _, _ = unstructured.NestedString(c, "resources", "limits", "cpu")
	memory, _, _ = unstructured.NestedString(c, "resources", "limits", "memory")
	if v, ok, _ := unstructured.NestedInt64(c, "resources", "limits", "nvidia.com/gpu"); ok {
		gpu = v
	} else if s, ok, _ := unstructured.NestedString(c, "resources", "limits", "nvidia.com/gpu"); ok {
		gpu = parseInt64Quantity(s)
	}
	return
}

// envSlice returns []{name,value} as map slices, robust to either the standard
// PodSpec env shape or a flattened map.
func envSlice(o *unstructured.Unstructured, fields ...string) []map[string]any {
	raw, _, _ := unstructured.NestedSlice(o.Object, fields...)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _, _ := unstructured.NestedString(m, "name")
		value, _, _ := unstructured.NestedString(m, "value")
		out = append(out, map[string]any{"name": name, "value": value})
	}
	return out
}

func trainJobStatus(o *unstructured.Unstructured) (string, int64) {
	conds, _, _ := unstructured.NestedSlice(o.Object, "status", "conditions")
	state := "Pending"
	for _, raw := range conds {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		t, _, _ := unstructured.NestedString(m, "type")
		s, _, _ := unstructured.NestedString(m, "status")
		if s != "True" {
			continue
		}
		switch t {
		case "Created", "Running":
			state = "Running"
		case "Complete", "Succeeded":
			state = "Succeeded"
		case "Failed":
			state = "Failed"
		}
	}
	progress, _, _ := unstructured.NestedInt64(o.Object, "status", "progress")
	if progress == 0 && state == "Succeeded" {
		progress = 100
	}
	return state, progress
}

// mlflowFromAnnotations picks up tracking metadata stamped on the TrainJob.
// Empty strings collapse the whole block so the projector returns nil and
// the UI hides the MLflow tab.
func mlflowFromAnnotations(o *unstructured.Unstructured) map[string]any {
	ann := o.GetAnnotations()
	tracking := ann["mlflow.knaic.io/tracking-uri"]
	experiment := ann["mlflow.knaic.io/experiment"]
	runID := ann["mlflow.knaic.io/run-id"]
	if tracking == "" && experiment == "" && runID == "" {
		return nil
	}
	return map[string]any{
		"trackingUri": tracking,
		"experiment":  experiment,
		"runId":       runID,
		"samples":     []any{}, // populated by /training/jobs/{name}/mlflow
	}
}

func formatDuration(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	hours := int(d.Hours())
	mins := int(d.Minutes()) % 60
	return strings.Join([]string{
		twoDigit(hours) + "h",
		twoDigit(mins) + "m",
	}, " ")
}

func twoDigit(i int) string {
	if i < 10 {
		return "0" + formatInt(i)
	}
	return formatInt(i)
}
