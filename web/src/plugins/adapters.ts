// The core's adapters of capabilities an external plugin may provide (#155, #158): what the
// core and the built-ins call, made from the calls and the values of the plugin's background
// frame (services.ts). The Kanban external gives `tickets` so: its tickets and their labels as
// values, the rest as calls.
import type { TicketBlocker, TicketsService, TicketSummary } from './capabilities'
import { registerAdapter } from './services'

type Labels = { status?: Record<string, string>; role?: Record<string, string>; blocker?: Record<string, string> }

registerAdapter('tickets', (svc): TicketsService => {
  const list = () => (svc.value('tickets') as TicketSummary[] | undefined) ?? []
  const labels = () => (svc.value('labels') as Labels | undefined) ?? {}
  const call = <T,>(method: string, ...args: unknown[]) => svc.call(method, args) as Promise<T>
  return {
    tickets: list,
    // The board is loaded by the plugin's background frame itself.
    ensure: () => {},
    summary: (id) => list().find((x) => x.id === id),
    get: (id) => call('get', id),
    open: (id) => void call('open', id),
    openBoard: () => void call('openBoard'),
    openMilestone: (id) => void call('openMilestone', id),
    openObjective: (id) => void call('openObjective', id),
    startChat: (tk, role) => call('startChat', tk.id, role),
    startWork: (tk, role, adoptedBy) => call('startWork', tk.id, role, adoptedBy),
    blockerText: (b: TicketBlocker) => `#${b.id}: ${labels().blocker?.[b.kind] ?? b.kind}`,
    statusLabel: (s) => labels().status?.[s] ?? s,
    roleLabel: (r) => labels().role?.[r] ?? r,
    worktreeProject: (id) => call('worktreeProject', id),
  }
})
