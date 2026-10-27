package languages

import (
	_ "embed"
	"encoding/json"
	"strconv"
)

// The symbol kinds (their LSP number) are one table, web/kinds.json: the page module reads it as
// JSON, the pod reads the same file. A family is a color of the theme (--sym-type…).

//go:embed web/kinds.json
var kindsJSON []byte

// SymbolKind is one entry of the table: name, glyph and the family that colors it.
type SymbolKind struct {
	Name   string
	Glyph  string
	Family string
}

func parseSymbolKinds(raw []byte) map[int]SymbolKind {
	var doc struct {
		Families []string            `json:"families"`
		Kinds    map[string][]string `json:"kinds"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		panic("plugins/languages/web/kinds.json: " + err.Error())
	}
	out := make(map[int]SymbolKind, len(doc.Kinds))
	for k, v := range doc.Kinds {
		n, err := strconv.Atoi(k)
		if err != nil || len(v) < 3 {
			continue
		}
		out[n] = SymbolKind{Name: v[0], Glyph: v[1], Family: v[2]}
	}
	return out
}

var symbolKindsTable = parseSymbolKinds(kindsJSON)

// SymbolKinds is the table of the symbol kinds the assistant and the page share.
func SymbolKinds() map[int]SymbolKind { return symbolKindsTable }

// SymbolKindName is the name of an LSP symbol kind ("" when the table does not know it).
func SymbolKindName(kind int) string { return symbolKindsTable[kind].Name }

// SymbolKindGlyph is the letter shown for a kind, SymbolKindFamily the family that colors it.
func SymbolKindGlyph(kind int) string  { return symbolKindsTable[kind].Glyph }
func SymbolKindFamily(kind int) string { return symbolKindsTable[kind].Family }
