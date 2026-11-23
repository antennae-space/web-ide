package services

import (
	"context"
	"fmt"
	"maps"
	"net"
	"net/http"
	"sync"
	"time"
)

const (
	healthChecking    = "checking"
	healthReady       = "ready"
	healthUnreachable = "unreachable"
)

type serviceHealth struct {
	port   int
	status string
}

// healthOf reads the last check of this service and port. Call with the manager locked.
func (m *Manager) healthOf(s Service) string {
	if !s.Enabled {
		return ""
	}
	if checked := m.health[s.ID]; checked.port == s.Port {
		return checked.status
	}
	return healthChecking
}

// monitorHealth checks the HTTP listeners of the enabled services. It runs on their pod,
// so a home page does not open a tunnel to check a service on another pod.
func (m *Manager) monitorHealth(ctx context.Context) {
	transport := &http.Transport{
		DialContext:       (&net.Dialer{}).DialContext,
		DisableKeepAlives: true,
	}
	client := &http.Client{
		Transport:     transport,
		Timeout:       time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		m.checkHealth(ctx, client)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (m *Manager) checkHealth(ctx context.Context, client *http.Client) {
	m.mu.Lock()
	services := make([]Service, 0, len(m.list))
	for _, s := range m.list {
		if s.Enabled {
			services = append(services, s)
		}
	}
	m.mu.Unlock()

	results := make([]string, len(services))
	var work sync.WaitGroup
	workers := min(4, len(services))
	for worker := range workers {
		work.Go(func() {
			for i := worker; i < len(services) && ctx.Err() == nil; i += workers {
				results[i] = checkListener(ctx, client, services[i].Port)
			}
		})
	}
	work.Wait()
	if ctx.Err() != nil {
		return
	}

	m.mu.Lock()
	next := make(map[string]serviceHealth, len(services))
	for i, service := range services {
		if s, ok := m.find(service.ID); ok && s.Enabled && s.Port == service.Port {
			next[service.ID] = serviceHealth{port: service.Port, status: results[i]}
		}
	}
	changed := !maps.Equal(m.health, next)
	m.health = next
	m.mu.Unlock()
	if changed {
		m.changed()
	}
}

// Any HTTP response confirms the listener is present, even when its root does not handle HEAD.
func checkListener(ctx context.Context, client *http.Client, port int) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, fmt.Sprintf("http://127.0.0.1:%d/", port), nil)
	if err != nil {
		return healthUnreachable
	}
	resp, err := client.Do(req)
	if err != nil {
		return healthUnreachable
	}
	resp.Body.Close()
	return healthReady
}
