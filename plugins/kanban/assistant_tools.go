package kanban

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	kb "antennae.space/ide/plugins/kanban/kanban"
	"antennae.space/ide/pod/assistant"
)

// The kanban tools of the assistant (docs/design/kanban.md), run by the Kanban for it (#158):
// every conversation reads the tickets and creates some (in Briefing mode the conversation is
// linked to the first one); a conversation linked to a ticket changes that ticket only. The AI
// declares them (its modes choose them) and sends each call to kanban.assistantTool with the
// conversation (ToolContext); the Orchestrator's kanban_next and kanban_history too.

// briefing is the mode of a Briefing conversation of the assistant.
const briefing = "briefing"

// ToolContext is the conversation of a call of a kanban tool of the assistant.
type ToolContext struct {
	Chat struct {
		ID     string      `json:"id"`
		Title  string      `json:"title"`
		Ticket *TicketLink `json:"ticket,omitempty"`
	} `json:"chat"`
	Mode string `json:"mode"`
	// Doodles are the pages of the board of the conversation, as PNG data URLs, attached to the
	// ticket it creates or updates.
	Doodles []Doodle `json:"doodles,omitempty"`
	// Linked is set by kanban_create in a Briefing conversation not linked yet: the ticket it
	// is now linked to.
	Linked int64 `json:"linked,omitempty"`
}

// TicketLink is the ticket a conversation is linked to, with its role.
type TicketLink struct {
	ID   int64  `json:"id"`
	Role string `json:"role"`
}

// Doodle is a page of the board of a conversation: its file name and its PNG as a data URL.
type Doodle struct {
	Name string `json:"name"`
	PNG  string `json:"png"`
}

func (s *K) registerAssistantTools() {
	s.registerAIMethods()
	s.handle("kanban.assistantTool", func(ctx context.Context, c *client, p json.RawMessage) (any, error) {
		a, err := bind[struct {
			Name    string         `json:"name"`
			Args    assistant.Args `json:"args"`
			Context ToolContext    `json:"context"`
		}](p)
		if err != nil {
			return nil, err
		}
		root, err := s.kanbanProject(c.project)
		if err != nil {
			return nil, err
		}
		k := s.clientGit(c, root)
		var res assistant.ToolResult
		switch a.Name {
		case "kanban_next":
			res, err = s.kanbanNext(ctx, k)
		case "kanban_history":
			res, err = s.kanbanHistory(k, a.Args.Str("from"), a.Args.Str("to"))
		default:
			res, err = s.assistantCall(ctx, k, &a.Context, a.Name, a.Args)
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{"result": res, "linked": a.Context.Linked}, nil
	})
}

// What else the AI asks the Kanban (#158): the ticket as Markdown for the system prompt of a
// conversation linked to it, and the new title of a conversation the tickets list.
func (s *K) registerAIMethods() {
	s.handle("kanban.markdown", func(ctx context.Context, c *client, p json.RawMessage) (any, error) {
		a, err := bind[struct {
			ID int64 `json:"id"`
		}](p)
		if err != nil {
			return nil, err
		}
		root, err := s.kanbanProject(c.project)
		if err != nil {
			return nil, err
		}
		t, err := s.Kanban.Get(kanbanLoc(root), a.ID)
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": t.ID, "parent": t.Parent, "branch": t.Branch, "markdown": kb.Markdown(t)}, nil
	})
	// The ticket an MCP client works on in the worktree of a ticket: the active step of its
	// lineage.
	s.handle("kanban.worktreeTicket", func(ctx context.Context, c *client, p json.RawMessage) (any, error) {
		a, err := bind[struct {
			Ticket int64 `json:"ticket"`
		}](p)
		if err != nil {
			return nil, err
		}
		root, err := s.kanbanProject(c.project)
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": s.activeStep(kanbanLoc(root), a.Ticket)}, nil
	})
	s.handle("kanban.renameChat", func(ctx context.Context, c *client, p json.RawMessage) (any, error) {
		a, err := bind[struct {
			Chat  string `json:"chat"`
			Title string `json:"title"`
		}](p)
		if err != nil {
			return nil, err
		}
		root, err := s.kanbanProject(c.project)
		if err != nil {
			return nil, err
		}
		s.Kanban.RenameChat(kanbanLoc(root), a.Chat, a.Title)
		return map[string]any{}, nil
	})
}

// attachDoodles joins the pages of the board not attached yet to a ticket, as PNG files.
func (s *K) attachDoodles(k gctx, tc *ToolContext, id int64) int {
	t, err := s.Kanban.Get(k.loc, id)
	if err != nil {
		return 0
	}
	existing := map[string]bool{}
	for _, a := range t.Attachments {
		existing[a.Name] = true
	}
	added := 0
	for _, d := range tc.Doodles {
		if existing[d.Name] || !strings.Contains(d.PNG, ",") {
			continue
		}
		data, err := base64.StdEncoding.DecodeString(d.PNG[strings.Index(d.PNG, ",")+1:])
		if err != nil {
			continue
		}
		if _, err := s.Kanban.AddAttachment(k.loc, id, d.Name, "image/png", data); err == nil {
			added++
		}
	}
	return added
}

func doodlesNote(n int) string {
	if n == 0 {
		return ""
	}
	s := ""
	if n > 1 {
		s = "s"
	}
	return fmt.Sprintf(" %d doodle%s of the conversation attached to it as PNG files.", n, s)
}

func (s *K) assistantCall(ctx context.Context, k gctx, tc *ToolContext, name string, a assistant.Args) (assistant.ToolResult, error) {
	loc := k.loc
	mode := tc.Mode
	changed := func(id int64) { s.emitKanban(k.root.ID, id, nil) }
	switch name {
	case "kanban_list":
		list, err := s.Kanban.List(loc)
		if err != nil {
			return assistant.ToolResult{}, err
		}
		s.fillBlockers(ctx, k, list)
		status, q := kb.NormStatus(a.Str("status")), strings.ToLower(a.Str("query"))
		var lines []string
		for _, t := range list {
			if status != "" && t.Status != status || q != "" && !strings.Contains(strings.ToLower(t.Title), q) {
				continue
			}
			line := fmt.Sprintf("#%d [%s] (%s) %s", t.ID, kb.StatusNames[t.Status], kb.PriorityNames[t.Priority], t.Title)
			if t.Size != "" {
				line += " · size " + kb.SizeNames[t.Size]
			}
			if t.Complexity != "" {
				line += " · complexity " + kb.ComplexityNames[t.Complexity]
			}
			if t.Goals > 0 {
				line += fmt.Sprintf(" · goals %d/%d", t.GoalsDone, t.Goals)
			}
			if t.FeedbackOpen > 0 {
				line += fmt.Sprintf(" · open feedback %d", t.FeedbackOpen)
			}
			if t.Parent != 0 {
				line += fmt.Sprintf(" · step of #%d", t.Parent)
			}
			if len(t.Blockers) > 0 {
				line += " · blocked by " + kb.BlockersText(t.Blockers)
			}
			lines = append(lines, line)
		}
		if len(lines) == 0 {
			return assistant.OK("No ticket.", assistant.Tn(0, "{n} ticket", "{n} tickets", nil)), nil
		}
		return assistant.OK(strings.Join(lines, "\n"), assistant.Tn(len(lines), "{n} ticket", "{n} tickets", nil)), nil
	case "kanban_get":
		t, err := s.Kanban.Get(loc, int64(a.Num("id")))
		if err != nil {
			return assistant.ToolResult{}, err
		}
		if kb.Startable(t.Status) && (t.Parent != 0 || len(t.DependsOn) > 0) {
			t.Blockers, _ = s.ticketBlockers(ctx, k, t.ID)
		}
		return assistant.OKPlain(kb.Markdown(t), fmt.Sprintf("#%d %s", t.ID, t.Title)), nil
	case "kanban_create":
		title := strings.TrimSpace(a.Str("title"))
		if title == "" {
			return assistant.ToolResult{}, assistant.Usagef("title is missing")
		}
		if long := tooLongDescription(a.Str("description")); long != nil {
			return *long, nil
		}
		p := kb.Patch{Title: &title, Description: a.OptStr("description"), Priority: a.OptStr("priority"), AddFiles: a.Strs("files")}
		links(a, &p)
		id, err := s.Kanban.Create(loc, p, kb.ByModel)
		if err != nil {
			return assistant.ToolResult{}, err
		}
		changed(id)
		done := fmt.Sprintf("Ticket #%d created in the backlog (status New).%s", id, doodlesNote(s.attachDoodles(k, tc, id)))
		sum := assistant.T("#{id} created", map[string]any{"id": id})
		if mode != briefing {
			return assistant.OK(done, sum), nil
		}
		// Briefing: the ticket lists this conversation; the first one created is linked to it
		// (Linked tells the assistant).
		if tc.Chat.Ticket == nil {
			tc.Linked = id
			return assistant.OK(done+" This conversation is now linked to it: kanban_update and kanban_add_note refine it.", sum), nil
		}
		_ = s.Kanban.LinkChat(loc, id, tc.Chat.ID, "briefing", tc.Chat.Title)
		return assistant.OK(fmt.Sprintf("%s It lists this conversation as its briefing; this conversation stays linked to ticket #%d.", done, tc.Chat.Ticket.ID), sum), nil
	}
	link, chatID, chatTitle := tc.Chat.Ticket, tc.Chat.ID, tc.Chat.Title
	if name == "kanban_milestone" {
		return s.assistantMilestone(k, loc, a, mode, chatID, chatTitle)
	}
	if name == "kanban_objective" {
		var args objectiveArgs
		raw, _ := json.Marshal(a)
		if err := json.Unmarshal(raw, &args); err != nil {
			return assistant.ToolResult{}, assistant.Usagef("invalid arguments: %v", err)
		}
		out, err := s.objectiveTool(k.root.ID, loc, args, kb.ByModel, chatID)
		if err != nil {
			return assistant.ToolResult{}, err
		}
		return assistant.OK(out, assistant.T("objective", nil)), nil
	}
	if link == nil {
		return assistant.ToolResult{Content: "Error: this conversation is not linked to a ticket; only kanban_list, kanban_get and kanban_create are available.", Summary: assistant.T("no linked ticket", nil).Raw(), Status: "error"}, nil
	}
	id := link.ID
	defer changed(id)
	switch name {
	case "kanban_update":
		if long := tooLongDescription(a.Str("description")); long != nil {
			return *long, nil
		}
		p := kb.Patch{Title: a.OptStr("title"), Description: a.OptStr("description"), Priority: a.OptStr("priority"), TestSummary: a.OptStr("test_summary"),
			Size: a.OptStr("size"), Complexity: a.OptStr("complexity"), AddFiles: a.Strs("add_files"), RemoveFiles: a.Strs("remove_files")}
		links(a, &p)
		if err := s.Kanban.Update(loc, id, p, kb.ByModel); err != nil {
			return assistant.ToolResult{}, err
		}
		return assistant.OK(fmt.Sprintf("Ticket #%d updated.%s", id, doodlesNote(s.attachDoodles(k, tc, id))), assistant.T("#{id} updated", map[string]any{"id": id})), nil
	case "kanban_add_note":
		text := strings.TrimSpace(a.Str("text"))
		if n := len([]rune(text)); n > assistant.MaxNote {
			return assistant.ToolResult{Content: fmt.Sprintf("Error: note too long (%d characters, %d max). Keep only what is worth remembering, in a few lines; the details belong in the description (kanban_update) or the plan.", n, assistant.MaxNote),
				Summary: assistant.T("note too long", nil).Raw(), Status: "error"}, nil
		}
		if err := s.Kanban.AddNote(loc, id, text, kb.ByModel, chatID); err != nil {
			return assistant.ToolResult{}, err
		}
		return assistant.OK("Note added.", assistant.T("note added", nil)), nil
	case "kanban_set_plan":
		var goals []kb.GoalInput
		_ = json.Unmarshal(a["goals"], &goals)
		var kept []kb.GoalInput
		for _, g := range goals {
			if strings.TrimSpace(g.Title) != "" {
				kept = append(kept, g)
			}
		}
		plan := a.Str("plan")
		if strings.TrimSpace(plan) == "" {
			return assistant.ToolResult{}, assistant.Usagef("empty plan")
		}
		size := a.Str("size")
		if size == "" {
			return assistant.ToolResult{}, assistant.Usagef("size is required: s, m, l or xl")
		}
		complexity := a.Str("complexity")
		if complexity == "" {
			return assistant.ToolResult{}, assistant.Usagef("complexity is required: low, medium or high")
		}
		if err := s.Kanban.Update(loc, id, kb.Patch{Size: &size, Complexity: &complexity, PlanSize: true}, kb.ByModel); err != nil {
			return assistant.ToolResult{}, err
		}
		if err := s.Kanban.SetPlan(loc, id, plan, kept, kb.ByModel); err != nil {
			return assistant.ToolResult{}, err
		}
		t, err := s.Kanban.Get(loc, id)
		if err != nil {
			return assistant.ToolResult{}, err
		}
		moved := ""
		if t.Status == kb.Todo {
			moved = ` The ticket is now "To do".`
		}
		var lines []string
		for _, g := range t.GoalList {
			lines = append(lines, fmt.Sprintf("- (id %d) %s", g.ID, g.Text))
		}
		return assistant.OK(fmt.Sprintf("Plan saved with %d goal(s):%s\n%s", len(kept), moved, strings.Join(lines, "\n")), assistant.Tn(len(kept), "plan · {n} goal", "plan · {n} goals", nil)), nil
	case "kanban_goal":
		switch action := a.Str("action"); action {
		case "add":
			title := a.Str("title")
			if title == "" {
				title = a.Str("text")
			}
			if err := s.Kanban.Goal(loc, id, kb.GoalOp{Op: "add", Text: title, Description: a.Str("description"), Source: "plan"}); err != nil {
				return assistant.ToolResult{}, err
			}
			t, _ := s.Kanban.Get(loc, id)
			gid := int64(0)
			if t != nil && len(t.GoalList) > 0 {
				gid = t.GoalList[len(t.GoalList)-1].ID
			}
			return assistant.OK(fmt.Sprintf("Goal added (id %d).", gid), assistant.T("goal added", nil)), nil
		case "check", "uncheck":
			gid := int64(a.Num("id"))
			if err := s.Kanban.Goal(loc, id, kb.GoalOp{Op: "check", ID: gid, Done: action == "check"}); err != nil {
				return assistant.ToolResult{}, err
			}
			t, err := s.Kanban.Get(loc, id)
			if err != nil {
				return assistant.ToolResult{}, err
			}
			text, left := fmt.Sprint(gid), 0
			for _, g := range t.GoalList {
				if g.ID == gid {
					text = g.Text
				}
				if !g.Done {
					left++
				}
			}
			mark, word := "☑", "checked"
			if action == "uncheck" {
				mark, word = "☐", "unchecked"
			}
			return assistant.OKPlain(fmt.Sprintf("Goal %s: %s. %d goal(s) left.", word, text, left), mark+" "+text), nil
		case "edit":
			if err := s.Kanban.GoalEdit(loc, id, int64(a.Num("id")), a.Str("title"), a.Str("description")); err != nil {
				return assistant.ToolResult{}, err
			}
			return assistant.OK("Goal edited.", assistant.T("goal edited", nil)), nil
		case "delete":
			if err := s.Kanban.Goal(loc, id, kb.GoalOp{Op: "delete", ID: int64(a.Num("id"))}); err != nil {
				return assistant.ToolResult{}, err
			}
			return assistant.OK("Goal deleted.", assistant.T("goal deleted", nil)), nil
		default:
			return assistant.ToolResult{}, assistant.Usagef("unknown action: %s", action)
		}
	case "kanban_feedback":
		action := a.Str("action")
		if action == "add" {
			if a.Str("complexity") == "" {
				return assistant.ToolResult{}, assistant.Usagef("complexity is required: low, medium or high")
			}
			fid, err := s.Kanban.Feedback(loc, id, kb.FeedbackOp{Op: "add", Kind: a.Str("kind"), Text: a.Str("text"), Complexity: a.Str("complexity"), ChatID: chatID}, kb.ByModel)
			if err != nil {
				return assistant.ToolResult{}, err
			}
			s.NotifyFeedback(loc, id, a.Str("text"))
			return assistant.OK(fmt.Sprintf("Feedback added (id %d).", fid), assistant.T("feedback added", nil)), nil
		}
		if action != "done" && action != "reopen" {
			return assistant.ToolResult{}, assistant.Usagef("unknown action: %s", action)
		}
		fid := int64(a.Num("id"))
		if _, err := s.Kanban.Feedback(loc, id, kb.FeedbackOp{Op: "check", ID: fid, Done: action == "done"}, kb.ByModel); err != nil {
			return assistant.ToolResult{}, err
		}
		t, err := s.Kanban.Get(loc, id)
		if err != nil {
			return assistant.ToolResult{}, err
		}
		text, left := fmt.Sprint(fid), 0
		for _, f := range t.FeedbackList {
			if f.ID == fid {
				text = f.Text
			}
			if !f.Done {
				left++
			}
		}
		short := []rune(text)
		mark, word := "☑", "marked done"
		if action == "reopen" {
			mark, word = "☐", "reopened"
		}
		return assistant.OKPlain(fmt.Sprintf("Feedback %s: %s. %d open feedback left.", word, string(short[:min(80, len(short))]), left), mark+" "+string(short[:min(60, len(short))])), nil
	case "kanban_move":
		status := kb.NormStatus(a.Str("status"))
		if status == kb.ToTest {
			summary := strings.TrimSpace(a.Str("test_summary"))
			if summary == "" {
				return assistant.ToolResult{}, fmt.Errorf(`test_summary is required to move to "To test"`)
			}
			if err := s.Kanban.Update(loc, id, kb.Patch{TestSummary: &summary}, kb.ByModel); err != nil {
				return assistant.ToolResult{}, err
			}
		}
		if err := s.Kanban.Move(loc, id, status, kb.ByModel, a.Str("comment")); err != nil {
			return assistant.ToolResult{}, err
		}
		t, err := s.Kanban.Get(loc, id)
		if err != nil {
			return assistant.ToolResult{}, err
		}
		return assistant.OK(fmt.Sprintf(`Ticket #%d moved to "%s".`, id, kb.StatusNames[t.Status]), assistant.T(kb.StatusNames[t.Status], nil).With("→ ", "")), nil
	}
	return assistant.ToolResult{}, assistant.Usagef("unknown tool: %s", name)
}

func tooLongDescription(text string) *assistant.ToolResult {
	n := len([]rune(strings.TrimSpace(text)))
	if n <= assistant.MaxDescription {
		return nil
	}
	return &assistant.ToolResult{
		Content: fmt.Sprintf("Error: description too long (%d characters, %d max). Keep the context, the need and the acceptance criteria, in short sentences; decisions go in notes (kanban_add_note), the approach in the plan.", n, assistant.MaxDescription),
		Summary: assistant.T("description too long", nil).Raw(),
		Status:  "error",
	}
}

// links sets the lineage, the milestone and the objective given in a on p.
func links(a assistant.Args, p *kb.Patch) {
	if a.Has("parent") {
		v := int64(a.Num("parent"))
		p.Parent = &v
	}
	if a.Has("depends_on") {
		var deps []int64
		_ = json.Unmarshal(a["depends_on"], &deps)
		if deps == nil {
			deps = []int64{}
		}
		p.DependsOn = &deps
	}
	if a.Has("milestone") {
		v := int64(a.Num("milestone"))
		p.Milestone = &v
	}
	if a.Has("objective") {
		v := int64(a.Num("objective"))
		p.Objective = &v
	}
}

// assistantMilestone runs kanban_milestone: every conversation reads the milestones and creates
// some (in Briefing mode it is linked to the ones it creates); it changes only the milestones
// it is linked to.
func (s *K) assistantMilestone(k gctx, loc kb.Location, a assistant.Args, mode, chatID, chatTitle string) (assistant.ToolResult, error) {
	var args milestoneArgs
	raw, _ := json.Marshal(a)
	if err := json.Unmarshal(raw, &args); err != nil {
		return assistant.ToolResult{}, assistant.Usagef("invalid arguments: %v", err)
	}
	switch args.Action {
	case "list", "get", "create":
	default:
		if !s.Kanban.MilestoneLinked(loc, args.ID, chatID) {
			return assistant.ToolResult{}, fmt.Errorf("this conversation is not linked to milestone %d: only list, get and create are available on it", args.ID)
		}
	}
	out, created, err := s.milestoneTool(k.root.ID, loc, args, kb.ByModel, chatID)
	if err != nil {
		return assistant.ToolResult{}, err
	}
	if created != 0 && mode == briefing {
		if err := s.Kanban.LinkMilestoneChat(loc, created, chatID, "briefing", chatTitle); err == nil {
			out += " This conversation is linked to it: it can change it."
		}
	}
	return assistant.OK(out, assistant.T("milestone", nil)), nil
}
func ticketLine(t kb.Summary) string {
	line := fmt.Sprintf("#%d [%s] (%s) %s", t.ID, kb.StatusNames[t.Status], kb.PriorityNames[t.Priority], t.Title)
	if t.Size != "" {
		line += " · size " + kb.SizeNames[t.Size]
	}
	if t.Parent != 0 {
		line += fmt.Sprintf(" · step of #%d", t.Parent)
	}
	return line
}

func (s *K) kanbanNext(ctx context.Context, k gctx) (assistant.ToolResult, error) {
	list, err := s.Kanban.List(k.loc)
	if err != nil {
		return assistant.ToolResult{}, err
	}
	s.fillBlockers(ctx, k, list)
	objectives, err := s.Kanban.Objectives(k.loc)
	if err != nil {
		return assistant.ToolResult{}, err
	}
	next := kb.Next(list, objectives)
	var b strings.Builder
	b.WriteString("Can start now, in order:\n")
	if len(next) == 0 {
		b.WriteString("(none)\n")
	}
	for _, t := range next {
		b.WriteString("- " + ticketLine(t) + "\n")
	}
	if w := kb.Waiting(list); len(w) > 0 {
		b.WriteString("\nWaiting for the user:\n")
		for _, t := range w {
			line := "- " + ticketLine(t)
			if t.Status == kb.ToTest {
				line += " · to test and validate"
			}
			if t.FeedbackOpen > 0 {
				line += fmt.Sprintf(" · %d feedback to handle", t.FeedbackOpen)
			}
			b.WriteString(line + "\n")
		}
	}
	var blocked []string
	for _, t := range list {
		if t.Status == kb.Todo && len(t.Blockers) > 0 {
			blocked = append(blocked, fmt.Sprintf("#%d (waits for %s)", t.ID, kb.BlockersText(t.Blockers)))
		}
	}
	if len(blocked) > 0 {
		b.WriteString("\nBlocked: " + strings.Join(blocked, ", ") + "\n")
	}
	return assistant.OK(strings.TrimSpace(b.String()), assistant.Tn(len(next), "{n} ticket can start", "{n} tickets can start", nil)), nil
}

// parseDay reads "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" in local time.
func parseDay(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{"2006-01-02 15:04", "2006-01-02T15:04", "2006-01-02"} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t, nil
		}
	}
	return time.Time{}, assistant.Usagef("invalid date %q: use YYYY-MM-DD or YYYY-MM-DD HH:MM", s)
}

func (s *K) kanbanHistory(k gctx, fromArg, toArg string) (assistant.ToolResult, error) {
	now := time.UnixMilli(s.Kanban.Now()).In(time.Local)
	y, mo, d := now.Date()
	from, to := time.Date(y, mo, d-1, 0, 0, 0, 0, time.Local), now
	var err error
	if fromArg != "" {
		if from, err = parseDay(fromArg); err != nil {
			return assistant.ToolResult{}, err
		}
	}
	if toArg != "" {
		if to, err = parseDay(toArg); err != nil {
			return assistant.ToolResult{}, err
		}
	}
	list, err := s.Kanban.History(k.loc, from.UnixMilli(), to.UnixMilli())
	if err != nil {
		return assistant.ToolResult{}, err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Tickets that moved from %s to %s (closed ones first):", from.Format("2006-01-02 15:04"), to.Format("2006-01-02 15:04"))
	if len(list) == 0 {
		b.WriteString("\n(none)")
	}
	for _, t := range list {
		b.WriteString("\n- " + ticketLine(t.Summary))
		for _, e := range t.Events {
			key, p := kb.EventKey(e.Text)
			text := key
			for k, v := range p {
				val := fmt.Sprint(v)
				if name, ok := kb.StatusNames[val]; ok && (k == "from" || k == "to") {
					val = name
				}
				text = strings.ReplaceAll(text, "{"+k+"}", val)
			}
			fmt.Fprintf(&b, "\n  %s %s (%s)", time.UnixMilli(e.Created).In(time.Local).Format("01-02 15:04"), text, e.Author)
		}
	}
	return assistant.OK(b.String(), assistant.Tn(len(list), "{n} ticket", "{n} tickets", nil)), nil
}
