package assistant

// The lines of a consolidation (#235, docs/design/consolidation.md) that the assistant (role
// consolidation) and the MCP (prompt consolidate) both give: the session reads the sources of
// its ticket and moves their durable lessons into the instructions of the project, one commit
// per lesson. {{id}} is the ticket.
const (
	ConsolidationRead   = `Read your ticket with kanban_get: its Sources are the tickets to read. For each source, read kanban_get, its conversations with kanban_conversation (tools: true; the errors and the corrections of the user are there), and the diff of its branch when the branch still exists. Then read the instructions you may change: AGENTS.md (at the root and in the folders), the README.md of the areas, the skills of the project (.claude/skills, .agents/skills), GLOSSARY.md, docs/design/.`
	ConsolidationKeep   = `Keep a lesson only when all of these are true: it will matter again, to another ticket (a detail of one change is not a lesson); the code, the git history and the docs do not say it already (a lesson that belongs in the code, as a comment or a test, goes in your note, not in the instructions); it is a fact or a rule, not a story of what happened; it holds no secret, no address of a private machine, no personal data.`
	ConsolidationWhere  = `Put each lesson in one place: a rule for every AI on the whole project in the root AGENTS.md; a rule for one folder in the AGENTS.md of that folder, else in its README.md (Pitfalls); how an area works (a map, an invariant, a pitfall) in the README.md of the area; a procedure of several steps that comes back in a skill of the project; a word, or a word whose meaning changed, in GLOSSARY.md; a design decision in its page of docs/design/. Write in the style of the file you change: short, no restatement of what it already says.`
	ConsolidationCommit = `Commit each lesson alone on the ticket branch: "#{{id}} Consolidation: <the lesson in a few words> (#a, #b)", the sources it comes from in parentheses. Change no code.`
	ConsolidationNote   = `Add one note with kanban_add_note: the lessons you did not keep and why, in a few lines.`
	ConsolidationEnd    = `Then move the ticket to "To test" with kanban_move (status to_test) and a test_summary (` + TestSummaryStyle + `): one step per commit, with its target file and its sources. With no lesson to keep, make no commit, and say so in the test_summary: the user abandons the ticket.`
)
