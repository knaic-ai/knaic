package aistorage

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestCreateGitLabConfig_LayoutAndAnnotations(t *testing.T) {
	ctx := context.Background()
	svc := New(fake.NewSimpleClientset())

	got, err := svc.CreateGitLabConfig(ctx, "ns1", CreateGitLabConfigRequest{
		Name:     "my-gl",
		URL:      "https://gitlab.example.com/",
		Username: "alice",
		Token:    "glpat-xxxx",
	})
	if err != nil {
		t.Fatalf("CreateGitLabConfig: %v", err)
	}
	// The stored URL must be trimmed of trailing slashes — the API
	// helper concatenates paths with no joining logic, so a trailing
	// slash would produce //api/v4 requests.
	if got.URL != "https://gitlab.example.com" {
		t.Fatalf("URL not trimmed: %q", got.URL)
	}

	raw, err := svc.typed.CoreV1().Secrets("ns1").Get(ctx, "my-gl", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get raw secret: %v", err)
	}
	if raw.Labels[labelKind] != "gitlab" {
		t.Fatalf("missing kind label: %#v", raw.Labels)
	}
	if string(raw.Data["GITLAB_TOKEN"]) != "glpat-xxxx" {
		t.Fatalf("token not stored under GITLAB_TOKEN: %v", raw.Data)
	}
	if raw.Annotations[annGitLabURL] != "https://gitlab.example.com" {
		t.Fatalf("missing url annotation: %#v", raw.Annotations)
	}
}

func TestCreateGitLabConfig_RejectsEmptyFields(t *testing.T) {
	ctx := context.Background()
	svc := New(fake.NewSimpleClientset())
	cases := []CreateGitLabConfigRequest{
		{URL: "https://gl", Token: "t"},                  // name empty
		{Name: "n", Token: "t"},                          // url empty
		{Name: "n", URL: "https://gl"},                   // token empty
		{Name: "n", URL: "::not a url", Token: "t"},      // invalid url
	}
	for i, c := range cases {
		if _, err := svc.CreateGitLabConfig(ctx, "ns1", c); err == nil {
			t.Fatalf("case %d: expected validation error for %+v", i, c)
		}
	}
}

func TestListGitLabConfigs_FiltersByLabel(t *testing.T) {
	ctx := context.Background()
	ours := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "mine",
			Namespace: "ns1",
			Labels: map[string]string{
				labelManaged:   "true",
				labelComponent: componentValue,
				labelKind:      "gitlab",
			},
			Annotations: map[string]string{annGitLabURL: "https://gl"},
		},
		Type: corev1.SecretTypeOpaque,
		Data: map[string][]byte{"GITLAB_TOKEN": []byte("t")},
	}
	other := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "unrelated", Namespace: "ns1"},
		Type:       corev1.SecretTypeOpaque,
	}
	svc := New(fake.NewSimpleClientset(ours, other))

	got, err := svc.ListGitLabConfigs(ctx, "ns1")
	if err != nil {
		t.Fatalf("ListGitLabConfigs: %v", err)
	}
	if len(got) != 1 || got[0].Name != "mine" {
		t.Fatalf("filter broken: %#v", got)
	}
}

func TestPatchGitLabConfig_RotatesToken(t *testing.T) {
	ctx := context.Background()
	svc := New(fake.NewSimpleClientset())
	if _, err := svc.CreateGitLabConfig(ctx, "ns1", CreateGitLabConfigRequest{
		Name: "g", URL: "https://gl", Token: "old",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	url := "https://gl2.example.com"
	if _, err := svc.PatchGitLabConfig(ctx, "ns1", "g", PatchGitLabConfigRequest{URL: &url, Token: "new"}); err != nil {
		t.Fatalf("PatchGitLabConfig: %v", err)
	}
	raw, _ := svc.typed.CoreV1().Secrets("ns1").Get(ctx, "g", metav1.GetOptions{})
	if string(raw.Data["GITLAB_TOKEN"]) != "new" {
		t.Fatalf("token not rotated: %v", raw.Data)
	}
	if raw.Annotations[annGitLabURL] != url {
		t.Fatalf("URL not updated: %v", raw.Annotations)
	}
}

func TestDeleteGitLabConfig_RefusesForeignSecrets(t *testing.T) {
	ctx := context.Background()
	foreign := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "not-mine", Namespace: "ns1"},
		Type:       corev1.SecretTypeOpaque,
	}
	svc := New(fake.NewSimpleClientset(foreign))
	if err := svc.DeleteGitLabConfig(ctx, "ns1", "not-mine"); err == nil {
		t.Fatalf("expected refusal")
	}
}

// -------------------- pure helpers --------------------

func TestParseLFSPointerRoundTrip(t *testing.T) {
	oid := "deadbeefcafef00dba5eba110123456789abcdef0123456789abcdef01234567"
	pointer := buildLFSPointer(oid, 12345)
	if !isLFSPointer(pointer) {
		t.Fatalf("buildLFSPointer output should be recognised: %q", pointer)
	}
	gotOid, gotSize, err := parseLFSPointer(pointer)
	if err != nil {
		t.Fatalf("parseLFSPointer: %v", err)
	}
	if gotOid != oid || gotSize != 12345 {
		t.Fatalf("roundtrip lost data: oid=%q size=%d", gotOid, gotSize)
	}
}

func TestParseLFSPointer_RejectsRandomBytes(t *testing.T) {
	_, _, err := parseLFSPointer([]byte("hello world, this is not a pointer"))
	if err == nil {
		t.Fatalf("expected error on non-pointer input")
	}
}

func TestIsLFSPointer(t *testing.T) {
	if !isLFSPointer([]byte("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n")) {
		t.Fatalf("legit pointer rejected")
	}
	if isLFSPointer([]byte("PK\x03\x04 zip archive bytes")) {
		t.Fatalf("zip header should not look like an LFS pointer")
	}
}

func TestMatchLFSPattern(t *testing.T) {
	cases := []struct {
		pat, path string
		want      bool
	}{
		{"weights.bin", "weights.bin", true},
		{"weights.bin", "other.bin", false},
		{"*.bin", "weights.bin", true},
		{"*.bin", "nested/weights.bin", true}, // suffix match
		{"*.bin", "weights.txt", false},
		{"models/*", "models/llama.bin", true},
		{"models/*", "models/sub/llama.bin", false}, // only direct children
		{"models/*", "other/llama.bin", false},
	}
	for _, c := range cases {
		got := matchLFSPattern(c.pat, c.path)
		if got != c.want {
			t.Fatalf("matchLFSPattern(%q, %q) = %v, want %v", c.pat, c.path, got, c.want)
		}
	}
}

func TestBuildLFSPointer_OnlyAsciiAndNewlines(t *testing.T) {
	// Pointer files must be valid UTF-8 ASCII with LF line endings — Git
	// will mis-store them otherwise.
	out := string(buildLFSPointer("deadbeef", 7))
	if !strings.HasPrefix(out, "version https://git-lfs.github.com/spec/v1\n") {
		t.Fatalf("bad header: %q", out)
	}
	if strings.Contains(out, "\r") {
		t.Fatalf("CR in pointer body: %q", out)
	}
}
