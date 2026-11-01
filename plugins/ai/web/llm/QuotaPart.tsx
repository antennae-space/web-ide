// The daily quota in the bars of the Assistant (TopBar.tsx) and of the Agents tool
// (agents/StatusBar.tsx): what is left of today's share of the Claude subscription and of its
// 5-hour window (pod: internal/quota), or of the daily budget of the plugin's settings; each
// bar picks the source that counts for it. A click opens the card of the windows. One read
// for every bar of the window, asked again every 2 minutes and when a turn ends.
import { createEffect, createSignal, on, onCleanup, onMount, Show, type JSX } from 'solid-js'
import { fmtCost } from '../agents/stats'
import { Popover } from './parts'
import { Icon, onPod, request, settingValues, t } from '../plugin'

interface Window {
  utilization: number
  resetsAt: number
}

export interface Quota {
  source: 'oauth' | 'budget'
  /** The subscription (pro, max); when it was read (ms). */
  plan?: string
  at: number
  /** Rest of today's share, percent (negative: ahead of the pace); when the next one starts. */
  day: number
  dayEnd: number
  fiveHour?: Window
  week?: Window
  opus?: Window
  budget?: number
  spent?: number
}

/** The quota of each source, either missing. */
export interface Quotas {
  oauth?: Quota
  budget?: Quota
}

const [quotas, setQuotas] = createSignal<Quotas>({})
let users = 0
let timer: number | undefined
let off: (() => void) | undefined

const budget = () => Number(settingValues().daily_budget) || 0
const midnight = () => new Date().setHours(0, 0, 0, 0)

async function load() {
  setQuotas((await request<Quotas | null>('llm.quota', { budget: budget(), since: midnight() }).catch(() => null)) ?? {})
}

const pct = (n: number) => new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(n / 100)
const level = (n: number) => (n < 0 ? 'q-over' : n < 20 ? 'q-low' : '')
const used = (n: number) => (n >= 100 ? 'q-over' : n >= 80 ? 'q-low' : '')
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
const at = (ms: number) => {
  const d = new Date(ms)
  return d.toDateString() === new Date().toDateString() ? clock(ms) : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${clock(ms)}`
}
/** "in 2 h 40", "in 3 d 4 h", "in 12 min". */
function until(ms: number) {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000))
  if (m < 60) return t('in {n} min', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('in {h} h {m}', { h, m: String(m % 60).padStart(2, '0') })
  return t('in {d} d {h} h', { d: Math.floor(h / 24), h: h % 24 })
}

/** A gauge: its fill (0 to 100) colored by cls, an optional mark (the pace). */
const Gauge = (p: { fill: number; cls: string; mark?: number }) => (
  <div class={`ai-ctx-bar ai-q-bar ${p.cls === 'q-over' ? 'danger' : p.cls === 'q-low' ? 'warn' : ''}`}>
    <span style={{ width: `${Math.max(0, Math.min(100, p.fill))}%` }} />
    <Show when={p.mark !== undefined}>
      <i style={{ left: `calc(${Math.max(0, Math.min(100, p.mark!))}% - 1px)` }} />
    </Show>
  </div>
)

/** A row of the card: a label and its figure, its gauge, a line of details. */
const Row = (p: { label: string; figure: string; cls: string; testid: string; note: JSX.Element; mark?: number; fill: number }) => (
  <div class="ai-q-row" data-testid={p.testid}>
    <div class="ai-q-head">
      <span>{p.label}</span>
      <strong class={p.cls}>{p.figure}</strong>
    </div>
    <Gauge fill={p.fill} cls={p.cls} mark={p.mark} />
    <div class="muted small">{p.note}</div>
  </div>
)

/** A window of the subscription: its use, its reset; the week also its pace. */
function WindowRow(p: { label: string; w: Window; testid: string; span?: number }) {
  // The pace: the share of the window gone by, what would be used at an even rate.
  const pace = () => (p.span ? (100 * (Date.now() - (p.w.resetsAt - p.span))) / p.span : undefined)
  const gap = () => (pace() === undefined ? 0 : Math.round(pace()! - p.w.utilization))
  return (
    <Row label={p.label} figure={t('{pct} used', { pct: pct(p.w.utilization) })} cls={used(p.w.utilization)} fill={p.w.utilization} mark={pace()} testid={p.testid}
      note={
        <>
          {t('Reset {in} ({at})', { in: until(p.w.resetsAt), at: at(p.w.resetsAt) })}
          <Show when={pace() !== undefined}>
            <br />
            {gap() >= 0 ? t('Pace {pct}: {n} points under it', { pct: pct(pace()!), n: gap() }) : t('Pace {pct}: {n} points ahead of it', { pct: pct(pace()!), n: -gap() })}
          </Show>
        </>
      }
    />
  )
}

function Card(p: { q: Quota }) {
  const q = () => p.q
  // The popover opens from the part, wherever the bar is: kept inside the window.
  let el!: HTMLDivElement
  onMount(() => {
    const pop = el.parentElement!
    const r = pop.getBoundingClientRect()
    const shift = r.right > innerWidth - 8 ? innerWidth - 8 - r.right : r.left < 8 ? 8 - r.left : 0
    if (shift) pop.style.translate = `${shift}px 0`
  })
  const title = () => (q().source === 'budget' ? t('Daily budget') : q().plan ? t('Claude {plan} subscription', { plan: q().plan!.replace(/^./, (c) => c.toUpperCase()) }) : t('Claude subscription'))
  return (
    <div class="ai-ctx ai-q-card" data-testid="ai-quota-card" ref={el}>
      <div class="ai-q-title">
        <span class="ai-ctx-title">{title()}</span>
        <span class="muted small">{t('Read at {at}', { at: clock(q().at) })}</span>
      </div>
      <Row label={t('Today')} figure={pct(q().day)} cls={level(q().day)} fill={q().day < 0 ? 100 : q().day} testid="ai-quota-today"
        note={
          <>
            {q().source === 'budget'
              ? t('{spent} of {budget} spent since midnight, at API prices', { spent: fmtCost(q().spent ?? 0), budget: fmtCost(q().budget ?? 0) })
              : q().day < 0
                ? t("Today's share is used up: you are ahead of the pace")
                : t("Left of today's share")}
            <br />
            {t('Next share {in} ({at})', { in: until(q().dayEnd), at: at(q().dayEnd) })}
          </>
        }
      />
      <Show when={q().fiveHour}>{(w) => <WindowRow label={t('5 hours')} w={w()} testid="ai-quota-five" />}</Show>
      <Show when={q().week}>{(w) => <WindowRow label={t('Week')} w={w()} span={7 * 86400e3} testid="ai-quota-week" />}</Show>
      <Show when={q().opus}>{(w) => <WindowRow label="Opus" w={w()} span={7 * 86400e3} testid="ai-quota-opus" />}</Show>
      <p class="muted small ai-q-help">
        {q().source === 'budget'
          ? t('The cost of the agents and the assistant since midnight against the daily budget of Settings > Plugins > AI.')
          : t('A day is a seventh of the weekly window: what was not used carries over, going faster eats into the next days.')}
      </p>
    </div>
  )
}

/** The quota of the day and of the 5 hours, of the source pick chooses; hidden without one.
 *  Narrow: the day only. */
export function QuotaPart(props: { pick: (q: Quotas) => Quota | undefined; narrow?: () => boolean }) {
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
  const quota = () => props.pick(quotas())
  const five = () => (quota()?.fiveHour ? 100 - quota()!.fiveHour!.utilization : undefined)
  return (
    <Show when={quota()}>
      {(q) => (
        <Popover
          trigger={(toggle, open) => (
            <button class="ai-bar-item ai-quota" classList={{ on: open }} data-testid="ai-quota" data-source={q().source} onClick={toggle} title={t('Daily quota')}>
              <Icon name="chart" size={13} />
              <span class={`mono ${level(q().day)}`} data-testid="ai-quota-day">
                {props.narrow?.() ? pct(q().day) : t('Day {pct}', { pct: pct(q().day) })}
              </span>
              <Show when={five() !== undefined && !props.narrow?.()}>
                <span class={`mono ${level(five()!)}`} data-testid="ai-quota-5h">
                  · {t('5 h {pct}', { pct: pct(five()!) })}
                </span>
              </Show>
            </button>
          )}
        >
          {() => <Card q={q()} />}
        </Popover>
      )}
    </Show>
  )
}
