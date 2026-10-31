package ai

import (
	"encoding/json"
	"math"
	"testing"

	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/plugins/ai/llm"
)

func TestChatCost(t *testing.T) {
	answer := func(model string, u llm.Usage) *engine.Message {
		data, _ := json.Marshal(u)
		return &engine.Message{Role: "assistant", Model: model, Usage: data}
	}
	c := &engine.Chat{Model: "claude-sonnet-5-5", Messages: []*engine.Message{
		{Role: "user"},
		// 1M tokens read, half from the cache, 100k written: 0.5×2 + 0.5×0.2 + 0.1×10.
		answer("", llm.Usage{Prompt: 1e6, Cached: 5e5, Completion: 1e5}),
		// The provider tells its cost.
		answer("openrouter/some-model", llm.Usage{Prompt: 10, Completion: 10, Cost: 0.3}),
		// A local model: no price.
		answer("qwen3-local", llm.Usage{Prompt: 1e6, Completion: 1e6}),
	}}
	if got := chatCost(c); math.Abs(got-2.4) > 1e-9 {
		t.Fatalf("cost %v, want 2.4", got)
	}
	if got := chatCost(&engine.Chat{Model: "qwen3-local", Messages: c.Messages[3:]}); got != 0 {
		t.Fatalf("local model: cost %v, want 0", got)
	}
}
