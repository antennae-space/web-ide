// Bar of the Assistant, on top of the message box, on every conversation: the time it spent
// generating (with its children), the consoles it started that still run, its parent, its
// children, the daily quota of the account (QuotaPart.tsx), then on the right its ticket and the role of the conversation on it. Each part
// hides when it has nothing, except the time. Narrow: they collapse to an icon and a number.
import { createEffect, Show } from 'solid-js'
import { chat, chatList, config, live, setChat, shells, type ChatInfo } from './state'
import { loadShells, openChat, runStates } from './assistant'
import { agentLabels, agentStatus } from './SubAgents'
import { clock } from './Stats'
import { fmtCost } from '../agents/stats'
import { showSide } from './board/pages'
import { QuotaPart } from './QuotaPart'
import { capability, contextMenu, errorToast, Icon, pick, request, t } from '../plugin'
import type { TicketRole, TicketsService } from '../plugin'

const open = (id?: string) => id && openChat(id).catch(errorToast)

/** Status of a child that works (not ended). */
const working = (c: ChatInfo): boolean => {
  const status = agentStatus(c.id, c.status)
  return runStates()[c.id] === 'running' || ['running', 'queued', 'waiting_user', 'waiting_parent', 'compacting'].includes(status)
}

/** Ticket linked to the conversation (link it, or link another one), with the Kanban plugin. */
function TicketPart() {
  return <Show when={capability('tickets')}>{(k) => <TicketLink tickets={k()} />}</Show>
}

/** The role of a conversation or a session on a ticket, from the status of the ticket. */
export const roleFor = (status: string): TicketRole => (status === 'new' ? 'briefing' : status === 'todo' ? 'plan' : status === 'to_test' ? 'correction' : 'dev')

/** A ticket in a bar: its number and the dot of its status; a click opens it. */
export function TicketButton(props: { tickets: TicketsService; id: number }) {
  const k = props.tickets
  const tk = () => k.summary(props.id)
  // The status dot needs the ticket: the bar asks for the tickets of the project.
  createEffect(() => k.ensure())
  return (
    <button class="ai-bar-item ai-bar-ticket" data-testid="ai-ticket" onClick={() => k.open(props.id)} title={[tk()?.title, tk() ? k.statusLabel(tk()!.status) : ''].filter(Boolean).join('\n')}>
      <span class="ai-bar-icon">
        <Icon name="kanban" size={13} />
        <Show when={tk()}>{(s) => <span class={`ai-bar-dot st-${s().status}`} />}</Show>
      </span>
      <span class="mono">#{props.id}</span>
    </button>
  )
}

/** A role on a ticket, in a bar. */
export const RoleBadge = (props: { tickets: TicketsService; role: TicketRole }) => (
  <span class={`ai-tk-role r-${props.role}`} data-testid="ai-role">
    {props.tickets.roleLabel(props.role)}
  </span>
)

function TicketLink(props: { tickets: TicketsService }) {
  const k = props.tickets
  const link = async () => {
    k.ensure()
    const id = await pick<number>({
      placeholder: t('Link this conversation to a ticket'),
      items: k
        .tickets()
        .filter((x) => x.status !== 'done' && x.status !== 'abandoned')
        .map((x) => ({ label: `#${x.id} ${x.title}`, detail: k.statusLabel(x.status), value: x.id })),
    })
    const s = id ? k.summary(id) : undefined
    if (!s) return
    const ticket = { id: s.id, role: roleFor(s.status) }
    setChat('ticket', ticket)
    await request('assistant.set', { id: chat.id, ticket }).catch(errorToast)
  }
  return (
    <Show
      when={chat.ticket}
      fallback={
        <Show when={chat.messages.length && !live.busy}>
          <button class="ai-ticket-link" onClick={() => void link()} title={t('The tools that change the ticket become available')}>
            <Icon name="kanban" size={12} /> {t('Link to a ticket…')}
          </button>
        </Show>
      }
    >
      <TicketButton tickets={k} id={chat.ticket!.id} />
    </Show>
  )
}

/** The consoles this conversation started that still run (nothing when none). */
function ShellsPart() {
  const tip = () =>
    shells()
      .map((s) => [s.title || s.id, s.command, s.since ? new Date(s.since).toLocaleTimeString() : ''].filter(Boolean).join(' · '))
      .join('\n')
  return (
    <Show when={shells().length}>
      <span class="ai-bar-item" data-testid="ai-shells" title={tip()}>
        <Icon name="terminal" size={13} />
        <span class="mono">{shells().length}</span>
      </span>
    </Show>
  )
}

/** The parent of a child conversation, and its own status. */
function ParentPart(props: { narrow: () => boolean }) {
  const parent = () => chatList().find((c) => c.id === chat.parent)
  const status = () => agentStatus(chat.id, chat.agent?.status)
  return (
    <div class="ai-bar-item ai-bar-parent" data-testid="ai-parent">
      <button class="link" onClick={() => open(chat.parent)} title={t('Open the parent conversation')}>
        <Icon name="up" size={13} />
        <Show when={!props.narrow()}>
          <span class="ellipsis">{parent()?.title ?? t('the parent conversation')}</span>
        </Show>
      </button>
      <Show when={status()}>
        <span class={`ai-bar-dot agent-${status()}`} title={t(agentLabels[status()] ?? status())} />
      </Show>
    </div>
  )
}

/** The sub-agents of the conversation: working / all, in a menu that opens one. */
function ChildrenPart() {
  const kids = () => {
    const list = chatList().filter((c) => c.parent === chat.id || chat.children?.includes(c.id))
    return [...list].sort((a, b) => (working(b) ? 1 : 0) - (working(a) ? 1 : 0) || b.updated - a.updated)
  }
  const total = () => Math.max(chat.children?.length ?? 0, kids().length)
  const done = () => kids().filter((c) => !working(c)).length
  const show = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    contextMenu(
      new MouseEvent('contextmenu', { clientX: r.left, clientY: r.bottom + 2 }),
      kids().map((c) => ({ label: c.title, hint: t(agentLabels[agentStatus(c.id, c.status)] ?? ''), action: () => open(c.id) })),
    )
  }
  return (
    <Show when={total()}>
      <button class="ai-bar-item" data-testid="ai-children" onClick={show} title={t('{n} sub-agents', { n: total() })}>
        <Icon name="sparkle" size={13} />
        <span class="mono">
          {total() - done()}/{total()}
        </span>
      </button>
    </Show>
  )
}

/** Web content is in the conversation: its sources in a menu that opens them. */
function WebPart() {
  const show = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    contextMenu(
      new MouseEvent('contextmenu', { clientX: r.left, clientY: r.bottom + 2 }),
      (chat.tainted ?? []).map((src) => ({
        label: src,
        action: () => {
          if (/^https?:\/\//.test(src)) window.open(src, '_blank', 'noopener,noreferrer')
        },
      })),
    )
  }
  return (
    <Show when={chat.tainted?.length}>
      <button
        class="ai-bar-item ai-bar-web"
        data-testid="ai-web"
        onClick={show}
        title={t('Web content is in this conversation: its commands, file changes and tools that change something ask you.') + '\n' + (chat.tainted ?? []).join('\n')}
      >
        <span aria-hidden="true">🌐</span>
        <span>{t('web content')}</span>
      </button>
    </Show>
  )
}

/** Role of the conversation on its ticket (nothing when it is not linked). */
function RolePart() {
  return (
    <Show when={chat.ticket && capability('tickets')}>{(k) => <RoleBadge tickets={k()} role={chat.ticket!.role} />}</Show>
  )
}

/** Time spent generating and cost: this conversation and its children; no cost when none (a local model). */
function TimePart() {
  const under = (id: string): ChatInfo[] => {
    const direct = chatList().filter((c) => c.parent === id)
    return direct.flatMap((c) => [c, ...under(c.id)])
  }
  const kids = () => under(chat.id)
  const total = () => (chat.genMs ?? 0) + kids().reduce((a, c) => a + (c.genMs ?? 0), 0)
  const cost = () => (chat.cost ?? 0) + kids().reduce((a, c) => a + (c.cost ?? 0), 0)
  const line = (title: string, ms = 0, c = 0) => `${title}: ${clock(ms)}` + (c ? ` · ${fmtCost(c)}` : '')
  const tip = () => [line(t('This conversation'), chat.genMs, chat.cost), ...kids().map((c) => line(c.title, c.genMs, c.cost))].join('\n')
  return (
    <button class="ai-bar-item ai-bar-time" data-testid="ai-gentime" onClick={() => showSide('stats')} title={tip()}>
      <Icon name="clock" size={13} />
      <span class="mono">{clock(total())}</span>
      <Show when={cost() > 0}>
        <span class="mono" data-testid="ai-cost">
          · {fmtCost(cost())}
        </span>
      </Show>
    </button>
  )
}

/** The conversation runs on a model with a price (a cloud provider): the daily budget concerns
 *  it; the Claude subscription never does (the assistant does not use it). */
const priced = () => (chat.cost ?? 0) > 0 || !!config.servers.find((s) => s.id === (chat.server || config.server))?.hasKey

/** The bar on top of the message box, inside its frame. */
export function TopBar(props: { narrow: () => boolean }) {
  // The shells of a conversation shown: the pod knows which ones still run.
  createEffect(() => {
    if (chat.id) loadShells(chat.id)
  })
  return (
    <div class="ai-topbar" data-testid="ai-topbar" classList={{ narrow: props.narrow() }}>
      <TimePart />
      <ShellsPart />
      <Show when={chat.parent}>
        <ParentPart narrow={props.narrow} />
      </Show>
      <ChildrenPart />
      <WebPart />
      <QuotaPart narrow={props.narrow} pick={(q) => (priced() ? q.budget : undefined)} />
      <span class="grow" />
      <TicketPart />
      <RolePart />
    </div>
  )
}
