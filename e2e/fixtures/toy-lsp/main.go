// A tiny language server for the fixture language pack "toy" of the suite langpack (#145): it
// speaks LSP over stdio; a line holding "bad" gets an error; the completion offers "toyword" and
// the first word of $TOYLIB/words.txt (a folder the pack is granted); the first line gets a
// diagnostic telling whether its confinement held (the pod's key, writing the project).
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type msg struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
}

var out = bufio.NewWriter(os.Stdout)

func send(v any) {
	b, _ := json.Marshal(v)
	fmt.Fprintf(out, "Content-Length: %d\r\n\r\n%s", len(b), b)
	out.Flush()
}

func reply(id json.RawMessage, result any) {
	send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

// probe tells whether the server reached what its confinement forbids: the pod's key (its HOME is
// <data>/plugin-data/toy) or writing the project (its working folder, read only for it).
func probe() string {
	home, _ := os.UserHomeDir()
	_, key := os.ReadFile(filepath.Join(home, "..", "..", "device.key"))
	write := os.WriteFile("toy-probe.txt", []byte("x"), 0o644)
	if key == nil || write == nil {
		return "LEAK"
	}
	return "confined"
}

func diagnose(uri, text string) {
	diags := []any{map[string]any{"range": rng(0, 0, 1), "severity": 3, "message": "toy: " + probe()}}
	for i, l := range strings.Split(text, "\n") {
		if j := strings.Index(l, "bad"); j >= 0 {
			diags = append(diags, map[string]any{"range": rng(i, j, j+3), "severity": 1, "message": "bad toy"})
		}
	}
	send(map[string]any{"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": map[string]any{"uri": uri, "diagnostics": diags}})
}

func rng(line, from, to int) map[string]any {
	return map[string]any{"start": map[string]int{"line": line, "character": from}, "end": map[string]int{"line": line, "character": to}}
}

func main() {
	in := bufio.NewReader(os.Stdin)
	for {
		n := 0
		for {
			l, err := in.ReadString('\n')
			if err != nil {
				return
			}
			l = strings.TrimSpace(l)
			if l == "" {
				break
			}
			if v, ok := strings.CutPrefix(l, "Content-Length: "); ok {
				n, _ = strconv.Atoi(v)
			}
		}
		body := make([]byte, n)
		if _, err := io.ReadFull(in, body); err != nil {
			return
		}
		var m msg
		_ = json.Unmarshal(body, &m)
		var p struct {
			TextDocument   struct{ URI, Text string }
			ContentChanges []struct{ Text string }
		}
		_ = json.Unmarshal(m.Params, &p)
		switch m.Method {
		case "initialize":
			reply(m.ID, map[string]any{"capabilities": map[string]any{"textDocumentSync": 1, "completionProvider": map[string]any{}, "definitionProvider": true}})
		case "textDocument/didOpen":
			diagnose(p.TextDocument.URI, p.TextDocument.Text)
		case "textDocument/didChange":
			if len(p.ContentChanges) > 0 {
				diagnose(p.TextDocument.URI, p.ContentChanges[len(p.ContentChanges)-1].Text)
			}
		case "textDocument/completion":
			items := []any{map[string]any{"label": "toyword", "kind": 14}}
			if b, err := os.ReadFile(filepath.Join(os.Getenv("TOYLIB"), "words.txt")); err == nil {
				items = append(items, map[string]any{"label": strings.TrimSpace(string(b)), "kind": 6})
			}
			reply(m.ID, items)
		case "textDocument/definition":
			reply(m.ID, map[string]any{"uri": p.TextDocument.URI, "range": rng(0, 0, 3)})
		case "shutdown":
			reply(m.ID, nil)
		case "exit":
			return
		default:
			if m.ID != nil {
				reply(m.ID, nil)
			}
		}
	}
}
