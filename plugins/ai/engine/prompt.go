package engine

import (
	"regexp"
	"strconv"
	"strings"
	"time"

	"antennae.space/ide/plugins/ai/llm"
)

// DefaultTemplates are the templates of the modes when the user wrote none.
var DefaultTemplates = map[string]string{Build: defaultTemplate, Plan: defaultPlanTemplate, Briefing: defaultBriefingTemplate, Orchestrator: defaultOrchestratorTemplate}

var toolsTexts = map[string]string{Build: toolsText, Plan: planToolsText, Briefing: briefingToolsText, Orchestrator: orchestratorToolsText}

// Template returns the template of a mode: the one of the project, else the global one,
// else the default.
func Template(c *llm.Context, mode string) string {
	if c != nil {
		global, project := c.GlobalPrompt, c.ProjectPrompt
		switch mode {
		case Plan:
			global, project = c.GlobalPlanPrompt, c.ProjectPlanPrompt
		case Briefing:
			global, project = c.GlobalBriefingPrompt, c.ProjectBriefingPrompt
		}
		if project != nil && strings.TrimSpace(*project) != "" {
			return *project
		}
		if global != nil && strings.TrimSpace(*global) != "" {
			return *global
		}
	}
	if t, ok := DefaultTemplates[mode]; ok {
		return t
	}
	return defaultTemplate
}

// PromptVars are the values of the placeholders of a template.
type PromptVars struct {
	Project string
	Root    string
	// Host: the SSH host of a remote project ("" for a local one).
	Host string
}

var placeholder = regexp.MustCompile(`\{\{(\w+)\}\}`)
var blankLines = regexp.MustCompile(`\n{3,}`)

// SystemPrompt is the final system prompt: the template of the mode with its placeholders,
// the instruction files, the ticket linked to the conversation, and the skills.
//
// It stays the same from one request to the next of a conversation (apart from a change of
// mode or a compaction), so that a server keeps its prompt cache: what changes during a
// conversation (the date, the active file) comes with the messages of the user (Stamp), the
// ticket is read with kanban_get. {{activeFile}} and {{date}} are kept empty for the
// templates of the user that still have them.
func SystemPrompt(c *llm.Context, v PromptVars, tools bool, mode, ticket string) string {
	vars := map[string]string{
		"project":    v.Project,
		"root":       v.Root,
		"host":       "",
		"activeFile": "",
		"date":       "",
		"tools":      "",
	}
	if v.Host != "" {
		vars["host"] = " on the SSH host " + v.Host
	}
	if tools {
		vars["tools"] = toolsTexts[mode]
		if vars["tools"] == "" {
			vars["tools"] = toolsText
		}
	}
	text := placeholder.ReplaceAllStringFunc(Template(c, mode), func(m string) string {
		if val, ok := vars[m[2:len(m)-2]]; ok {
			return val
		}
		return m
	})
	text = strings.TrimSpace(blankLines.ReplaceAllString(text, "\n\n"))
	if c != nil && len(c.Files) > 0 {
		text += "\n\n# Instructions"
		text += "\nInstructions of the user (global) and of the project. They come before your habits; the project ones come before the global ones."
		for _, f := range c.Files {
			scope := "Project"
			p := f.Path
			if f.Scope == "global" {
				scope = "Global"
				p = homePath.ReplaceAllString(p, "~")
			} else {
				p = strings.TrimPrefix(strings.TrimPrefix(p, v.Root), "/")
			}
			text += "\n\n## " + scope + " · " + p + "\n" + strings.TrimSpace(f.Content)
		}
	}
	if ticket != "" {
		text += "\n\n" + ticket
	}
	if c != nil && len(c.Skills) > 0 && tools {
		text += "\n\n# Skills"
		text += "\nAvailable skills. When a request matches one of them, load its instructions with load_skill(name) before acting; read_skill_file reads its other files."
		for _, s := range c.Skills {
			d := s.Description
			if d == "" {
				d = "(no description)"
			}
			text += "\n- " + s.Name + ": " + d
		}
	}
	return text
}

var homePath = regexp.MustCompile(`^/home/[^/]+`)

// TicketPrompt is the part of the system prompt about the ticket linked to a conversation:
// what its role must do, then the ticket as the model reads it. Without the Markdown (the
// assistant with its tools: the ticket changes during the conversation, the system prompt
// must not), the model reads the ticket with kanban_get.
func TicketPrompt(id int64, role, branch string, parent, feedback int64, markdown string) string {
	b := ""
	if branch != "" {
		b = " on the branch " + branch + ", in its worktree (the root of the open project)"
		if parent != 0 {
			b += ", shared with its lineage: this ticket is a step of #" + itoa(parent) + ", develop only this step, on top of the previous ones"
		}
	}
	fb := "the open feedback (not checked yet)"
	if feedback != 0 {
		fb = "the feedback with id " + itoa(feedback)
	}
	r := strings.NewReplacer("{{branch}}", b, "{{feedback}}", fb, "{{id}}", itoa(id)).Replace(RoleInstructions[role])
	text := "# Ticket linked to this conversation\nThis conversation works on ticket #" + itoa(id) +
		" of the kanban of the project. The tools kanban_update, kanban_add_note, kanban_set_plan, kanban_goal, kanban_feedback and kanban_move act on this ticket.\n\n" + r
	if markdown == "" {
		return text + "\n\nRead the ticket with kanban_get (id " + itoa(id) + ") before you start: its description, notes, plan, goals and test feedback. It changes during the conversation (your changes, the user's): read it again when you need its current state."
	}
	return text + "\n\n" + markdown
}

// Now is the clock of the dates noted on the messages (tests set it).
var Now = time.Now

// contextText tells the model how the messages of the user carry the date and the active file.
const contextText = `A message of the user may end with a note in parentheses: the date, and the file active in the editor ("this file"). Each is noted again only when it changed.`

// AddUser appends a message of the user to the conversation, stamped (Stamp).
func (c *Chat) AddUser(m *Message) {
	Stamp(c, m)
	c.Messages = append(c.Messages, m)
}

// Stamp notes on a message of the user entering the conversation the date and the file active
// in the editor (Options.ActiveFile, relative to the root), each when it differs from the last
// one carried by a message still sent (a compacted one no longer counts): the system prompt
// stays the same, these come with the messages (Context).
func Stamp(c *Chat, m *Message) {
	activeFile := ""
	if c.Options != nil {
		activeFile = c.Options.ActiveFile
	}
	date, file := "", ""
	for _, p := range c.Messages {
		if p.Role == "user" && !p.Compacted {
			if p.Date != "" {
				date = p.Date
			}
			if p.ActiveFile != "" {
				file = p.ActiveFile
			}
		}
	}
	if d := Now().Format("Monday, January 2, 2006"); d != date {
		m.Date = d
	}
	if activeFile != "" && activeFile != file {
		m.ActiveFile = activeFile
	}
}

// Context is the note added to the content sent to the model of a message carrying a date or
// an active file ("" for none).
func Context(m *Message) string {
	var parts []string
	if m.Date != "" {
		parts = append(parts, "Date: "+m.Date+".")
	}
	if m.ActiveFile != "" {
		parts = append(parts, "Active file in the editor: "+m.ActiveFile+".")
	}
	if len(parts) == 0 {
		return ""
	}
	return "(" + strings.Join(parts, " ") + ")"
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
