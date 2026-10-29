package server

import (
	"os"
	"path/filepath"
	"testing"

	"antennae.space/ide/pod/store"
)

// The bases of the kanbans over SSH move to the external Kanban's data folder once (#158): a
// base written after the move stays where it is.
func TestMigrateKanban(t *testing.T) {
	st, _ := store.Open(t.TempDir())
	s := &Server{Store: st}
	from := st.Path("kanban")
	if err := os.MkdirAll(from, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"remote1.db", "remote1.db-wal"} {
		if err := os.WriteFile(filepath.Join(from, f), []byte(f), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	s.migrateKanban()
	to := st.Path("plugin-data", "kanban", "kanban")
	for _, f := range []string{"remote1.db", "remote1.db-wal"} {
		if data, err := os.ReadFile(filepath.Join(to, f)); err != nil || string(data) != f {
			t.Fatalf("%s in the plugin's data: %q, %v", f, data, err)
		}
	}
	if _, err := os.Stat(from); !os.IsNotExist(err) {
		t.Fatalf("the pod's kanban folder stays: %v", err)
	}

	// Once: a folder made again is not moved.
	if err := os.MkdirAll(from, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(from, "remote2.db"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	s.migrateKanban()
	if _, err := os.Stat(filepath.Join(from, "remote2.db")); err != nil {
		t.Fatalf("moved again: %v", err)
	}
}
