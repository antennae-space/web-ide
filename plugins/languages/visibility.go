package languages

import (
	_ "embed"
	"encoding/json"
	"regexp"
)

// Whether a symbol is exported or private is one table, web/visibility.json: the page module
// reads it as JSON (web/visibility.ts), the pod reads the same file. A language absent from the
// table has no rule: its symbols carry no badge.
//
// A rule looks at the name or the detail of a symbol and matches a regular expression (a subset
// Go and JavaScript share); the first rule that matches decides, else the default of the
// language, else the default of the table.

//go:embed web/visibility.json
var visibilityJSON []byte

// Visibility is the exportability of a symbol: exported (open lock), private (closed lock), or
// none when the language has no rule (no badge).
type Visibility string

const (
	VisibilityExported Visibility = "exported"
	VisibilityPrivate  Visibility = "private"
	VisibilityNone     Visibility = "none"
)

type visibilityRule struct {
	Field      string `json:"field"`
	Match      string `json:"match"`
	Visibility string `json:"visibility"`
	re         *regexp.Regexp
}

type visibilityLanguage struct {
	Default string           `json:"default"`
	Rules   []visibilityRule `json:"rules"`
}

var visibilityTable struct {
	Default   string                        `json:"default"`
	Languages map[string]visibilityLanguage `json:"languages"`
}

// memberNameRe is the receiver prefix a server puts in front of a method name: gopls names a
// method (Greeter).Hello, and the first-letter rule must see Hello.
var memberNameRe = regexp.MustCompile(`^\([^)]*\)\.`)

// MemberName is the name of a symbol without its receiver prefix.
func MemberName(name string) string { return memberNameRe.ReplaceAllString(name, "") }

func parseVisibility(raw []byte) {
	var doc struct {
		Default   string                        `json:"default"`
		Languages map[string]visibilityLanguage `json:"languages"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		panic("plugins/languages/web/visibility.json: " + err.Error())
	}
	for lang, l := range doc.Languages {
		for i, r := range l.Rules {
			re, err := regexp.Compile(r.Match)
			if err != nil {
				panic("plugins/languages/web/visibility.json: " + lang + ": " + r.Match + ": " + err.Error())
			}
			l.Rules[i].re = re
		}
		doc.Languages[lang] = l
	}
	visibilityTable = doc
}

func init() { parseVisibility(visibilityJSON) }

// VisibilityOf is the visibility of a symbol of a language pack (its id, as the page names the
// language): the name and the detail as the server gives them. A language with no entry gets
// the default of the table: none, no badge.
func VisibilityOf(lang, name, detail string) Visibility {
	l, ok := visibilityTable.Languages[lang]
	if !ok {
		return Visibility(visibilityTable.Default)
	}
	for _, r := range l.Rules {
		field := detail
		if r.Field == "name" {
			field = MemberName(name)
		}
		if field != "" && r.re.MatchString(field) {
			return Visibility(r.Visibility)
		}
	}
	return Visibility(l.Default)
}
