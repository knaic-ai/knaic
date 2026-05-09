package gpu

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
)

// ProfileField is one row in a GPU profile — the picker on the inference /
// notebook / training forms turns these into labelled InputNumber inputs.
type ProfileField struct {
	Key          string `json:"key"`
	Label        string `json:"label"`
	Unit         string `json:"unit,omitempty"`
	DefaultValue any    `json:"defaultValue"` // string | number — Antd accepts both
	Step         *int   `json:"step,omitempty"`
	Min          *int   `json:"min,omitempty"`
	Max          *int   `json:"max,omitempty"`
}

// Profile is the schema persisted in the ConfigMap. Built-in profiles
// (HAMi, NVIDIA whole-card, Ascend NPU) ship in code; admins can add
// vendor-specific or per-cluster custom profiles via the admin page.
type Profile struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Kind        string         `json:"kind"` // hami | nvidia | npu | custom
	Description string         `json:"description,omitempty"`
	Fields      []ProfileField `json:"fields"`
	Builtin     bool           `json:"builtin"`
}

// ProfileStore wraps the ConfigMap-backed CRUD. Built-in profiles are
// always returned; user-defined entries are stored as one JSON value per
// key in a single ConfigMap to keep things simple (one round-trip for the
// list, no need to label-list across the cluster).
type ProfileStore struct {
	typed     kubernetes.Interface
	namespace string
}

// NewProfileStore — namespace is where the ConfigMap lives (typically the
// system namespace). typed may be nil during local dev — in that case the
// store returns just the built-in profiles and rejects writes.
func NewProfileStore(typed kubernetes.Interface, namespace string) *ProfileStore {
	return &ProfileStore{typed: typed, namespace: namespace}
}

const (
	profileConfigMap   = "knaic-gpu-profiles"
	profileLabelKey    = "knaic.io/managed"
	profileLabelValue  = "true"
	profileComponent   = "knaic.io/component"
	profileComponentV  = "gpu-profile"
)

// builtinProfiles are the same set the frontend used to seed locally.
// They're regenerated each call so callers can't mutate the slice we hold.
func builtinProfiles() []Profile {
	intp := func(v int) *int { return &v }
	return []Profile{
		{
			ID:          "builtin-hami",
			Name:        "HAMi (shared GPU)",
			Kind:        "hami",
			Description: "Partial GPU share via the HAMi scheduler.",
			Builtin:     true,
			Fields: []ProfileField{
				{Key: "nvidia.com/gpualloc", Label: "GPUs", DefaultValue: 1, Min: intp(0), Step: intp(1)},
				{Key: "nvidia.com/gpucores", Label: "GPU cores (%)", DefaultValue: 25, Min: intp(1), Max: intp(100), Step: intp(5)},
				{Key: "nvidia.com/gpumem", Label: "GPU memory", Unit: "MiB", DefaultValue: 8192, Min: intp(512), Step: intp(512)},
			},
		},
		{
			ID:          "builtin-nvidia",
			Name:        "NVIDIA GPU (whole)",
			Kind:        "nvidia",
			Description: "Request one or more full NVIDIA GPUs.",
			Builtin:     true,
			Fields: []ProfileField{
				{Key: "nvidia.com/gpu", Label: "GPUs", DefaultValue: 1, Min: intp(0), Step: intp(1)},
			},
		},
		{
			ID:          "builtin-ascend910b",
			Name:        "Huawei Ascend 910B (NPU)",
			Kind:        "npu",
			Description: "Ascend NPU allocation via huawei.com/Ascend910B.",
			Builtin:     true,
			Fields: []ProfileField{
				{Key: "huawei.com/Ascend910B", Label: "NPUs", DefaultValue: 1, Min: intp(0), Step: intp(1)},
			},
		},
	}
}

// List returns built-ins + persisted custom profiles, sorted with built-ins
// first then alphabetically by name. Missing-ConfigMap is not an error;
// the user just sees the built-in set.
func (s *ProfileStore) List(ctx context.Context) ([]Profile, error) {
	out := append([]Profile(nil), builtinProfiles()...)
	custom, err := s.readCustom(ctx)
	if err != nil {
		return out, nil
	}
	out = append(out, custom...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Builtin != out[j].Builtin {
			return out[i].Builtin
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// Create persists a new custom profile and returns it (with a generated id).
func (s *ProfileStore) Create(ctx context.Context, p Profile) (Profile, error) {
	if err := validateProfile(&p); err != nil {
		return Profile{}, err
	}
	if isBuiltinID(p.ID) {
		return Profile{}, errors.New("cannot use a built-in profile id")
	}
	if p.ID == "" {
		p.ID = "p-" + randHex(4)
	}
	p.Builtin = false
	if err := s.upsert(ctx, p); err != nil {
		return Profile{}, err
	}
	return p, nil
}

// Update rewrites an existing custom profile. Built-in ids are rejected.
func (s *ProfileStore) Update(ctx context.Context, p Profile) (Profile, error) {
	if err := validateProfile(&p); err != nil {
		return Profile{}, err
	}
	if isBuiltinID(p.ID) {
		return Profile{}, errors.New("cannot edit a built-in profile")
	}
	p.Builtin = false
	if err := s.upsert(ctx, p); err != nil {
		return Profile{}, err
	}
	return p, nil
}

// Delete removes a custom profile. Built-in ids are rejected.
func (s *ProfileStore) Delete(ctx context.Context, id string) error {
	if isBuiltinID(id) {
		return errors.New("cannot delete a built-in profile")
	}
	if s.typed == nil {
		return errors.New("kubernetes client not initialised")
	}
	cm, err := s.getOrCreate(ctx)
	if err != nil {
		return err
	}
	if cm.Data == nil {
		return nil
	}
	if _, ok := cm.Data[id]; !ok {
		return nil
	}
	delete(cm.Data, id)
	_, err = s.typed.CoreV1().ConfigMaps(s.namespace).Update(ctx, cm, metav1.UpdateOptions{})
	return err
}

func (s *ProfileStore) readCustom(ctx context.Context) ([]Profile, error) {
	if s.typed == nil {
		return nil, nil
	}
	cm, err := s.typed.CoreV1().ConfigMaps(s.namespace).Get(ctx, profileConfigMap, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]Profile, 0, len(cm.Data))
	for id, raw := range cm.Data {
		var p Profile
		if err := json.Unmarshal([]byte(raw), &p); err != nil {
			// Skip malformed entries; flagging here would block the whole
			// list. Operators can `kubectl edit` to fix.
			continue
		}
		p.ID = id
		p.Builtin = false
		out = append(out, p)
	}
	return out, nil
}

// upsert creates the ConfigMap on first write, then writes the JSON-encoded
// profile under the profile's id key.
func (s *ProfileStore) upsert(ctx context.Context, p Profile) error {
	if s.typed == nil {
		return errors.New("kubernetes client not initialised")
	}
	cm, err := s.getOrCreate(ctx)
	if err != nil {
		return err
	}
	body, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if cm.Data == nil {
		cm.Data = map[string]string{}
	}
	cm.Data[p.ID] = string(body)
	_, err = s.typed.CoreV1().ConfigMaps(s.namespace).Update(ctx, cm, metav1.UpdateOptions{})
	return err
}

func (s *ProfileStore) getOrCreate(ctx context.Context) (*corev1.ConfigMap, error) {
	cm, err := s.typed.CoreV1().ConfigMaps(s.namespace).Get(ctx, profileConfigMap, metav1.GetOptions{})
	if err == nil {
		return cm, nil
	}
	if !apierrors.IsNotFound(err) {
		return nil, err
	}
	cm = &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      profileConfigMap,
			Namespace: s.namespace,
			Labels: map[string]string{
				profileLabelKey:  profileLabelValue,
				profileComponent: profileComponentV,
			},
		},
		Data: map[string]string{},
	}
	created, err := s.typed.CoreV1().ConfigMaps(s.namespace).Create(ctx, cm, metav1.CreateOptions{})
	if err != nil {
		// Race: another writer created it. Re-fetch.
		if apierrors.IsAlreadyExists(err) {
			return s.typed.CoreV1().ConfigMaps(s.namespace).Get(ctx, profileConfigMap, metav1.GetOptions{})
		}
		return nil, err
	}
	return created, nil
}

func validateProfile(p *Profile) error {
	if p.Name == "" {
		return errors.New("name is required")
	}
	if len(p.Fields) == 0 {
		return errors.New("at least one field is required")
	}
	for i, f := range p.Fields {
		if f.Key == "" {
			return fmt.Errorf("field[%d].key is required", i)
		}
		if f.Label == "" {
			return fmt.Errorf("field[%d].label is required", i)
		}
	}
	if p.Kind == "" {
		p.Kind = "custom"
	}
	return nil
}

func isBuiltinID(id string) bool {
	for _, p := range builtinProfiles() {
		if p.ID == id {
			return true
		}
	}
	return false
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
