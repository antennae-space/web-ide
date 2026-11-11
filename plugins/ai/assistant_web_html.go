package ai

import (
	"bytes"
	"net/url"
	"regexp"
	"strings"

	"golang.org/x/net/html"
)

// HTML to text for web_fetch: headings, links as [text](url), code blocks; the parts a reader
// does not see are dropped (scripts, styles, templates, hidden elements, comments), they are
// where injections hide. No readability heuristics.

// Elements dropped with their content.
var dropped = map[string]bool{"script": true, "style": true, "noscript": true, "iframe": true, "template": true, "head": true,
	"svg": true, "canvas": true, "object": true, "embed": true, "select": true, "button": true}

// Elements that start a new line.
var blocks = map[string]bool{"p": true, "div": true, "section": true, "article": true, "main": true, "header": true, "footer": true, "nav": true,
	"aside": true, "ul": true, "ol": true, "table": true, "tr": true, "blockquote": true, "dl": true, "dt": true, "dd": true, "figure": true,
	"figcaption": true, "form": true, "fieldset": true, "details": true, "summary": true, "hr": true, "address": true}

var hiddenStyle = regexp.MustCompile(`(?i)(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(px|em|rem|%)?\s*(;|$)|opacity\s*:\s*0(\.0+)?\s*(;|$))`)

func hidden(n *html.Node) bool {
	for _, a := range n.Attr {
		switch strings.ToLower(a.Key) {
		case "hidden":
			return true
		case "aria-hidden":
			if strings.EqualFold(a.Val, "true") {
				return true
			}
		case "style":
			if hiddenStyle.MatchString(a.Val) {
				return true
			}
		case "type":
			if n.Data == "input" && strings.EqualFold(a.Val, "hidden") {
				return true
			}
		}
	}
	return false
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			return a.Val
		}
	}
	return ""
}

// htmlText is the title, the text and the http(s) links of a page; base resolves the links.
func htmlText(body []byte, base *url.URL) (title, text string, links []string) {
	doc, err := html.Parse(bytes.NewReader(body))
	if err != nil {
		return "", strings.ToValidUTF8(string(body), ""), nil
	}
	var b strings.Builder
	pre := 0
	newline := func(n int) {
		s := b.String()
		have := len(s) - len(strings.TrimRight(s, "\n"))
		if len(s) == 0 {
			return
		}
		for ; have < n; have++ {
			b.WriteByte('\n')
		}
	}
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		switch n.Type {
		case html.CommentNode, html.DoctypeNode:
			return
		case html.TextNode:
			if pre > 0 {
				b.WriteString(n.Data)
			} else if t := spaces.ReplaceAllString(n.Data, " "); strings.TrimSpace(t) != "" || !strings.HasSuffix(b.String(), " ") && !strings.HasSuffix(b.String(), "\n") {
				b.WriteString(t)
			}
			return
		case html.ElementNode:
			tag := n.Data
			if dropped[tag] || hidden(n) {
				return
			}
			switch {
			case len(tag) == 2 && tag[0] == 'h' && tag[1] >= '1' && tag[1] <= '6':
				newline(2)
				b.WriteString(strings.Repeat("#", int(tag[1]-'0')) + " ")
				children(n, walk)
				newline(2)
				return
			case tag == "pre":
				newline(2)
				b.WriteString("```\n")
				pre++
				children(n, walk)
				pre--
				newline(1)
				b.WriteString("```")
				newline(2)
				return
			case tag == "code" && pre == 0:
				b.WriteString("`")
				children(n, walk)
				b.WriteString("`")
				return
			case tag == "a":
				href := ""
				if u, err := base.Parse(strings.TrimSpace(attr(n, "href"))); err == nil && (u.Scheme == "http" || u.Scheme == "https") {
					u.Fragment = ""
					href = u.String()
					links = append(links, href)
				}
				if href == "" || pre > 0 {
					children(n, walk)
					return
				}
				start := b.Len()
				children(n, walk)
				label := strings.TrimSpace(b.String()[start:])
				s := b.String()[:start]
				b.Reset()
				b.WriteString(s)
				if label == "" {
					label = href
				}
				b.WriteString("[" + label + "](" + href + ")")
				return
			case tag == "img":
				if alt := strings.TrimSpace(attr(n, "alt")); alt != "" {
					b.WriteString("[image: " + alt + "]")
				}
				return
			case tag == "br":
				b.WriteString("\n")
				return
			case tag == "li":
				newline(1)
				b.WriteString("- ")
				children(n, walk)
				newline(1)
				return
			case tag == "td" || tag == "th":
				children(n, walk)
				b.WriteString(" | ")
				return
			case blocks[tag]:
				newline(1)
				children(n, walk)
				newline(1)
				return
			}
		}
		children(n, walk)
	}
	walk(doc)
	var find func(n *html.Node)
	find = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "title" && n.FirstChild != nil && title == "" {
			title = oneLine(n.FirstChild.Data)
		}
		children(n, find)
	}
	find(doc)
	return title, tidy(b.String()), links
}

func children(n *html.Node, f func(*html.Node)) {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		f(c)
	}
}

var blankLines = regexp.MustCompile(`\n{3,}`)

// tidy trims the lines out of code blocks and keeps one blank line at most between blocks.
func tidy(s string) string {
	lines := strings.Split(s, "\n")
	code := false
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "```") {
			code = !code
			lines[i] = strings.TrimSpace(l)
			continue
		}
		if !code {
			lines[i] = strings.TrimSpace(l)
		}
	}
	return strings.TrimSpace(blankLines.ReplaceAllString(strings.Join(lines, "\n"), "\n\n"))
}

// stripTags is the text of a snippet with tags (the <strong> of a search result).
func stripTags(s string) string {
	if !strings.ContainsAny(s, "<&") {
		return s
	}
	_, text, _ := htmlText([]byte("<body>"+s+"</body>"), &url.URL{})
	return oneLine(text)
}
