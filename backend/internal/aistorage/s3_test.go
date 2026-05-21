package aistorage

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestCreateS3Secret_LayoutAndAnnotations(t *testing.T) {
	ctx := context.Background()
	svc := New(fake.NewSimpleClientset())

	got, err := svc.CreateS3Secret(ctx, "ns1", CreateS3SecretRequest{
		Name:            "my-s3",
		Kind:            S3KindCompatible,
		Endpoint:        "minio.example.com:9000",
		Region:          "cn-north",
		UseHTTPS:        true,
		Bucket:          "team-data",
		AccessKeyID:     "AKID",
		SecretAccessKey: "SAK",
	})
	if err != nil {
		t.Fatalf("CreateS3Secret: %v", err)
	}
	if got.Name != "my-s3" || got.Bucket != "team-data" || !got.UseHTTPS {
		t.Fatalf("projection mismatch: %#v", got)
	}

	// Inspect the raw Secret to verify KServe-compatible annotations
	// landed where the storage-initializer expects them.
	raw, err := svc.typed.CoreV1().Secrets("ns1").Get(ctx, "my-s3", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get raw secret: %v", err)
	}
	if raw.Annotations[annS3Endpoint] != "minio.example.com:9000" {
		t.Fatalf("missing s3-endpoint annotation: %#v", raw.Annotations)
	}
	if raw.Annotations[annS3UseHTTPS] != "1" {
		t.Fatalf("usehttps annotation = %q, want 1", raw.Annotations[annS3UseHTTPS])
	}
	if string(raw.Data["AWS_ACCESS_KEY_ID"]) != "AKID" || string(raw.Data["AWS_SECRET_ACCESS_KEY"]) != "SAK" {
		t.Fatalf("keys not stored in Data: %v", raw.Data)
	}
	if raw.Labels[labelKind] != "s3" || raw.Labels[labelComponent] != componentValue {
		t.Fatalf("missing component/kind labels: %v", raw.Labels)
	}
}

func TestCreateS3Secret_CreatesServiceAccount(t *testing.T) {
	ctx := context.Background()
	svc := New(fake.NewSimpleClientset())

	if _, err := svc.CreateS3Secret(ctx, "ns1", CreateS3SecretRequest{
		Name:            "with-sa",
		Kind:            S3KindCompatible,
		Endpoint:        "minio.example.com:9000",
		AccessKeyID:     "k",
		SecretAccessKey: "s",
		ServiceAccount:  "sa-s3",
	}); err != nil {
		t.Fatalf("CreateS3Secret: %v", err)
	}

	sa, err := svc.typed.CoreV1().ServiceAccounts("ns1").Get(ctx, "sa-s3", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("expected SA to be created: %v", err)
	}
	found := false
	for _, ref := range sa.Secrets {
		if ref.Name == "with-sa" {
			found = true
		}
	}
	if !found {
		t.Fatalf("SA missing secret reference: %#v", sa.Secrets)
	}
}

func TestCreateS3Secret_AttachesToExistingServiceAccount(t *testing.T) {
	ctx := context.Background()
	existing := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{Name: "sa-shared", Namespace: "ns1"},
		Secrets:    []corev1.ObjectReference{{Name: "other-secret"}},
	}
	svc := New(fake.NewSimpleClientset(existing))

	if _, err := svc.CreateS3Secret(ctx, "ns1", CreateS3SecretRequest{
		Name:            "second",
		Kind:            S3KindCompatible,
		Endpoint:        "minio.example.com:9000",
		AccessKeyID:     "k",
		SecretAccessKey: "s",
		ServiceAccount:  "sa-shared",
	}); err != nil {
		t.Fatalf("CreateS3Secret: %v", err)
	}

	sa, err := svc.typed.CoreV1().ServiceAccounts("ns1").Get(ctx, "sa-shared", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get sa: %v", err)
	}
	if len(sa.Secrets) != 2 {
		t.Fatalf("expected 2 secret refs on SA, got %d: %#v", len(sa.Secrets), sa.Secrets)
	}
}

func TestListS3Secrets_OnlyOurs(t *testing.T) {
	ctx := context.Background()
	// Two AI-Storage S3 secrets + one unrelated Opaque secret.
	ours1 := makeFakeS3Secret("ns1", "alpha")
	ours2 := makeFakeS3Secret("ns1", "beta")
	noise := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "other", Namespace: "ns1"},
		Type:       corev1.SecretTypeOpaque,
	}
	svc := New(fake.NewSimpleClientset(ours1, ours2, noise))

	got, err := svc.ListS3Secrets(ctx, "ns1")
	if err != nil {
		t.Fatalf("ListS3Secrets: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2 (ours-only filter): %#v", len(got), got)
	}
	if got[0].Name != "alpha" || got[1].Name != "beta" {
		t.Fatalf("ordering broken: %#v", got)
	}
}

func TestDeleteS3Secret_RefusesForeignSecrets(t *testing.T) {
	ctx := context.Background()
	foreign := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "not-mine", Namespace: "ns1"},
		Type:       corev1.SecretTypeOpaque,
	}
	svc := New(fake.NewSimpleClientset(foreign))

	if err := svc.DeleteS3Secret(ctx, "ns1", "not-mine"); err == nil {
		t.Fatalf("expected refusal on non-aistorage secret")
	} else if !strings.Contains(err.Error(), "AI-Storage") {
		t.Fatalf("error message lost discriminator: %v", err)
	}
}

func TestDeleteS3Secret_DetachesFromServiceAccount(t *testing.T) {
	ctx := context.Background()
	sec := makeFakeS3Secret("ns1", "mine")
	sec.Annotations[annKnaicSA] = "sa-x"
	sa := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{Name: "sa-x", Namespace: "ns1"},
		Secrets:    []corev1.ObjectReference{{Name: "mine"}, {Name: "keep-me"}},
	}
	svc := New(fake.NewSimpleClientset(sec, sa))

	if err := svc.DeleteS3Secret(ctx, "ns1", "mine"); err != nil {
		t.Fatalf("DeleteS3Secret: %v", err)
	}

	updated, _ := svc.typed.CoreV1().ServiceAccounts("ns1").Get(ctx, "sa-x", metav1.GetOptions{})
	if len(updated.Secrets) != 1 || updated.Secrets[0].Name != "keep-me" {
		t.Fatalf("SA secret detach incorrect: %#v", updated.Secrets)
	}
}

func TestValidateS3Create(t *testing.T) {
	cases := []struct {
		name   string
		in     CreateS3SecretRequest
		wantOK bool
	}{
		{"missing name", CreateS3SecretRequest{Kind: S3KindAWS, AccessKeyID: "a", SecretAccessKey: "b"}, false},
		{"missing keys", CreateS3SecretRequest{Name: "n", Kind: S3KindAWS}, false},
		{"compatible without endpoint", CreateS3SecretRequest{Name: "n", Kind: S3KindCompatible, AccessKeyID: "a", SecretAccessKey: "b"}, false},
		{"aws empty endpoint allowed", CreateS3SecretRequest{Name: "n", Kind: S3KindAWS, AccessKeyID: "a", SecretAccessKey: "b"}, true},
		{"compatible with endpoint", CreateS3SecretRequest{Name: "n", Kind: S3KindCompatible, Endpoint: "e", AccessKeyID: "a", SecretAccessKey: "b"}, true},
		{"unknown kind", CreateS3SecretRequest{Name: "n", Kind: "bogus", AccessKeyID: "a", SecretAccessKey: "b"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateS3Create(c.in)
			if (err == nil) != c.wantOK {
				t.Fatalf("err=%v wantOK=%v", err, c.wantOK)
			}
		})
	}
}

func TestPatchS3Secret_UpdatesAnnotationsAndKeys(t *testing.T) {
	ctx := context.Background()
	sec := makeFakeS3Secret("ns1", "p")
	svc := New(fake.NewSimpleClientset(sec))

	region := "ap-southeast-1"
	bucket := "new-bucket"
	useHTTPS := false
	updated, err := svc.PatchS3Secret(ctx, "ns1", "p", PatchS3SecretRequest{
		Region:          &region,
		Bucket:          &bucket,
		UseHTTPS:        &useHTTPS,
		AccessKeyID:     "rotated-akid",
		SecretAccessKey: "rotated-sak",
	})
	if err != nil {
		t.Fatalf("PatchS3Secret: %v", err)
	}
	if updated.Region != region || updated.Bucket != bucket || updated.UseHTTPS {
		t.Fatalf("patch projection wrong: %#v", updated)
	}
	raw, _ := svc.typed.CoreV1().Secrets("ns1").Get(ctx, "p", metav1.GetOptions{})
	if string(raw.Data["AWS_ACCESS_KEY_ID"]) != "rotated-akid" {
		t.Fatalf("key rotation lost: %v", raw.Data)
	}
}

func TestNormalizeEndpoint(t *testing.T) {
	cases := []struct {
		in        string
		wantHost  string
		wantHTTPS bool
		wantErr   bool
	}{
		{"minio.example:9000", "minio.example:9000", false, false},
		{"https://s3.amazonaws.com", "s3.amazonaws.com", true, false},
		{"http://localhost:9000", "localhost:9000", false, false},
		{"", "", false, true},
	}
	for _, c := range cases {
		host, https, err := normalizeEndpoint(c.in, false)
		if (err != nil) != c.wantErr {
			t.Fatalf("normalizeEndpoint(%q) err=%v wantErr=%v", c.in, err, c.wantErr)
		}
		if !c.wantErr && (host != c.wantHost || https != c.wantHTTPS) {
			t.Fatalf("normalizeEndpoint(%q) = (%q, %v), want (%q, %v)", c.in, host, https, c.wantHost, c.wantHTTPS)
		}
	}
}

// makeFakeS3Secret builds a Secret that matches the layout produced by
// CreateS3Secret — used to seed tests that exercise reads/projections
// independently of the create path.
func makeFakeS3Secret(ns, name string) *corev1.Secret {
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: ns,
			Labels: map[string]string{
				labelManaged:   "true",
				labelComponent: componentValue,
				labelKind:      "s3",
			},
			Annotations: map[string]string{
				annS3Endpoint:  "minio.example.com:9000",
				annS3UseHTTPS:  "1",
				annKnaicKind:   string(S3KindCompatible),
				annKnaicBucket: "default-bucket",
			},
		},
		Type: corev1.SecretTypeOpaque,
		Data: map[string][]byte{
			"AWS_ACCESS_KEY_ID":     []byte("AKID"),
			"AWS_SECRET_ACCESS_KEY": []byte("SAK"),
		},
	}
}
