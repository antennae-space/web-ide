package ai

import (
	"encoding/json"

	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/plugins/ai/internal/prices"
	"antennae.space/ide/plugins/ai/llm"
)

// chatCost is the cost of the answers of a conversation, in dollars: the one the provider
// tells (OpenRouter), else its tokens at the price of its model (internal/prices). An answer
// of a local or unknown model costs nothing.
func chatCost(c *engine.Chat) float64 {
	var sum float64
	for _, m := range c.Messages {
		if m.Role != "assistant" || len(m.Usage) == 0 {
			continue
		}
		var u llm.Usage
		if json.Unmarshal(m.Usage, &u) != nil {
			continue
		}
		if u.Cost > 0 {
			sum += u.Cost
			continue
		}
		model := m.Model
		if model == "" {
			model = c.Model
		}
		cached := min(u.Cached, u.Prompt)
		if x, ok := prices.Cost(model, int64(u.Prompt-cached), int64(u.Completion), int64(cached), 0); ok {
			sum += x
		}
	}
	return sum
}
