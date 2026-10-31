package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"antennae.space/ide/plugins/ai/llm"
)

// thinking is a streamed answer with its reasoning first.
func thinking(reasoning string, then []string) []string {
	data, _ := json.Marshal(reasoning)
	return append([]string{`{"choices":[{"delta":{"reasoning_content":` + string(data) + `}}]}`}, then...)
}

// The history sent only grows: each request starts with the messages of the request
// before it (the reasoning of the earlier turns, the tool results, the nudge after a stuck
// answer), so a server reads only the new messages (#215).
func TestAssistantRequestsKeepTheirPrefix(t *testing.T) {
	s, ts := newServer(t)
	model := &fakeModel{}
	mts := model.serve(t)
	if err := llmOf(s).SaveServer(llm.Server{ID: "s1", Kind: "llamacpp", URL: mts.URL}, false); err != nil {
		t.Fatal(err)
	}
	a, _ := dial(t, ts, "secret-token-0123456789abcdef0123")
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("un\n"), 0o644)
	id := a.call("projects.create", map[string]any{"type": "local", "path": dir})["result"].(map[string]any)["id"].(string)
	a.call("project.open", map[string]any{"id": id})

	n := 0
	model.answer = func(req map[string]any) []string {
		n++
		switch n {
		case 1: // turn 1: a tool step, then the answer
			return thinking("read it", toolCalls([3]string{"r1", "read_file", `{"path":"a.txt"}`}))
		case 2:
			return thinking("it says un", text("It says un."))
		case 3: // turn 2: stuck in its reasoning, asked again with the nudge
			return thinking("hmm", []string{`{"choices":[{"finish_reason":"stop","delta":{}}]}`})
		case 4:
			return thinking("answer now", text("Still un."))
		default: // turn 3
			return thinking("last", text("Bye."))
		}
	}
	for _, msg := range []string{"Read a.txt", "Again", "Bye"} {
		a.call("assistant.send", map[string]any{"id": "p1", "text": msg, "server": "s1", "model": "m"})
		a.waitUpdate("p1", idle)
	}

	model.mu.Lock()
	defer model.mu.Unlock()
	if len(model.requests) != 5 {
		t.Fatalf("%d requests", len(model.requests))
	}
	for k := 1; k < len(model.requests); k++ {
		prev := model.requests[k-1]["messages"].([]any)
		cur := model.requests[k]["messages"].([]any)
		if len(cur) <= len(prev) || !reflect.DeepEqual(cur[:len(prev)], prev) {
			t.Fatalf("request %d does not start with request %d:\n%v\n%v", k+1, k, prev, cur)
		}
	}
	// The reasoning of the first turn is still sent in the last request.
	last := model.requests[4]["messages"].([]any)
	if m := last[2].(map[string]any); m["role"] != "assistant" || m["reasoning_content"] != "read it" {
		t.Fatalf("reasoning of the first answer: %+v", m)
	}
}

// A local model keeps the first effort of the conversation in every request; the changes of
// the dynamic effort are written into the history (#217): a system turn after the message for
// DeepSeek, text appended to it for the others (Qwen's templates refuse a system message
// in the middle). Each request still starts with the one before.
func TestAssistantLocalEffortInHistory(t *testing.T) {
	for _, tc := range []struct{ model, medium, xhigh string }{
		{"qwen3-coder", "Reasoning effort is set to medium.", "Reasoning effort is set to xhigh."},
		{"deepseek-v4.1", "Reasoning Effort: 62 (range 1-100", "Reasoning Effort: 100 (range 1-100"},
	} {
		t.Run(tc.model, func(t *testing.T) {
			s, ts := newServer(t)
			model := &fakeModel{models: []string{tc.model}}
			mts := model.serve(t)
			// A server per model: the list of models is kept a while by server.
			if err := llmOf(s).SaveServer(llm.Server{ID: tc.model, Kind: "llamacpp", URL: mts.URL}, false); err != nil {
				t.Fatal(err)
			}
			a, _ := dial(t, ts, "secret-token-0123456789abcdef0123")
			dir := t.TempDir()
			os.WriteFile(filepath.Join(dir, "a.txt"), []byte("un\n"), 0o644)
			id := a.call("projects.create", map[string]any{"type": "local", "path": dir})["result"].(map[string]any)["id"].(string)
			a.call("project.open", map[string]any{"id": id})

			n := 0
			model.answer = func(req map[string]any) []string {
				n++
				if n == 1 {
					return thinking("read it", toolCalls([3]string{"r1", "read_file", `{"path":"a.txt"}`}))
				}
				return thinking("done", text("It says un."))
			}
			for _, msg := range []string{"Read a.txt", "Again"} {
				a.call("assistant.send", map[string]any{"id": "p1", "text": msg, "server": tc.model, "model": tc.model})
				a.waitUpdate("p1", idle)
			}

			model.mu.Lock()
			defer model.mu.Unlock()
			if len(model.requests) != 3 {
				t.Fatalf("%d requests", len(model.requests))
			}
			for k, req := range model.requests {
				if kw, _ := req["chat_template_kwargs"].(map[string]any); kw["reasoning_effort"] != "xhigh" {
					t.Fatalf("request %d: effort %v", k+1, req["chat_template_kwargs"])
				}
				if k > 0 {
					prev, cur := model.requests[k-1]["messages"].([]any), req["messages"].([]any)
					if len(cur) <= len(prev) || !reflect.DeepEqual(cur[:len(prev)], prev) {
						t.Fatalf("request %d does not start with request %d:\n%v\n%v", k+1, k, prev, cur)
					}
				}
			}
			// The note of a change is the last thing read before the answer: after the tool
			// result (medium), after the second message of the user (xhigh).
			deepseek := tc.model == "deepseek-v4.1"
			for k, want := range map[int]struct{ role, text string }{1: {"tool", tc.medium}, 2: {"user", tc.xhigh}} {
				msgs := model.requests[k]["messages"].([]any)
				last := msgs[len(msgs)-1].(map[string]any)
				content, _ := last["content"].(string)
				if deepseek {
					before := msgs[len(msgs)-2].(map[string]any)
					if last["role"] != "system" || !strings.HasPrefix(content, want.text) || before["role"] != want.role {
						t.Fatalf("request %d: %v then %v", k+1, before, last)
					}
				} else if last["role"] != want.role || !strings.Contains(content, "\n\n"+want.text) {
					t.Fatalf("request %d: %v", k+1, last)
				}
			}
		})
	}
}
