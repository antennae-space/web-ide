// Package prices holds the API prices of the models, for the cost of the turns of the agents
// (acp) and of the answers of the assistant.
package prices

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"sync"
)

// Price of a model in dollars per million tokens.
type Price struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

// prices are the API prices of the models (2026-10). Cache reads are the published ones, or
// a tenth of the input; cache writes 1.25 × the input (5 minute cache). <data>/prices.json
// adds or replaces models.
var prices = map[string]Price{
	"claude-fable-5-1":  {10, 50, 0.25, 12.5},
	"claude-fable-5":    {10, 50, 1, 12.5},
	"claude-opus-5-5":   {4, 20, 0.2, 5},
	"claude-opus-5":     {5, 25, 0.5, 6.25},
	"claude-opus-4-8":   {5, 25, 0.5, 6.25},
	"claude-opus-4-7":   {5, 25, 0.5, 6.25},
	"claude-opus-4-6":   {5, 25, 0.5, 6.25},
	"claude-sonnet-5-5": {2, 10, 0.2, 2.5},
	"claude-sonnet-5":   {2, 10, 0.2, 2.5},
	"claude-sonnet-4-6": {3, 15, 0.3, 3.75},
	"claude-haiku-5-5":  {0.1, 0.5, 0.01, 0.125},
	"claude-haiku-4-5":  {1, 5, 0.1, 1.25},
}

var (
	priceMu   sync.Mutex
	priceFile string
	extra     map[string]Price
	extraMod  int64
)

// SetFile names the file of the prices added by the user (<data>/prices.json: a map of
// model to Price), read again when it changes.
func SetFile(path string) {
	priceMu.Lock()
	priceFile, extra, extraMod = path, nil, 0
	priceMu.Unlock()
}

var dated = regexp.MustCompile(`-\d{8}$`)

// normModel drops the provider ("anthropic/") and the date of a model id.
func normModel(m string) string {
	m = strings.ToLower(m)
	if i := strings.LastIndexByte(m, '/'); i >= 0 {
		m = m[i+1:]
	}
	return dated.ReplaceAllString(m, "")
}

// Of is the price of a model, by its id or its id without provider and date.
func Of(model string) (Price, bool) {
	priceMu.Lock()
	defer priceMu.Unlock()
	if priceFile != "" {
		if st, err := os.Stat(priceFile); err == nil && st.ModTime().UnixNano() != extraMod {
			extra, extraMod = nil, st.ModTime().UnixNano()
			if data, err := os.ReadFile(priceFile); err == nil {
				_ = json.Unmarshal(data, &extra)
			}
		}
	}
	for _, m := range []string{model, normModel(model)} {
		if p, ok := extra[m]; ok {
			return p, true
		}
		if p, ok := prices[m]; ok {
			return p, true
		}
	}
	return Price{}, false
}

// Cost of an answer of a model, in dollars; false when the model has no price. In counts
// the input tokens not read from the cache.
func Cost(model string, in, out, cacheRead, cacheWrite int64) (float64, bool) {
	p, ok := Of(model)
	if !ok {
		return 0, false
	}
	return (float64(in)*p.Input + float64(out)*p.Output + float64(cacheRead)*p.CacheRead + float64(cacheWrite)*p.CacheWrite) / 1e6, true
}
