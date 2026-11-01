// The daily quota in the bars of the Assistant (TopBar.tsx) and of the Agents tool
// (agents/StatusBar.tsx): what is left of today's share of the Claude subscription and of its
// 5-hour window (pod: internal/quota), else of the daily budget of the plugin's settings.
// One quota for every bar of the window, asked again every 2 minutes and when a turn ends.
import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js'
import { fmtCost } from '../agents/stats'
import { Icon, onPod, request, settingValues, t } from '../plugin'

interface Window {
  utilization: number
  resetsAt: number
}

export interface Quota {
  source: 'oauth' | 'budget'
  /** Rest of today's share, percent (negative: ahead of the pace); when the next one starts. */
  day: number
  dayEnd: number
  fiveHour?: Window
  week?: Window
  opus?: Window
  budget?: number
  spent?: number
}

const [quota, setQuota] = createSignal<Quota | null>(null)
let users = 0
let timer: number | undefined
let off: (() => void) | undefined

const budget = () => Number(settingValues().daily_budget) || 0
const midnight = () => new Date().setHours(0, 0, 0, 0)

async function load() {
  const q = await request<Quota | null>('llm.quota', { budget: budget(), since: midnight() }).catch(() => null)
  setQuota(q?.source ? q : null)
}

const pct = (n: number) => new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(n / 100)
const level = (n: number) => (n < 0 ? 'q-over' : n < 20 ? 'q-low' : '')
const at = (ms: number) => {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}

function tip(q: Quota) {
  const lines = [t("Today's share left: {pct}, next share {at}", { pct: pct(q.day), at: at(q.dayEnd) })]
  const win = (label: string, w?: Window) => w && lines.push(t('{window}: {pct} used, reset {at}', { window: label, pct: pct(w.utilization), at: at(w.resetsAt) }))
  win(t('5 hours'), q.fiveHour)
  win(t('Week'), q.week)
  win('Opus', q.opus)
  if (q.source === 'budget') lines.push(t('Budget: {spent} of {budget} spent today (API prices)', { spent: fmtCost(q.spent ?? 0), budget: fmtCost(q.budget ?? 0) }))
  else lines.push(t('Claude subscription of Claude Code'))
  return lines.join('\n')
}

/** The quota of the day and of the 5 hours; hidden without a source. Narrow: the day only. */
export function QuotaPart(props: { narrow?: () => boolean }) {
  onMount(() => {
    if (users++ > 0) return
    void load()
    timer = window.setInterval(() => void load(), 120_000)
    off = onPod('llm.quota', () => void load())
  })
  onCleanup(() => {
    if (--users > 0) return
    clearInterval(timer)
    off?.()
  })
  createEffect(on(budget, () => void load(), { defer: true }))
  const five = () => (quota()?.fiveHour ? 100 - quota()!.fiveHour!.utilization : undefined)
  return (
    <Show when={quota()}>
      {(q) => (
        <span class="ai-bar-item ai-quota" data-testid="ai-quota" title={tip(q())}>
          <Icon name="chart" size={13} />
          <span class={`mono ${level(q().day)}`} data-testid="ai-quota-day">
            {props.narrow?.() ? pct(q().day) : t('Day {pct}', { pct: pct(q().day) })}
          </span>
          <Show when={five() !== undefined && !props.narrow?.()}>
            <span class={`mono ${level(five()!)}`} data-testid="ai-quota-5h">
              · {t('5 h {pct}', { pct: pct(five()!) })}
            </span>
          </Show>
        </span>
      )}
    </Show>
  )
}
