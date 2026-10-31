package ai

import (
	"encoding/json"
	"strings"

	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/plugins/ai/llm"
	"antennae.space/ide/pod/assistant"
)

// Reasoning effort of an answer. Fixed by the user, or dynamic: the answer to a message of the
// user thinks the most (xhigh); one after tool results thinks less (medium), unless a call
// failed or was refused (xhigh again), or every call was a mechanical one that succeeded (low:
// the next step was decided before them). With set_effort turned on, the level the model
// chose since the last message of the user wins.

var efforts = map[string]bool{"xhigh": true, "medium": true, "low": true}

// mechanicalTools: steps decided before the call, whose success leaves little to think about.
var mechanicalTools = map[string]bool{
	"edit_file": true, "write_file": true, "open_file": true, "focus": true,
	"kanban_add_note": true, "kanban_update": true, "kanban_move": true, "agent_note": true,
}

// dynamicEffort: the user lets the assistant choose the effort at each step.
func dynamicEffort(o assistant.Options) bool {
	return !efforts[o.Effort]
}

// effortFor is the reasoning effort of the next answer of c.
func effortFor(c *engine.Chat, o assistant.Options) string {
	// A session of a ticket keeps the effort of its complexity.
	if c.Ticket != nil && c.Ticket.Effort != "" {
		o.Effort = c.Ticket.Effort
	}
	if !dynamicEffort(o) {
		return o.Effort
	}
	if o.EffortTool {
		for i := len(c.Messages) - 1; i >= 0; i-- {
			m := c.Messages[i]
			if isUserTurn(m) {
				break
			}
			if m.Role == "tool" && m.Name == "set_effort" && m.Status == "ok" && efforts[m.Effort] {
				return m.Effort
			}
		}
	}
	steps, mechanical := 0, true
	for i := len(c.Messages) - 1; i >= 0; i-- {
		m := c.Messages[i]
		if m.Role == "assistant" || isUserTurn(m) {
			if isUserTurn(m) || steps == 0 {
				return "xhigh"
			}
			break
		}
		if m.Role != "tool" || m.Name == "set_effort" {
			continue
		}
		steps++
		if m.Status == "error" || m.Status == "denied" {
			return "xhigh"
		}
		mechanical = mechanical && mechanicalTools[m.Name]
	}
	if steps > 0 && mechanical {
		return "low"
	}
	return "medium"
}

// isUserTurn: a message the model has not seen answered yet comes from outside (the user, a
// parent or a sub-agent); the summary of a compaction is not one.
func isUserTurn(m *engine.Message) bool {
	return m.Role == "user" && m.Kind != "summary"
}

// setEffort runs set_effort: the level is kept on the tool message, read by effortFor.
func setEffort(args map[string]json.RawMessage) (assistant.ToolResult, string) {
	var level string
	_ = json.Unmarshal(args["level"], &level)
	if !efforts[level] {
		return assistant.ToolResult{Content: "Error: level must be xhigh, medium or low.", Summary: assistant.T("invalid effort", nil).Raw(), Status: "error", Failure: "usage"}, ""
	}
	return assistant.ToolResult{Content: "Effort set to " + level + " until the user writes again.", Summary: assistant.Plain(level), Status: "ok"}, level
}

// A local model (llm.Caps.Local) reads the effort of the request at the top of its prompt
// (chat_template_kwargs), so changing it would make its server read the whole conversation
// again. Its requests keep the first effort of the conversation (Chat.Effort), and each change
// is written into the history as an effort note, after the last message sent, where every
// later request renders it again (#217).

// deepseekEffort: the values of the line DeepSeek was trained on (1-100); the IDE's xhigh is
// its Max (100).
var deepseekEffort = map[string]string{"low": "50", "medium": "62", "xhigh": "100"}

// genericEffort: the sentences of Qwen's chat template, for the other models.
var genericEffort = map[string]string{
	"low":    "Reasoning effort is set to low. Keep your thinking brief and focused, moving directly to the conclusion without unnecessary elaboration.",
	"medium": "Reasoning effort is set to medium. Think as much as the task needs, without unnecessary elaboration.",
	"xhigh":  "Reasoning effort is set to xhigh. Please think carefully through the task, validate key assumptions, consider plausible alternatives, and prioritize correctness, consistency, and clarity in the final answer.",
}

// effortText is the note telling the model the effort of its next answers.
func effortText(model, level string) string {
	if strings.Contains(strings.ToLower(model), "deepseek") {
		if n, ok := deepseekEffort[level]; ok {
			return "Reasoning Effort: " + n + " (range 1-100, the higher the value, the more thorough the reasoning)"
		}
	}
	return genericEffort[level]
}

// localEffort is the effort of the request to a local model for an answer at effort: the one
// of the conversation; a change is noted after the last message sent (system: as a system
// turn).
func localEffort(c *engine.Chat, model, effort string, system bool) string {
	if c.Effort == "" {
		c.Effort = effort
		return effort
	}
	carrier, current := -1, c.Effort
	for i := len(c.Messages) - 1; i >= 0; i-- {
		m := c.Messages[i]
		if m.Compacted || unsent(m) && !(m.Stuck && m.Resumed) {
			continue
		}
		if carrier < 0 {
			carrier = i
		}
		if m.EffortNote != nil {
			current = m.EffortNote.Level
			break
		}
	}
	if current == effort || carrier < 0 || effortText(model, effort) == "" {
		return c.Effort
	}
	m := c.Messages[carrier]
	// An answer is no place for a note (the model would read it as its own words).
	if m.Role == "assistant" && !m.Stuck {
		return c.Effort
	}
	m.EffortNote = &engine.EffortNote{Level: effort, Text: effortText(model, effort), System: system}
	return c.Effort
}

// withEffortNote is the message m as sent, with its effort note: the text appended to its
// content, or a system turn after it.
func withEffortNote(msg llm.Message, n *engine.EffortNote) []llm.Message {
	if n == nil {
		return []llm.Message{msg}
	}
	if n.System {
		return []llm.Message{msg, {Role: "system", Content: assistant.String(n.Text)}}
	}
	msg.Content = appendText(msg.Content, n.Text)
	return []llm.Message{msg}
}

// appendText adds a last paragraph to a content: to a string, or as a last text part of a
// message with images (the date and active file of withContext, an effort note).
func appendText(content json.RawMessage, text string) json.RawMessage {
	var s string
	if len(content) == 0 || json.Unmarshal(content, &s) == nil {
		if s = strings.TrimRight(s, "\n"); s != "" {
			s += "\n\n"
		}
		return assistant.String(s + text)
	}
	var parts []json.RawMessage
	if json.Unmarshal(content, &parts) != nil {
		return content
	}
	part, _ := json.Marshal(map[string]string{"type": "text", "text": text})
	data, _ := json.Marshal(append(parts, part))
	return data
}
