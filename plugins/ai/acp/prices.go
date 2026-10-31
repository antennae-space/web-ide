package acp

import "antennae.space/ide/plugins/ai/internal/prices"

// Price of a model in dollars per million tokens (internal/prices, shared with the assistant).
type Price = prices.Price

// SetPriceFile names the file of the prices added by the user (<data>/prices.json).
func SetPriceFile(path string) { prices.SetFile(path) }

func priceOf(model string) (Price, bool) { return prices.Of(model) }

// cost of tokens; false when a model has no price.
func cost(tokens []Tokens) (float64, bool) {
	var sum float64
	for _, t := range tokens {
		if t.total() == 0 {
			continue
		}
		c, ok := prices.Cost(t.Model, t.Input, t.Output, t.CacheRead, t.CacheWrite)
		if !ok {
			return 0, false
		}
		sum += c
	}
	return sum, true
}
