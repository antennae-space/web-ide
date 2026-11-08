package engine

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"antennae.space/ide/pod/assistant"
)

// Suspect is a stuck alert: rules on the last steps of a conversation say it may go round in
// circles. It sits on the last message of the step that raised it (never a message of its
// own: the history sent to the model stays the same) and shows as a card in the thread.
type Suspect struct {
	// Rule: repeat (the same call with the same result), error (the same error), revert (an
	// edit undone), loop (an answer stuck again after the nudge).
	Rule string `json:"rule"`
	// Reason for the page (a Text); Detail in English, for a model that judges it.
	Reason json.RawMessage `json:"reason"`
	Detail string          `json:"detail"`
	// State: open, ignored (a false alert), stopped (the user stopped the turn).
	State string `json:"state"`
}

// SuspectRepeats: how many times the same call or error makes a conversation suspect.
const SuspectRepeats = 3

// waitingTools are called again and again while waiting for something: not a repeat.
var waitingTools = map[string]bool{"read_console": true, "agent_status": true}

var digits = regexp.MustCompile(`\d+`)

// FindSuspect applies the rules to the window of msgs: the messages after the last user
// message and after the last alert (one alert per window). Nil: nothing suspect.
func FindSuspect(msgs []*Message) *Suspect {
	start := 0
	for i := len(msgs) - 1; i >= 0; i-- {
		m := msgs[i]
		if m.Compacted || m.Suspect != nil || m.Role == "user" {
			start = i + 1
			break
		}
	}
	results := map[string]*Message{}
	for _, m := range msgs[start:] {
		if m.Role == "tool" {
			results[m.ToolCallID] = m
		}
	}
	calls, errs := map[string]int{}, map[string]int{}
	type edit struct{ path, old, new string }
	var edits []edit
	for _, m := range msgs[start:] {
		if m.Role != "assistant" {
			continue
		}
		for _, c := range m.ToolCalls {
			res := results[c.ID]
			if res == nil {
				continue
			}
			out := assistant.ContentText(res.Content)
			name := c.Function.Name
			if res.Status == "error" {
				key := name + "\x00" + digits.ReplaceAllString(strings.TrimSpace(out), "#")
				if errs[key]++; errs[key] == SuspectRepeats {
					return suspect("error", "The same error {n} times: {what}", name,
						fmt.Sprintf("The tool %s failed %d times with the same error: %s", name, SuspectRepeats, clip(out, 300)))
				}
			}
			if !waitingTools[name] {
				key := name + "\x00" + canonical(c.Function.Arguments) + "\x00" + out
				if calls[key]++; calls[key] == SuspectRepeats {
					return suspect("repeat", "The same call {n} times: {what}", name,
						fmt.Sprintf("The agent called %s %d times with the same arguments (%s) and got the same result each time.", name, SuspectRepeats, clip(canonical(c.Function.Arguments), 300)))
				}
			}
			if name == "edit_file" && res.Status == "ok" {
				var a struct {
					Path string `json:"path"`
					Old  string `json:"old_string"`
					New  string `json:"new_string"`
				}
				if json.Unmarshal([]byte(c.Function.Arguments), &a) == nil {
					for _, e := range edits {
						if e.path == a.Path && e.old == a.New && e.new == a.Old {
							return suspect("revert", "An edit undone: {what}", a.Path,
								fmt.Sprintf("The agent undid its own edit of %s: it goes back and forth between two versions.", a.Path))
						}
					}
					edits = append(edits, edit{a.Path, a.Old, a.New})
				}
			}
		}
	}
	return nil
}

// LoopSuspect is the alert of an answer stuck again after the nudge: the turn ends on it.
func LoopSuspect() *Suspect {
	return &Suspect{Rule: "loop", Reason: assistant.T("The reasoning went round in circles twice", nil).Raw(), State: "open",
		Detail: "Two answers in a row went round in circles in their reasoning, or ended in it without text nor action."}
}

func suspect(rule, reason, what, detail string) *Suspect {
	return &Suspect{Rule: rule, Reason: assistant.T(reason, map[string]any{"n": SuspectRepeats, "what": what}).Raw(), Detail: detail, State: "open"}
}

// canonical writes the arguments of a call with sorted keys: the same call, however written.
func canonical(args string) string {
	var v any
	if json.Unmarshal([]byte(args), &v) != nil {
		return strings.TrimSpace(args)
	}
	data, _ := json.Marshal(v)
	return string(data)
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
