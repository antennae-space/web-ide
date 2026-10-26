package server

import (
	"encoding/json"
	"log"
	"os"
	"path"
	"path/filepath"
	"strings"

	"antennae.space/ide/pod/runtime"
	"antennae.space/ide/pod/store"
)

// The data of the built-in Database explorer, moved to its external plugin (#144): the pod
// knows both places, the plugin only its own (its data folder, its vault).
//
//   - the remembered secrets: the keys <project>/<connection> of secrets.json become
//     plugin:database/<project>/<connection> (the plugin's vault), their JSON as a string;
//   - the SQL history: sql-history/ of the pod goes to the plugin's data folder;
//   - the connections: .ide/connections.json of a main project goes to the plugin's data folder,
//     when its backend first starts on the project (the file of an SSH project is on its host).

const migrationsFile = "migrations.json"

// migrateDatabase moves the secrets and the SQL history once.
func (s *Server) migrateDatabase() {
	done := map[string]bool{}
	if err := s.Store.ReadJSON(migrationsFile, &done); err != nil && !store.IsNotExist(err) {
		log.Printf("migrations: %v", err)
		return
	}
	if done["database"] {
		return
	}
	vaultMu.Lock()
	all := map[string]json.RawMessage{}
	err := s.Store.ReadJSON("secrets.json", &all)
	if err == nil || store.IsNotExist(err) {
		for k, v := range all {
			// A secret of a connection: an object under <project>/<connection>.
			if strings.HasPrefix(k, "plugin:") || !strings.Contains(k, "/") || len(v) == 0 || v[0] != '{' {
				continue
			}
			s2, _ := json.Marshal(string(v))
			all["plugin:database/"+k] = s2
			delete(all, k)
		}
		err = s.Store.WriteJSON("secrets.json", all)
	}
	vaultMu.Unlock()
	if err != nil {
		log.Printf("migrations: database secrets: %v", err)
		return
	}
	from, to := s.Store.Path("sql-history"), s.Store.Path("plugin-data", "database", "sql-history")
	if entries, err := os.ReadDir(from); err == nil {
		if err := os.MkdirAll(to, 0o700); err == nil {
			for _, e := range entries {
				_ = os.Rename(filepath.Join(from, e.Name()), filepath.Join(to, e.Name()))
			}
			_ = os.Remove(from)
		}
	}
	done["database"] = true
	if err := s.Store.WriteJSON(migrationsFile, done); err != nil {
		log.Printf("migrations: %v", err)
	}
}

// migrateConnections moves the connections of the main project of rt to the plugin's data
// folder, unless it has them already; .ide/connections.json is left in place.
func (s *Server) migrateConnections(rt *runtime.Runtime) {
	dst := s.Store.Path("plugin-data", "database", "connections", mainID(rt)+".json")
	if _, err := os.Stat(dst); err == nil {
		return
	}
	data, err := rt.FS.Read(path.Join(rt.IdeDir, "connections.json"))
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		log.Printf("migrations: %v", err)
		return
	}
	if err := os.WriteFile(dst, data, 0o600); err != nil {
		log.Printf("migrations: %v", err)
	}
}

// migrateKanban moves the bases of the kanbans of the projects over SSH (kanban/<project>.db of
// the pod, with their WAL files) to the data folder of the external Kanban (#158), once; the
// base of a project of this machine stays in its .ide.
func (s *Server) migrateKanban() {
	done := map[string]bool{}
	if err := s.Store.ReadJSON(migrationsFile, &done); err != nil && !store.IsNotExist(err) {
		log.Printf("migrations: %v", err)
		return
	}
	if done["kanban"] {
		return
	}
	from, to := s.Store.Path("kanban"), s.Store.Path("plugin-data", "kanban", "kanban")
	if entries, err := os.ReadDir(from); err == nil && len(entries) > 0 {
		if err := os.MkdirAll(to, 0o700); err != nil {
			log.Printf("migrations: kanban: %v", err)
			return
		}
		for _, e := range entries {
			if err := os.Rename(filepath.Join(from, e.Name()), filepath.Join(to, e.Name())); err != nil {
				log.Printf("migrations: kanban: %v", err)
				return
			}
		}
		_ = os.Remove(from)
	}
	done["kanban"] = true
	if err := s.Store.WriteJSON(migrationsFile, done); err != nil {
		log.Printf("migrations: %v", err)
	}
}
