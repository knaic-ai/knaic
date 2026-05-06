package k8sres

import (
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// All projections share the same identity preamble.
func base(o *unstructured.Unstructured) Projection {
	return Projection{
		"id":        string(o.GetUID()),
		"name":      o.GetName(),
		"namespace": o.GetNamespace(),
		"createdAt": creationDate(o),
		"labels":    o.GetLabels(),
	}
}

func creationDate(o *unstructured.Unstructured) string {
	t := o.GetCreationTimestamp().Time
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format("2006-01-02")
}

func age(o *unstructured.Unstructured) string {
	t := o.GetCreationTimestamp().Time
	if t.IsZero() {
		return ""
	}
	return shortDuration(time.Since(t))
}

func shortDuration(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "<1m"
	case d < time.Hour:
		return formatInt(int(d.Minutes())) + "m"
	case d < 24*time.Hour:
		return formatInt(int(d.Hours())) + "h"
	default:
		return formatInt(int(d.Hours()/24)) + "d"
	}
}

func formatInt(i int) string {
	if i < 0 {
		i = 0
	}
	if i == 0 {
		return "0"
	}
	var b strings.Builder
	digits := []byte{}
	for i > 0 {
		digits = append(digits, byte('0'+i%10))
		i /= 10
	}
	for j := len(digits) - 1; j >= 0; j-- {
		b.WriteByte(digits[j])
	}
	return b.String()
}

// ---- Deployment / StatefulSet -------------------------------------------

func projectDeployment(o *unstructured.Unstructured) Projection {
	p := base(o)
	replicas, _, _ := unstructured.NestedInt64(o.Object, "spec", "replicas")
	ready, _, _ := unstructured.NestedInt64(o.Object, "status", "readyReplicas")
	avail, _, _ := unstructured.NestedInt64(o.Object, "status", "availableReplicas")
	image := firstContainerImage(o)
	p["replicas"] = replicas
	p["readyReplicas"] = ready
	p["image"] = image
	p["status"] = deploymentStatus(replicas, ready, avail)
	return p
}

func projectStatefulSet(o *unstructured.Unstructured) Projection {
	p := base(o)
	replicas, _, _ := unstructured.NestedInt64(o.Object, "spec", "replicas")
	ready, _, _ := unstructured.NestedInt64(o.Object, "status", "readyReplicas")
	svc, _, _ := unstructured.NestedString(o.Object, "spec", "serviceName")
	image := firstContainerImage(o)
	p["replicas"] = replicas
	p["readyReplicas"] = ready
	p["image"] = image
	p["serviceName"] = svc
	p["status"] = deploymentStatus(replicas, ready, ready)
	return p
}

func deploymentStatus(replicas, ready, avail int64) string {
	switch {
	case ready == replicas && avail == replicas:
		return "Running"
	case ready < replicas:
		return "Progressing"
	default:
		return "Progressing"
	}
}

// firstContainerImage returns the .spec.template.spec.containers[0].image,
// falling back to .spec.containers (Pods don't have a template).
func firstContainerImage(o *unstructured.Unstructured) string {
	if c, ok := nestedFirstContainer(o.Object, "spec", "template", "spec", "containers"); ok {
		image, _, _ := unstructured.NestedString(c, "image")
		return image
	}
	if c, ok := nestedFirstContainer(o.Object, "spec", "containers"); ok {
		image, _, _ := unstructured.NestedString(c, "image")
		return image
	}
	return ""
}

func nestedFirstContainer(obj map[string]any, fields ...string) (map[string]any, bool) {
	list, ok, _ := unstructured.NestedSlice(obj, fields...)
	if !ok || len(list) == 0 {
		return nil, false
	}
	first, ok := list[0].(map[string]any)
	if !ok {
		return nil, false
	}
	return first, true
}

// ---- Pod -----------------------------------------------------------------

func projectPod(o *unstructured.Unstructured) Projection {
	p := base(o)
	phase, _, _ := unstructured.NestedString(o.Object, "status", "phase")
	node, _, _ := unstructured.NestedString(o.Object, "spec", "nodeName")
	ip, _, _ := unstructured.NestedString(o.Object, "status", "podIP")

	containers, _, _ := unstructured.NestedSlice(o.Object, "spec", "containers")
	cnames := make([]string, 0, len(containers))
	for _, c := range containers {
		if m, ok := c.(map[string]any); ok {
			if name, _, _ := unstructured.NestedString(m, "name"); name != "" {
				cnames = append(cnames, name)
			}
		}
	}

	restarts := podRestarts(o)
	owner := podOwner(o)

	p["status"] = mapPodPhase(phase, o)
	p["node"] = node
	p["ip"] = ip
	p["restarts"] = restarts
	p["age"] = age(o)
	p["containers"] = cnames
	if owner != "" {
		p["ownerRef"] = owner
	}
	return p
}

func podRestarts(o *unstructured.Unstructured) int64 {
	statuses, _, _ := unstructured.NestedSlice(o.Object, "status", "containerStatuses")
	var total int64
	for _, s := range statuses {
		m, ok := s.(map[string]any)
		if !ok {
			continue
		}
		r, _, _ := unstructured.NestedInt64(m, "restartCount")
		total += r
	}
	return total
}

// mapPodPhase translates the K8s phase + waiting-state into the simpler set
// the frontend uses: Running / Pending / Failed / CrashLoopBackOff.
func mapPodPhase(phase string, o *unstructured.Unstructured) string {
	statuses, _, _ := unstructured.NestedSlice(o.Object, "status", "containerStatuses")
	for _, s := range statuses {
		m, ok := s.(map[string]any)
		if !ok {
			continue
		}
		reason, _, _ := unstructured.NestedString(m, "state", "waiting", "reason")
		if reason == "CrashLoopBackOff" {
			return "CrashLoopBackOff"
		}
	}
	switch phase {
	case "Running", "Succeeded":
		return "Running"
	case "Pending":
		return "Pending"
	case "Failed", "Unknown":
		return "Failed"
	default:
		return phase
	}
}

func podOwner(o *unstructured.Unstructured) string {
	owners := o.GetOwnerReferences()
	if len(owners) == 0 {
		return ""
	}
	return owners[0].Kind + "/" + owners[0].Name
}

// ---- Service / ConfigMap / Secret / PVC ---------------------------------

func projectService(o *unstructured.Unstructured) Projection {
	p := base(o)
	typ, _, _ := unstructured.NestedString(o.Object, "spec", "type")
	clusterIP, _, _ := unstructured.NestedString(o.Object, "spec", "clusterIP")
	selector, _, _ := unstructured.NestedStringMap(o.Object, "spec", "selector")
	rawPorts, _, _ := unstructured.NestedSlice(o.Object, "spec", "ports")
	ports := make([]map[string]any, 0, len(rawPorts))
	for _, raw := range rawPorts {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		port, _, _ := unstructured.NestedInt64(m, "port")
		proto, _, _ := unstructured.NestedString(m, "protocol")
		name, _, _ := unstructured.NestedString(m, "name")
		// targetPort can be int or string ("name") — present whichever exists.
		var target any
		if v, ok, _ := unstructured.NestedInt64(m, "targetPort"); ok {
			target = v
		} else if v, ok, _ := unstructured.NestedString(m, "targetPort"); ok {
			target = v
		} else {
			target = port
		}
		entry := map[string]any{"port": port, "targetPort": target, "protocol": proto}
		if name != "" {
			entry["name"] = name
		}
		ports = append(ports, entry)
	}
	if selector == nil {
		selector = map[string]string{}
	}
	p["type"] = typ
	p["clusterIP"] = clusterIP
	p["selector"] = selector
	p["ports"] = ports
	return p
}

func projectConfigMap(o *unstructured.Unstructured) Projection {
	p := base(o)
	data, _, _ := unstructured.NestedStringMap(o.Object, "data")
	if data == nil {
		data = map[string]string{}
	}
	p["data"] = data
	return p
}

// projectSecret returns key names + type only — values are deliberately not
// surfaced. Callers that need to view secret values must hit /yaml on a
// platform-admin token, which the upstream API server will gate.
func projectSecret(o *unstructured.Unstructured) Projection {
	p := base(o)
	typ, _, _ := unstructured.NestedString(o.Object, "type")
	if typ == "" {
		typ = "Opaque"
	}
	dataMap, _, _ := unstructured.NestedMap(o.Object, "data")
	keys := make([]string, 0, len(dataMap))
	for k := range dataMap {
		keys = append(keys, k)
	}
	p["type"] = typ
	p["keys"] = keys
	return p
}

func projectPVC(o *unstructured.Unstructured) Projection {
	p := base(o)
	phase, _, _ := unstructured.NestedString(o.Object, "status", "phase")
	storageClass, _, _ := unstructured.NestedString(o.Object, "spec", "storageClassName")
	volumeName, _, _ := unstructured.NestedString(o.Object, "spec", "volumeName")
	modes, _, _ := unstructured.NestedStringSlice(o.Object, "spec", "accessModes")
	access := strings.Join(modes, ",")
	if access == "" {
		access = "RWO"
	}
	capacity, _, _ := unstructured.NestedString(o.Object, "status", "capacity", "storage")
	if capacity == "" {
		capacity, _, _ = unstructured.NestedString(o.Object, "spec", "resources", "requests", "storage")
	}
	p["status"] = phase
	p["storageClass"] = storageClass
	p["volumeName"] = volumeName
	p["accessMode"] = access
	p["capacity"] = capacity
	return p
}

// ---- Gateway API --------------------------------------------------------

func projectGateway(o *unstructured.Unstructured) Projection {
	p := base(o)
	className, _, _ := unstructured.NestedString(o.Object, "spec", "gatewayClassName")
	rawListeners, _, _ := unstructured.NestedSlice(o.Object, "spec", "listeners")
	listeners := make([]map[string]any, 0, len(rawListeners))
	for _, raw := range rawListeners {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name, _, _ := unstructured.NestedString(m, "name")
		port, _, _ := unstructured.NestedInt64(m, "port")
		proto, _, _ := unstructured.NestedString(m, "protocol")
		hostname, _, _ := unstructured.NestedString(m, "hostname")
		entry := map[string]any{"name": name, "port": port, "protocol": proto}
		if hostname != "" {
			entry["hostname"] = hostname
		}
		listeners = append(listeners, entry)
	}
	rawAddrs, _, _ := unstructured.NestedSlice(o.Object, "status", "addresses")
	addrs := make([]string, 0, len(rawAddrs))
	for _, raw := range rawAddrs {
		if m, ok := raw.(map[string]any); ok {
			if v, _, _ := unstructured.NestedString(m, "value"); v != "" {
				addrs = append(addrs, v)
			}
		}
	}
	p["gatewayClassName"] = className
	p["listeners"] = listeners
	p["addresses"] = addrs
	p["status"] = gatewayStatus(o)
	return p
}

func gatewayStatus(o *unstructured.Unstructured) string {
	conditions, _, _ := unstructured.NestedSlice(o.Object, "status", "conditions")
	for _, raw := range conditions {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		t, _, _ := unstructured.NestedString(m, "type")
		s, _, _ := unstructured.NestedString(m, "status")
		if t == "Accepted" && s == "True" {
			return "Accepted"
		}
		if t == "Programmed" && s == "False" {
			return "Failed"
		}
	}
	return "Pending"
}

func projectHTTPRoute(o *unstructured.Unstructured) Projection {
	p := base(o)
	parents, _, _ := unstructured.NestedSlice(o.Object, "spec", "parentRefs")
	parent := ""
	if len(parents) > 0 {
		if m, ok := parents[0].(map[string]any); ok {
			parent, _, _ = unstructured.NestedString(m, "name")
		}
	}
	hostnames, _, _ := unstructured.NestedStringSlice(o.Object, "spec", "hostnames")
	rawRules, _, _ := unstructured.NestedSlice(o.Object, "spec", "rules")
	rules := make([]map[string]any, 0, len(rawRules))
	for _, raw := range rawRules {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		matches, _, _ := unstructured.NestedSlice(m, "matches")
		pathPrefix := "/"
		if len(matches) > 0 {
			if mm, ok := matches[0].(map[string]any); ok {
				v, _, _ := unstructured.NestedString(mm, "path", "value")
				if v != "" {
					pathPrefix = v
				}
			}
		}
		backends, _, _ := unstructured.NestedSlice(m, "backendRefs")
		var backend string
		var port int64
		if len(backends) > 0 {
			if bm, ok := backends[0].(map[string]any); ok {
				backend, _, _ = unstructured.NestedString(bm, "name")
				port, _, _ = unstructured.NestedInt64(bm, "port")
			}
		}
		rules = append(rules, map[string]any{
			"pathPrefix":     pathPrefix,
			"backendService": backend,
			"port":           port,
		})
	}
	p["parentGateway"] = parent
	p["hostnames"] = hostnames
	p["rules"] = rules
	return p
}

func projectGatewayClass(o *unstructured.Unstructured) Projection {
	p := base(o)
	controller, _, _ := unstructured.NestedString(o.Object, "spec", "controllerName")
	p["controllerName"] = controller
	p["status"] = gatewayStatus(o)
	return p
}
