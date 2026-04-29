package models

import (
	"context"
	"crypto/rand"
	"encoding/hex"
)

// Seed populates the public scope with a small catalogue of well-known
// models if it's currently empty. Mirrors the prototype's seed list so
// fresh installations look "complete" out of the box.
func Seed(ctx context.Context, s Store) error {
	n, err := s.Count(ctx, ScopePublic)
	if err != nil || n > 0 {
		return err
	}
	for _, m := range builtinPublic() {
		m.ID = newID("m")
		if _, err := s.Create(ctx, m); err != nil && err != ErrConflict {
			return err
		}
	}
	return nil
}

func builtinPublic() []Model {
	return []Model{
		{
			Name:      "Qwen/Qwen3.5-7B-Instruct",
			Owner:     "Qwen",
			Scope:     ScopePublic,
			URI:       "hf://Qwen/Qwen3.5-7B-Instruct",
			Scheme:    SchemeHF,
			Tags:      []string{"chat", "instruct", "text-generation"},
			ModelType: "llm",
			SizeGB:    15.2,
			Readme: `# Qwen3.5 7B Instruct

Qwen3.5 is the next-generation Qwen model series. The 7B instruct variant is
tuned for conversational and tool-use scenarios.

## Quick start
` + "```bash" + `
vllm serve Qwen/Qwen3.5-7B-Instruct --max-model-len 32768
` + "```\n" + `
## License
Apache-2.0`,
		},
		{
			Name:      "Qwen/Qwen3.5-72B-Instruct",
			Owner:     "Qwen",
			Scope:     ScopePublic,
			URI:       "hf://Qwen/Qwen3.5-72B-Instruct",
			Scheme:    SchemeHF,
			Tags:      []string{"chat", "instruct", "flagship"},
			ModelType: "llm",
			SizeGB:    146.0,
			Readme:    "# Qwen3.5 72B Instruct\n\nFlagship instruct model. Requires multi-GPU deployment.",
		},
		{
			Name:      "meta-llama/Llama-3.3-8B-Instruct",
			Owner:     "meta-llama",
			Scope:     ScopePublic,
			URI:       "hf://meta-llama/Llama-3.3-8B-Instruct",
			Scheme:    SchemeHF,
			Tags:      []string{"chat", "instruct"},
			ModelType: "llm",
			SizeGB:    16.8,
			Readme:    "# Llama 3.3 8B Instruct",
		},
		{
			Name:      "BAAI/bge-large-en-v1.5",
			Owner:     "BAAI",
			Scope:     ScopePublic,
			URI:       "hf://BAAI/bge-large-en-v1.5",
			Scheme:    SchemeHF,
			Tags:      []string{"embedding", "retrieval"},
			ModelType: "embedding",
			SizeGB:    1.3,
			Readme:    "# BGE Large EN v1.5\n\nGeneral-purpose English embedding model.",
		},
		{
			Name:      "stabilityai/stable-diffusion-3-medium",
			Owner:     "stabilityai",
			Scope:     ScopePublic,
			URI:       "hf://stabilityai/stable-diffusion-3-medium",
			Scheme:    SchemeHF,
			Tags:      []string{"image", "diffusion"},
			ModelType: "diffusion",
			SizeGB:    14.0,
			Readme:    "# Stable Diffusion 3 Medium",
		},
	}
}

// newID returns a short random identifier. We avoid full UUIDs because the
// prototype already uses short ids in URLs and React keys.
func newID(prefix string) string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return prefix + "-" + hex.EncodeToString(b[:])
}
