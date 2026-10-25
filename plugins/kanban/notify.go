package kanban

import (
	"net/url"
	"strconv"

	"antennae.space/ide/lib/i18n"

	kb "antennae.space/ide/plugins/kanban/kanban"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/push"
)

// NotifyFeedback sends the push notification of a test feedback the assistant or Claude Code
// added to a ticket.
func (s *K) NotifyFeedback(loc kb.Location, id int64, text string) {
	ticket := ""
	if t, err := s.Kanban.Get(loc, id); err == nil {
		ticket = t.Title
	}
	name, _, _ := s.pod.Project(loc.Project)
	if name == "" {
		name = loc.Project
	}
	n := strconv.FormatInt(id, 10)
	s.pod.Notify(plugins.Note{Kind: push.Feedback, Path: "/project/" + url.PathEscape(loc.Project) + "?ticket=" + n, Tag: "ticket-" + n, Urgency: "normal",
		Text: func(lang string) (string, string) {
			return i18n.T(lang, "Feedback on #%d %s", id, ticket), name + " · " + text
		}})
}
