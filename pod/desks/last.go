package desks

// The desk last used of each project, on any device: the home page opens it (a phone lands
// where the PC was). Kept in desks/_last.json, a map project → desk.
const lastName = "desks/_last.json"

// SetLast records n as the desk last used of a project.
func (s *Store) SetLast(id string, n int) {
	s.lastMu.Lock()
	defer s.lastMu.Unlock()
	s.loadLast()
	if s.last[id] == n {
		return
	}
	s.last[id] = n
	_ = s.st.WriteJSON(lastName, s.last)
}

// Lasts is the desk last used of each project that has one.
func (s *Store) Lasts() map[string]int {
	s.lastMu.Lock()
	defer s.lastMu.Unlock()
	s.loadLast()
	out := make(map[string]int, len(s.last))
	for id, n := range s.last {
		out[id] = n
	}
	return out
}

// loadLast reads the file once (under lastMu).
func (s *Store) loadLast() {
	if s.last != nil {
		return
	}
	s.last = map[string]int{}
	_ = s.st.ReadJSON(lastName, &s.last)
}
