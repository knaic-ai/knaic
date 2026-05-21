package aistorage

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestStartViewer_CreatesDeploymentAndService(t *testing.T) {
	ctx := context.Background()
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "data", Namespace: "ns1"},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("10Gi")},
			},
		},
	}
	svc := New(fake.NewSimpleClientset(pvc))

	status, err := svc.StartViewer(ctx, "ns1", "data", PVCViewerOptions{})
	if err != nil {
		t.Fatalf("StartViewer: %v", err)
	}
	if !status.Running || status.Deployment != "pvcv-data" || status.Service != "pvcv-data" {
		t.Fatalf("unexpected status: %#v", status)
	}
	if status.ViewerPath == "" {
		t.Fatalf("status.ViewerPath should not be empty")
	}

	dp, err := svc.typed.AppsV1().Deployments("ns1").Get(ctx, "pvcv-data", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("Deployment not created: %v", err)
	}
	if dp.Labels[labelPVC] != "data" {
		t.Fatalf("missing PVC label: %#v", dp.Labels)
	}
	if len(dp.Spec.Template.Spec.Volumes) != 1 || dp.Spec.Template.Spec.Volumes[0].PersistentVolumeClaim == nil {
		t.Fatalf("Deployment missing PVC volume mount: %#v", dp.Spec.Template.Spec.Volumes)
	}
	if dp.Spec.Template.Spec.Volumes[0].PersistentVolumeClaim.ClaimName != "data" {
		t.Fatalf("wrong claim name in deployment: %#v", dp.Spec.Template.Spec.Volumes[0].PersistentVolumeClaim)
	}

	if _, err := svc.typed.CoreV1().Services("ns1").Get(ctx, "pvcv-data", metav1.GetOptions{}); err != nil {
		t.Fatalf("Service not created: %v", err)
	}
}

func TestStartViewer_Idempotent(t *testing.T) {
	ctx := context.Background()
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "data", Namespace: "ns1"},
	}
	svc := New(fake.NewSimpleClientset(pvc))

	if _, err := svc.StartViewer(ctx, "ns1", "data", PVCViewerOptions{}); err != nil {
		t.Fatalf("first StartViewer: %v", err)
	}
	if _, err := svc.StartViewer(ctx, "ns1", "data", PVCViewerOptions{}); err != nil {
		t.Fatalf("second StartViewer (idempotent): %v", err)
	}

	dps, _ := svc.typed.AppsV1().Deployments("ns1").List(ctx, metav1.ListOptions{})
	if len(dps.Items) != 1 {
		t.Fatalf("expected 1 deployment after two starts, got %d", len(dps.Items))
	}
}

func TestStartViewer_PropagatesNotFound(t *testing.T) {
	ctx := context.Background()
	svc := New(fake.NewSimpleClientset())
	if _, err := svc.StartViewer(ctx, "ns1", "missing", PVCViewerOptions{}); err == nil {
		t.Fatalf("expected error when PVC does not exist")
	}
}

func TestStopViewer_RemovesDeploymentAndService(t *testing.T) {
	ctx := context.Background()
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "data", Namespace: "ns1"},
	}
	svc := New(fake.NewSimpleClientset(pvc))
	if _, err := svc.StartViewer(ctx, "ns1", "data", PVCViewerOptions{}); err != nil {
		t.Fatalf("StartViewer: %v", err)
	}

	if err := svc.StopViewer(ctx, "ns1", "data"); err != nil {
		t.Fatalf("StopViewer: %v", err)
	}
	if _, err := svc.typed.AppsV1().Deployments("ns1").Get(ctx, "pvcv-data", metav1.GetOptions{}); err == nil {
		t.Fatalf("Deployment should be gone")
	}
	if _, err := svc.typed.CoreV1().Services("ns1").Get(ctx, "pvcv-data", metav1.GetOptions{}); err == nil {
		t.Fatalf("Service should be gone")
	}
}

func TestStopViewer_IdempotentWhenAbsent(t *testing.T) {
	ctx := context.Background()
	svc := New(fake.NewSimpleClientset())
	// Should NOT error — Stop on a never-started PVC is a no-op so the
	// HTTP handler can stay simple.
	if err := svc.StopViewer(ctx, "ns1", "ghost"); err != nil {
		t.Fatalf("StopViewer on absent: %v", err)
	}
}

func TestViewerName_Truncation(t *testing.T) {
	short := viewerName("data")
	if short != "pvcv-data" {
		t.Fatalf("short name = %q, want pvcv-data", short)
	}
	long := viewerName("a-very-long-pvc-name-that-blows-the-dns-1123-label-cap-easily")
	if len(long) > 63 {
		t.Fatalf("viewerName must fit into a DNS-1123 label (63 chars); got %d (%q)", len(long), long)
	}
	if !startsWith(long, "pvcv-") {
		t.Fatalf("viewerName must keep the prefix: %q", long)
	}
}

func startsWith(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

func TestListPVCs_TagsViewerState(t *testing.T) {
	ctx := context.Background()
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "data", Namespace: "ns1"},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("5Gi")},
			},
		},
		Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
	svc := New(fake.NewSimpleClientset(pvc))

	// Before viewer: empty
	pre, err := svc.ListPVCs(ctx, "ns1")
	if err != nil {
		t.Fatalf("ListPVCs: %v", err)
	}
	if len(pre) != 1 || pre[0].Viewer != "" {
		t.Fatalf("pre-start: viewer should be empty: %#v", pre)
	}

	// Start the viewer; fake client won't tick the readyReplicas field on
	// its own, so the entry should be tagged "running" (not "ready").
	if _, err := svc.StartViewer(ctx, "ns1", "data", PVCViewerOptions{}); err != nil {
		t.Fatalf("StartViewer: %v", err)
	}
	got, err := svc.ListPVCs(ctx, "ns1")
	if err != nil {
		t.Fatalf("ListPVCs: %v", err)
	}
	if len(got) != 1 || got[0].Viewer != "running" {
		t.Fatalf("post-start viewer = %q, want running: %#v", got[0].Viewer, got)
	}
	if got[0].Capacity != "5Gi" {
		t.Fatalf("capacity projection wrong: %q", got[0].Capacity)
	}
}

func TestCreatePVC_ValidatesCapacity(t *testing.T) {
	ctx := context.Background()
	svc := New(fake.NewSimpleClientset())

	if _, err := svc.CreatePVC(ctx, "ns1", CreatePVCRequest{}); err == nil {
		t.Fatalf("expected error for empty request")
	}
	if _, err := svc.CreatePVC(ctx, "ns1", CreatePVCRequest{Name: "p", Capacity: "not-a-quantity"}); err == nil {
		t.Fatalf("expected error for invalid capacity")
	}
	got, err := svc.CreatePVC(ctx, "ns1", CreatePVCRequest{Name: "p", Capacity: "10Gi"})
	if err != nil {
		t.Fatalf("CreatePVC: %v", err)
	}
	if got.Capacity != "10Gi" {
		t.Fatalf("got.Capacity = %q, want 10Gi", got.Capacity)
	}
}

func TestDeletePVC_StopsViewer(t *testing.T) {
	ctx := context.Background()
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "data", Namespace: "ns1"},
	}
	svc := New(fake.NewSimpleClientset(pvc))
	if _, err := svc.StartViewer(ctx, "ns1", "data", PVCViewerOptions{}); err != nil {
		t.Fatalf("StartViewer: %v", err)
	}
	if err := svc.DeletePVC(ctx, "ns1", "data"); err != nil {
		t.Fatalf("DeletePVC: %v", err)
	}
	if _, err := svc.typed.AppsV1().Deployments("ns1").Get(ctx, "pvcv-data", metav1.GetOptions{}); err == nil {
		t.Fatalf("DeletePVC must tear down the viewer Deployment first")
	}
}
