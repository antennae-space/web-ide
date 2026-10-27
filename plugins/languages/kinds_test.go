package languages

import "testing"

// The kinds table the page and the assistant share (web/kinds.json): the names the assistant
// prints, the glyph and the family of every kind.
func TestSymbolKindsTable(t *testing.T) {
	if len(symbolKindsTable) < 26 {
		t.Fatalf("the table has %d kinds, the LSP defines 26", len(symbolKindsTable))
	}
	for _, want := range []SymbolKind{
		{Name: "Class", Glyph: "C", Family: "type"},
		{Name: "Method", Glyph: "m", Family: "function"},
		{Name: "Function", Glyph: "ƒ", Family: "function"},
		{Name: "Variable", Glyph: "v", Family: "variable"},
		{Name: "Number", Glyph: "#", Family: "value"},
		{Name: "File", Glyph: "F", Family: "other"},
	} {
		var got SymbolKind
		for _, k := range symbolKindsTable {
			if k.Name == want.Name {
				got = k
				break
			}
		}
		if got != want {
			t.Errorf("%s: got %+v", want.Name, got)
		}
	}
	for kind, k := range symbolKindsTable {
		if k.Name == "" || k.Glyph == "" || k.Family == "" {
			t.Errorf("kind %d: incomplete entry %+v", kind, k)
		}
	}
	if n := SymbolKindName(999); n != "" {
		t.Errorf("an unknown kind has no name, got %q", n)
	}
}
