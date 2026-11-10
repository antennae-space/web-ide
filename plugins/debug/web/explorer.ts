// The root Debug sessions of the Explorer (docs/design/explorer.md): every debug session of the
// worktrees attached to the window, whatever the one shown; its state at the right of the row, an
// ended one dimmed. A double click shows it in the Debug tool, its menu stops or restarts it.
import { createEffect, createRoot, on } from 'solid-js'
import type { ExplorerNode, ExplorerRoot } from '@ide/types'
import { api, errorToast, relOf, t } from './plugin'
import { act, debug, forgetSessionsOf, known, refreshSessions, setDebug, setSessionsOf, stateLabel, trackSession, type Known, type Session } from './state'

/** The sessions of one worktree, read from its own pod. */
async function listSessions(pid: string) {
  const list = await api.rpcIn<Session[]>(pid, 'sessions').catch(() => [] as Session[])
  setSessionsOf(pid, list)
}

/** Lists the sessions of the attached worktrees but the one shown (that one comes with its own list). */
export async function refreshForeignSessions() {
  const current = api.project.current()
  for (const pid of api.project.attached()) if (pid !== current) await listSessions(pid)
}

/** Follows the worktrees attached to the window: their sessions come and go with them. */
export function watchForeignSessions() {
  createRoot(() =>
    createEffect(
      on(
        () => api.project.attached(),
        (ids, prev) => {
          if (!prev) return
          for (const pid of ids) if (!prev.includes(pid)) void listSessions(pid)
          for (const pid of prev) if (!ids.includes(pid)) forgetSessionsOf(pid)
        },
      ),
    ),
  )
}

/** Shows a session in the Debug tool (the Explorer switched the worktree first when the user agreed). */
async function showSession(k: Known) {
  if (!debug.sessions.some((x) => x.id === k.session.id)) await refreshSessions()
  if (debug.sessions.some((x) => x.id === k.session.id)) setDebug('selected', k.session.id)
  api.showTool('debug')
}

/** Stop or Restart in the menu of a node: the shown worktree goes through the tool's own action. */
async function runSession(k: Known, method: 'stop' | 'restart') {
  if (k.project === api.project.current()) {
    setDebug('selected', k.session.id)
    await act(method)
    return
  }
  try {
    const r = await api.rpcIn<Session | null>(k.project, method, { session: k.session.id, thread: k.session.thread ?? 0 })
    if (method === 'stop') trackSession(k.project, { ...k.session, state: 'ended' })
    else if (r) trackSession(k.project, r)
  } catch (e) {
    errorToast(e)
  }
}

/** Where a paused program is, else what it runs. */
const titleOf = (s: Session) => (s.file ? `${relOf(s.file) ?? s.file}${s.line ? ':' + s.line : ''}` : `${s.type} · ${s.request}`)

function nodeOf(k: Known): ExplorerNode {
  const s = k.session
  // An ended session has no tab to show nor action to run: the row only tells that it ran.
  const ended = s.state === 'ended'
  return {
    id: s.id,
    label: s.name,
    icon: 'bug',
    title: titleOf(s),
    project: k.project,
    dimmed: ended,
    badge: ended || s.state === 'running' ? undefined : stateLabel(s),
    open: ended ? undefined : () => void showSession(k),
    menu: ended ? undefined : () => [{ label: t('Stop'), action: () => void runSession(k, 'stop') }, { label: t('Restart'), action: () => void runSession(k, 'restart') }],
  }
}

export const debugSessionsRoot: ExplorerRoot = {
  id: 'debug',
  label: () => t('Debug sessions'),
  icon: 'bug',
  order: 50,
  // The sessions of the worktree shown first (the oldest first), then those of the other ones.
  nodes: () => {
    const current = api.project.current()
    const attached = new Set(api.project.attached())
    return known()
      .filter((k) => attached.has(k.project))
      .slice()
      .sort((a, b) => Number(b.project === current) - Number(a.project === current))
      .map(nodeOf)
  },
}
