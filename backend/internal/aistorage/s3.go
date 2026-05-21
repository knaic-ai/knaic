package aistorage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// S3SecretType discriminates an AWS S3 bucket from any other S3-compatible
// store (MinIO, Ceph RGW, Aliyun OSS, Tencent COS, etc.). The KServe
// storage-initializer needs slightly different annotations for the two, so
// we track which one the user picked.
type S3SecretType string

const (
	S3KindAWS        S3SecretType = "aws"
	S3KindCompatible S3SecretType = "compatible"
)

// S3Secret describes one S3 credential the user has registered in a
// namespace. The actual access keys are never returned by List/Get — only
// metadata. Get-with-secret is exposed as a separate "reveal" endpoint that
// requires admin.
type S3Secret struct {
	Name           string       `json:"name"`
	Namespace      string       `json:"namespace"`
	Kind           S3SecretType `json:"kind"`
	Endpoint       string       `json:"endpoint"`
	Region         string       `json:"region,omitempty"`
	UseHTTPS       bool         `json:"useHttps"`
	Bucket         string       `json:"bucket,omitempty"`
	ServiceAccount string       `json:"serviceAccount,omitempty"`
	CreatedAt      string       `json:"createdAt,omitempty"`
}

// CreateS3SecretRequest is the body of POST /admin/aistorage/s3/secrets.
type CreateS3SecretRequest struct {
	Name            string       `json:"name"`
	Kind            S3SecretType `json:"kind"`
	Endpoint        string       `json:"endpoint"`
	Region          string       `json:"region,omitempty"`
	UseHTTPS        bool         `json:"useHttps"`
	Bucket          string       `json:"bucket,omitempty"`
	AccessKeyID     string       `json:"accessKeyId"`
	SecretAccessKey string       `json:"secretAccessKey"`
	// ServiceAccount, when non-empty, makes us create (or patch) a
	// ServiceAccount of that name that has this Secret listed under its
	// `secrets:` field — this is what KServe's storage-initializer looks
	// up by SA name at pod-spawn time.
	ServiceAccount string `json:"serviceAccount,omitempty"`
}

// Annotation keys KServe's storage-initializer looks for on the Secret.
const (
	annS3Endpoint     = "serving.kserve.io/s3-endpoint"
	annS3UseHTTPS     = "serving.kserve.io/s3-usehttps"
	annS3Region       = "serving.kserve.io/s3-region"
	annS3UseVirtual   = "serving.kserve.io/s3-usevirtualbucket"
	annS3UseAnonymous = "serving.kserve.io/s3-useanoncredential"

	// knaic-private annotations that travel with the Secret so we can
	// reconstruct the typed S3Secret without keeping a separate store.
	annKnaicKind   = "knaic.io/aistorage-s3-kind"
	annKnaicBucket = "knaic.io/aistorage-s3-bucket"
	annKnaicSA     = "knaic.io/aistorage-s3-sa"
)

// ListS3Secrets returns the AI-Storage-managed S3 Secrets in the given
// namespace, sorted by name.
func (s *Service) ListS3Secrets(ctx context.Context, namespace string) ([]S3Secret, error) {
	if s.typed == nil {
		return nil, errors.New("kubernetes client not available")
	}
	list, err := s.typed.CoreV1().Secrets(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("%s=%s,%s=s3", labelComponent, componentValue, labelKind),
	})
	if err != nil {
		return nil, err
	}
	out := make([]S3Secret, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, projectS3Secret(&list.Items[i]))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// CreateS3Secret materialises the Secret (and optionally a ServiceAccount)
// using the KServe-compatible storage-secret layout.
func (s *Service) CreateS3Secret(ctx context.Context, namespace string, req CreateS3SecretRequest) (S3Secret, error) {
	if err := validateS3Create(req); err != nil {
		return S3Secret{}, err
	}
	annotations := map[string]string{
		annS3Endpoint:  req.Endpoint,
		annS3UseHTTPS:  boolStr01(req.UseHTTPS),
		annKnaicKind:   string(req.Kind),
		annKnaicBucket: req.Bucket,
	}
	if req.Region != "" {
		annotations[annS3Region] = req.Region
	}
	if req.ServiceAccount != "" {
		annotations[annKnaicSA] = req.ServiceAccount
	}
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      req.Name,
			Namespace: namespace,
			Labels: map[string]string{
				labelManaged:   "true",
				labelComponent: componentValue,
				labelKind:      "s3",
			},
			Annotations: annotations,
		},
		Type: corev1.SecretTypeOpaque,
		StringData: map[string]string{
			"AWS_ACCESS_KEY_ID":     req.AccessKeyID,
			"AWS_SECRET_ACCESS_KEY": req.SecretAccessKey,
		},
	}
	created, err := s.typed.CoreV1().Secrets(namespace).Create(ctx, sec, metav1.CreateOptions{})
	if err != nil {
		return S3Secret{}, err
	}
	if req.ServiceAccount != "" {
		if err := s.ensureServiceAccountForSecret(ctx, namespace, req.ServiceAccount, req.Name); err != nil {
			return S3Secret{}, fmt.Errorf("create/patch ServiceAccount %q: %w", req.ServiceAccount, err)
		}
	}
	return projectS3Secret(created), nil
}

// DeleteS3Secret removes the Secret. It does NOT delete the ServiceAccount
// (it may still be referenced by other secrets / workloads); we only patch
// the SA to drop the secret from its `secrets:` list.
func (s *Service) DeleteS3Secret(ctx context.Context, namespace, name string) error {
	sec, err := s.typed.CoreV1().Secrets(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	if !isOurs(sec.Labels, "s3") {
		return errors.New("not an AI-Storage S3 secret")
	}
	if sa := sec.Annotations[annKnaicSA]; sa != "" {
		_ = s.detachSecretFromServiceAccount(ctx, namespace, sa, name)
	}
	return s.typed.CoreV1().Secrets(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ensureServiceAccountForSecret either creates the SA (with this secret
// listed) or patches an existing SA to include the secret.
func (s *Service) ensureServiceAccountForSecret(ctx context.Context, namespace, saName, secretName string) error {
	sa, err := s.typed.CoreV1().ServiceAccounts(namespace).Get(ctx, saName, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		_, err := s.typed.CoreV1().ServiceAccounts(namespace).Create(ctx, &corev1.ServiceAccount{
			ObjectMeta: metav1.ObjectMeta{
				Name:      saName,
				Namespace: namespace,
				Labels: map[string]string{
					labelManaged:   "true",
					labelComponent: componentValue,
				},
			},
			Secrets: []corev1.ObjectReference{{Name: secretName}},
		}, metav1.CreateOptions{})
		return err
	}
	if err != nil {
		return err
	}
	for _, ref := range sa.Secrets {
		if ref.Name == secretName {
			return nil
		}
	}
	sa.Secrets = append(sa.Secrets, corev1.ObjectReference{Name: secretName})
	_, err = s.typed.CoreV1().ServiceAccounts(namespace).Update(ctx, sa, metav1.UpdateOptions{})
	return err
}

func (s *Service) detachSecretFromServiceAccount(ctx context.Context, namespace, saName, secretName string) error {
	sa, err := s.typed.CoreV1().ServiceAccounts(namespace).Get(ctx, saName, metav1.GetOptions{})
	if err != nil {
		return err
	}
	out := sa.Secrets[:0]
	for _, ref := range sa.Secrets {
		if ref.Name != secretName {
			out = append(out, ref)
		}
	}
	sa.Secrets = out
	_, err = s.typed.CoreV1().ServiceAccounts(namespace).Update(ctx, sa, metav1.UpdateOptions{})
	return err
}

func projectS3Secret(sec *corev1.Secret) S3Secret {
	a := sec.Annotations
	return S3Secret{
		Name:           sec.Name,
		Namespace:      sec.Namespace,
		Kind:           S3SecretType(a[annKnaicKind]),
		Endpoint:       a[annS3Endpoint],
		Region:         a[annS3Region],
		UseHTTPS:       a[annS3UseHTTPS] == "1" || strings.EqualFold(a[annS3UseHTTPS], "true"),
		Bucket:         a[annKnaicBucket],
		ServiceAccount: a[annKnaicSA],
		CreatedAt:      sec.CreationTimestamp.Format(time.RFC3339),
	}
}

func validateS3Create(req CreateS3SecretRequest) error {
	if req.Name == "" {
		return errors.New("name is required")
	}
	if req.AccessKeyID == "" || req.SecretAccessKey == "" {
		return errors.New("accessKeyId and secretAccessKey are required")
	}
	switch req.Kind {
	case S3KindAWS:
		// Endpoint is optional for native AWS; default to the regional endpoint.
	case S3KindCompatible:
		if req.Endpoint == "" {
			return errors.New("endpoint is required for S3-compatible secrets")
		}
	default:
		return errors.New(`kind must be "aws" or "compatible"`)
	}
	return nil
}

func boolStr01(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

func isOurs(labels map[string]string, kind string) bool {
	return labels[labelComponent] == componentValue && labels[labelKind] == kind
}

// ------------------- S3 file operations -------------------------

// S3Object is one row in the bucket listing.
type S3Object struct {
	Key          string `json:"key"`
	Size         int64  `json:"size"`
	LastModified string `json:"lastModified,omitempty"`
	IsPrefix     bool   `json:"isPrefix"`
}

// S3List returns the (recursive=false) listing under prefix, with prefixes
// surfaced separately as "folders".
func (s *Service) S3List(ctx context.Context, namespace, secretName, bucket, prefix string) ([]S3Object, error) {
	cli, err := s.s3Client(ctx, namespace, secretName)
	if err != nil {
		return nil, err
	}
	if bucket == "" {
		bucket, err = s.s3DefaultBucket(ctx, namespace, secretName)
		if err != nil {
			return nil, err
		}
	}
	out := make([]S3Object, 0, 64)
	objCh := cli.ListObjects(ctx, bucket, minio.ListObjectsOptions{
		Prefix:    prefix,
		Recursive: false,
	})
	for o := range objCh {
		if o.Err != nil {
			return nil, o.Err
		}
		obj := S3Object{
			Key:  o.Key,
			Size: o.Size,
		}
		if !o.LastModified.IsZero() {
			obj.LastModified = o.LastModified.Format(time.RFC3339)
		}
		// minio-go signals a common-prefix ("folder") by a trailing slash
		// + zero size + empty ETag.
		if strings.HasSuffix(o.Key, "/") && o.Size == 0 && o.ETag == "" {
			obj.IsPrefix = true
		}
		out = append(out, obj)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].IsPrefix != out[j].IsPrefix {
			return out[i].IsPrefix
		}
		return out[i].Key < out[j].Key
	})
	return out, nil
}

// S3ListBuckets enumerates buckets reachable with the given Secret. We use
// this to populate the bucket selector when the Secret's stored bucket is
// empty or when the user wants to switch.
func (s *Service) S3ListBuckets(ctx context.Context, namespace, secretName string) ([]string, error) {
	cli, err := s.s3Client(ctx, namespace, secretName)
	if err != nil {
		return nil, err
	}
	bs, err := cli.ListBuckets(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(bs))
	for _, b := range bs {
		out = append(out, b.Name)
	}
	sort.Strings(out)
	return out, nil
}

// S3Upload streams body into bucket/key. size <= 0 means "unknown" — the
// minio client will fall back to chunked-with-buffer; for known sizes the
// upload is single-PUT for objects <128 MiB.
func (s *Service) S3Upload(ctx context.Context, namespace, secretName, bucket, key string, body io.Reader, size int64, contentType string) error {
	cli, err := s.s3Client(ctx, namespace, secretName)
	if err != nil {
		return err
	}
	if bucket == "" {
		bucket, err = s.s3DefaultBucket(ctx, namespace, secretName)
		if err != nil {
			return err
		}
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	_, err = cli.PutObject(ctx, bucket, key, body, size, minio.PutObjectOptions{ContentType: contentType})
	return err
}

// S3Download opens the object for streaming. The caller is responsible for
// closing the returned reader (and for piping the Content-Length /
// Content-Type back to the HTTP client). Stat is returned so we can set
// headers before flushing.
func (s *Service) S3Download(ctx context.Context, namespace, secretName, bucket, key string) (io.ReadCloser, minio.ObjectInfo, error) {
	cli, err := s.s3Client(ctx, namespace, secretName)
	if err != nil {
		return nil, minio.ObjectInfo{}, err
	}
	if bucket == "" {
		bucket, err = s.s3DefaultBucket(ctx, namespace, secretName)
		if err != nil {
			return nil, minio.ObjectInfo{}, err
		}
	}
	obj, err := cli.GetObject(ctx, bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, minio.ObjectInfo{}, err
	}
	info, err := obj.Stat()
	if err != nil {
		_ = obj.Close()
		return nil, minio.ObjectInfo{}, err
	}
	return obj, info, nil
}

// S3Delete deletes one object.
func (s *Service) S3Delete(ctx context.Context, namespace, secretName, bucket, key string) error {
	cli, err := s.s3Client(ctx, namespace, secretName)
	if err != nil {
		return err
	}
	if bucket == "" {
		bucket, err = s.s3DefaultBucket(ctx, namespace, secretName)
		if err != nil {
			return err
		}
	}
	return cli.RemoveObject(ctx, bucket, key, minio.RemoveObjectOptions{})
}

// s3Client constructs a minio client from the secret. It uses the path-style
// addressing for compatible endpoints (MinIO/Ceph) and virtual-host style
// for AWS — same default heuristic minio-go applies internally when the
// endpoint matches *.amazonaws.com.
func (s *Service) s3Client(ctx context.Context, namespace, secretName string) (*minio.Client, error) {
	sec, err := s.typed.CoreV1().Secrets(namespace).Get(ctx, secretName, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	if !isOurs(sec.Labels, "s3") {
		return nil, errors.New("secret is not an AI-Storage S3 secret")
	}
	akid := string(sec.Data["AWS_ACCESS_KEY_ID"])
	sak := string(sec.Data["AWS_SECRET_ACCESS_KEY"])
	endpoint := sec.Annotations[annS3Endpoint]
	useSSL := sec.Annotations[annS3UseHTTPS] == "1" || strings.EqualFold(sec.Annotations[annS3UseHTTPS], "true")
	region := sec.Annotations[annS3Region]
	kind := S3SecretType(sec.Annotations[annKnaicKind])

	// For AWS S3 with no explicit endpoint, fall back to the regional or
	// global default. AWS path-style is being deprecated, but minio-go
	// auto-detects amazonaws.com hosts and switches to virtual-host style.
	if endpoint == "" && kind == S3KindAWS {
		if region != "" {
			endpoint = "s3." + region + ".amazonaws.com"
		} else {
			endpoint = "s3.amazonaws.com"
		}
		useSSL = true
	}

	host, useSSLFromURL, err := normalizeEndpoint(endpoint, useSSL)
	if err != nil {
		return nil, err
	}
	if useSSLFromURL {
		useSSL = true
	}
	return minio.New(host, &minio.Options{
		Creds:  credentials.NewStaticV4(akid, sak, ""),
		Secure: useSSL,
		Region: region,
	})
}

// s3DefaultBucket returns the bucket stored on the Secret if any. We need
// this because the UI may not have asked the user to pick a bucket yet
// (e.g. download links that just say "open the secret's default bucket").
func (s *Service) s3DefaultBucket(ctx context.Context, namespace, secretName string) (string, error) {
	sec, err := s.typed.CoreV1().Secrets(namespace).Get(ctx, secretName, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	b := sec.Annotations[annKnaicBucket]
	if b == "" {
		return "", errors.New("no default bucket configured on this secret; pass ?bucket=...")
	}
	return b, nil
}

// normalizeEndpoint accepts both bare hosts ("minio.example:9000") and
// URLs ("https://s3.amazonaws.com") and returns (host[:port], inferredHTTPS).
// minio-go takes host[:port], not a full URL.
func normalizeEndpoint(endpoint string, useSSL bool) (string, bool, error) {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return "", false, errors.New("endpoint is empty")
	}
	if !strings.Contains(endpoint, "://") {
		return endpoint, false, nil
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", false, fmt.Errorf("invalid endpoint URL: %w", err)
	}
	return u.Host, u.Scheme == "https", nil
}

// PatchS3Secret updates the configurable parts of an existing Secret. Keys
// are only rotated when non-empty in the patch so the UI can update the
// endpoint without forcing the user to re-enter credentials.
type PatchS3SecretRequest struct {
	Endpoint        *string `json:"endpoint,omitempty"`
	Region          *string `json:"region,omitempty"`
	UseHTTPS        *bool   `json:"useHttps,omitempty"`
	Bucket          *string `json:"bucket,omitempty"`
	AccessKeyID     string  `json:"accessKeyId,omitempty"`
	SecretAccessKey string  `json:"secretAccessKey,omitempty"`
}

func (s *Service) PatchS3Secret(ctx context.Context, namespace, name string, req PatchS3SecretRequest) (S3Secret, error) {
	sec, err := s.typed.CoreV1().Secrets(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return S3Secret{}, err
	}
	if !isOurs(sec.Labels, "s3") {
		return S3Secret{}, errors.New("not an AI-Storage S3 secret")
	}
	if sec.Annotations == nil {
		sec.Annotations = map[string]string{}
	}
	if req.Endpoint != nil {
		sec.Annotations[annS3Endpoint] = *req.Endpoint
	}
	if req.Region != nil {
		sec.Annotations[annS3Region] = *req.Region
	}
	if req.UseHTTPS != nil {
		sec.Annotations[annS3UseHTTPS] = boolStr01(*req.UseHTTPS)
	}
	if req.Bucket != nil {
		sec.Annotations[annKnaicBucket] = *req.Bucket
	}
	if req.AccessKeyID != "" || req.SecretAccessKey != "" {
		if sec.Data == nil {
			sec.Data = map[string][]byte{}
		}
		if req.AccessKeyID != "" {
			sec.Data["AWS_ACCESS_KEY_ID"] = []byte(req.AccessKeyID)
		}
		if req.SecretAccessKey != "" {
			sec.Data["AWS_SECRET_ACCESS_KEY"] = []byte(req.SecretAccessKey)
		}
	}
	updated, err := s.typed.CoreV1().Secrets(namespace).Update(ctx, sec, metav1.UpdateOptions{})
	if err != nil {
		return S3Secret{}, err
	}
	return projectS3Secret(updated), nil
}

