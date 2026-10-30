package debug

import (
	"encoding/json"
	"os"
	"path"
	"sort"
	"sync"

	"antennae.space/ide/pod/runtime"
)

// The breakpoints of a worktree (#188): `.ide/breakpoints.json` under its own root (its lines
// are its branch's), by file path relative to the worktree. A line, optionally with a condition,
// a hit count, a log message (a logpoint), and enabled or not.

// Breakpoint is one line where the program stops (or logs).
type Breakpoint struct {
	Line         int    `json:"line"`
	Condition    string `json:"condition,omitempty"`
	HitCondition string `json:"hitCondition,omitempty"`
	LogMessage   string `json:"logMessage,omitempty"`
	Enabled      bool   `json:"enabled"`
}

// Breakpoints are the files of one worktree and their breakpoints.
type Breakpoints struct {
	Files map[string][]Breakpoint `json:"files"`
}

// breakpointStore reads and keeps .ide/breakpoints.json of a worktree.
type breakpointStore struct {
	rt     *runtime.Runtime
	mu     sync.Mutex
	data   Breakpoints
	loaded bool
}

func newBreakpoints(rt *runtime.Runtime) *breakpointStore {
	return &breakpointStore{rt: rt, data: Breakpoints{Files: map[string][]Breakpoint{}}}
}

// path of the file of a worktree.
func (s *breakpointStore) file() string { return path.Join(s.rt.Root, ".ide", "breakpoints.json") }

// load reads the file once (a broken file is an empty one).
func (s *breakpointStore) load() Breakpoints {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loaded {
		return s.data
	}
	s.loaded = true
	data, err := s.rt.FS.Read(s.file())
	if err != nil {
		return s.data
	}
	var f Breakpoints
	if json.Unmarshal(data, &f) != nil || f.Files == nil {
		return s.data
	}
	s.data = f
	return s.data
}

// all are the breakpoints by file, the lines in order.
func (s *breakpointStore) all() map[string][]Breakpoint {
	s.load()
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string][]Breakpoint{}
	for f, list := range s.data.Files {
		l := make([]Breakpoint, len(list))
		copy(l, list)
		sort.Slice(l, func(i, j int) bool { return l[i].Line < l[j].Line })
		out[f] = l
	}
	return out
}

// set replaces the breakpoints of one file (an empty list takes the file out) and saves them.
func (s *breakpointStore) set(file string, list []Breakpoint) ([]Breakpoint, error) {
	s.load()
	s.mu.Lock()
	sort.Slice(list, func(i, j int) bool { return list[i].Line < list[j].Line })
	if len(list) == 0 {
		delete(s.data.Files, file)
	} else {
		s.data.Files[file] = list
	}
	data, err := json.MarshalIndent(s.data, "", "  ")
	s.mu.Unlock()
	if err != nil {
		return list, err
	}
	if err := s.rt.FS.Mkdir(path.Join(s.rt.Root, ".ide")); err != nil && !os.IsExist(err) {
		return list, err
	}
	if err := s.rt.FS.Write(s.file(), append(data, '\n')); err != nil {
		return list, err
	}
	return list, nil
}
