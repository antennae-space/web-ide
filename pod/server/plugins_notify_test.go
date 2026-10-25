package server

import (
	"encoding/json"
	"strings"
	"testing"

	"antennae.space/ide/pod/sshx"
)

// notify of a backend (#156): its grant, a kind of the devices, an English title.
func TestPluginNotify(t *testing.T) {
	s, ts := newServer(t)
	a, _ := dial(t, ts, s.Token)
	id := a.call("projects.create", map[string]any{"type": "local", "path": t.TempDir()})["result"].(map[string]any)["id"].(string)
	rt, _ := s.openRuntime(id, sshx.Creds{})
	for _, c := range []struct {
		grants []string
		args   string
		want   string
	}{
		{nil, `{"kind":"feedback","texts":{"en":{"title":"t"}}}`, "notify is not granted"},
		{[]string{"notify"}, `{"kind":"spam","texts":{"en":{"title":"t"}}}`, "unknown kind"},
		{[]string{"notify"}, `{"kind":"feedback","texts":{"fr":{"title":"t"}}}`, "English title"},
		{[]string{"notify"}, `{"kind":"feedback","query":"%zz","texts":{"en":{"title":"t"}}}`, "invalid"},
		{[]string{"notify"}, `{"kind":"feedback","query":"?ticket=3","texts":{"en":{"title":"t"}}}`, ""},
	} {
		_, err := s.pluginNotify(rt, ext("alpha", c.grants...), json.RawMessage(c.args))
		if (c.want == "") != (err == nil) || (err != nil && !strings.Contains(err.Error(), c.want)) {
			t.Fatalf("%s: %v, want %q", c.args, err, c.want)
		}
	}
}
