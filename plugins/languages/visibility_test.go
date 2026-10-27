package languages

import "testing"

// The visibility table the page and the pod share (web/visibility.json): the rules per language
// that decide the lock badge of a symbol in Structure.
func TestVisibilityTable(t *testing.T) {
	if len(visibilityTable.Languages) < 5 {
		t.Fatalf("the table has %d languages, the packs give at least 5", len(visibilityTable.Languages))
	}
	cases := []struct {
		lang, name, detail string
		want               Visibility
	}{
		// Go: an uppercase first letter is an exported symbol.
		{"go", "Greeter", "struct", VisibilityExported},
		{"go", "(Greeter).Hello", "string", VisibilityExported},
		{"go", "Transport", "string", VisibilityExported},
		{"go", "maxFrame", "int", VisibilityPrivate},
		{"go", "newGreeter", "", VisibilityPrivate},
		{"go", "main", "", VisibilityPrivate},
		// JavaScript and TypeScript: export in the detail, private and protected members.
		{"javascript", "#field", "", VisibilityPrivate},
		{"typescript", "#field", "string", VisibilityPrivate},
		{"typescript", "total", "private number", VisibilityPrivate},
		{"typescript", "save", "protected void", VisibilityPrivate},
		{"typescript", "Transport", "export function Transport(): string", VisibilityExported},
		{"javascript", "helper", "function", VisibilityPrivate},
		{"typescript", "Greeter", "export class", VisibilityExported},
		// Python: a leading underscore is private.
		{"python", "_load", "", VisibilityPrivate},
		{"python", "__init__", "method", VisibilityPrivate},
		{"python", "main", "", VisibilityExported},
		// PHP: the modifiers of the detail.
		{"php", "total", "private function", VisibilityPrivate},
		{"php", "save", "protected static function", VisibilityPrivate},
		{"php", "total", "public function", VisibilityExported},
		{"php", "Invoice", "class", VisibilityExported},
		// A language with no rule: no badge.
		{"ruby", "Transport", "def", VisibilityNone},
		{"", "whatever", "", VisibilityNone},
	}
	for _, c := range cases {
		if got := VisibilityOf(c.lang, c.name, c.detail); got != c.want {
			t.Errorf("%s %q (%q): got %q, want %q", c.lang, c.name, c.detail, got, c.want)
		}
	}
	if n := MemberName("(Greeter).Hello"); n != "Hello" {
		t.Errorf("MemberName: got %q", n)
	}
	if n := MemberName("maxFrame"); n != "maxFrame" {
		t.Errorf("MemberName of a plain name: got %q", n)
	}
	for lang, l := range visibilityTable.Languages {
		if l.Default != "exported" && l.Default != "private" {
			t.Errorf("%s: default %q is not exported or private", lang, l.Default)
		}
		for _, r := range l.Rules {
			if r.Field != "name" && r.Field != "detail" {
				t.Errorf("%s: field %q is not name or detail", lang, r.Field)
			}
			if r.Visibility != "exported" && r.Visibility != "private" {
				t.Errorf("%s: visibility %q is not exported or private", lang, r.Visibility)
			}
		}
	}
}
