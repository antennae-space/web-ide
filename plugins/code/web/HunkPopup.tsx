// The popup of a change marker: the hunk of the line, before and after, with the changed words
// highlighted, and its actions (revert, copy, full diff). FileEditor opens it when a gutter
// marker is clicked and feeds it the hunks it computed.
import { For, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { WordSpan } from '@ide/api'
import { t } from './plugin'

/** One line of a side of the popup: its number, what it is, its word spans. */
export interface HunkLine {
  no: number
  kind: 'ctx' | 'add' | 'del' | 'mod'
  spans: WordSpan[]
}

/** Everything the popup shows, computed by FileEditor from the hunk. */
export interface HunkView {
  /** First and last line of the hunk in the current text (0-based). */
  from: number
  to: number
  added: number
  removed: number
  /** Position of the hunk among the changes of the file (0-based). */
  index: number
  total: number
  /** What the *before* side shows. */
  side: 'head' | 'base'
  /** Two references are available: HEAD and the last saved content. */
  canSwitch: boolean
  before: HunkLine[]
  after: HunkLine[]
  hiddenBefore: number
  hiddenAfter: number
  /** The hunk is longer than the popup: the full diff is offered. */
  truncated: boolean
}

export function HunkPopup(props: {
  view: () => HunkView
  pos: () => { left: number; top: number }
  onClose: () => void
  onRevert: () => void
  onCopy: () => void
  onFullDiff: () => void
  onSide: (side: 'head' | 'base') => void
}) {
  const v = () => props.view()
  const p = () => props.pos()
  return (
    <Portal>
      <div
        class="hunk-popup"
        data-testid="hunk-popup"
        role="dialog"
        aria-label={t('Changes of the line')}
        style={{ left: `${p().left}px`, top: `${p().top}px` }}
        onMouseDown={(e) => e.preventDefault()}
      >
        <div class="hunk-head">
          <Show when={v().from === v().to} fallback={<span class="hunk-title">{t('Lines {from}-{to}', { from: v().from + 1, to: v().to + 1 })}</span>}>
            <span class="hunk-title">{t('Line {n}', { n: v().from + 1 })}</span>
          </Show>
          <span class="hunk-stats">
            <b class="add">+{v().added}</b> <b class="del">−{v().removed}</b>
          </span>
          <Show when={v().canSwitch}>
            <div class="hunk-sides" role="group">
              <button class="btn small" classList={{ on: v().side === 'head' }} onClick={() => props.onSide('head')}>
                {t('HEAD')}
              </button>
              <button class="btn small" classList={{ on: v().side === 'base' }} onClick={() => props.onSide('base')}>
                {t('Saved')}
              </button>
            </div>
          </Show>
          <span class="hunk-index">
            {v().index + 1}/{v().total}
          </span>
          <button class="icon-btn hunk-close" title={t('Close')} onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div class="hunk-body">
          <Side lines={v().before} hidden={v().hiddenBefore} head={v().side === 'head' ? t('HEAD') : t('Saved')} />
          <Side lines={v().after} hidden={v().hiddenAfter} head={t('Current')} />
        </div>
        <div class="hunk-actions">
          <button class="btn small" onClick={props.onRevert}>
            {t('Revert the hunk')}
          </button>
          <button class="btn small" onClick={props.onCopy}>
            {t('Copy the old text')}
          </button>
          <Show when={v().truncated}>
            <button class="btn small" onClick={props.onFullDiff}>
              {t('Open the full diff')}
            </button>
          </Show>
        </div>
      </div>
    </Portal>
  )
}

function Side(props: { lines: HunkLine[]; hidden: number; head: string }) {
  return (
    <div class="hunk-col">
      <div class="hunk-col-head">{props.head}</div>
      <Show when={props.hidden > 0}>
        <div class="hunk-hidden">… {t('{n} lines hidden', { n: props.hidden })}</div>
      </Show>
      <Show when={props.lines.length} fallback={<div class="hunk-hidden">{t('Nothing here')}</div>}>
        <For each={props.lines}>
          {(l) => (
            <div class="hunk-line" classList={{ ctx: l.kind === 'ctx', add: l.kind === 'add', del: l.kind === 'del', mod: l.kind === 'mod' }}>
              <span class="hunk-no">{l.no}</span>
              <span class="hunk-text">
                <Show when={l.spans.length} fallback=" ">
                  <For each={l.spans}>
                    {(s) => <span classList={{ 'hunk-word': s.changed }}>{s.text}</span>}
                  </For>
                </Show>
              </span>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}
