// Threads & Variables: on the left the thread picker above the frames of the paused thread (the
// library frames dimmed and folded), on the right the variables of the selected frame by scope,
// a tree whose children are asked when a row opens.
import { For, Show } from 'solid-js'
import { api, Icon, t } from './plugin'
import { isLibrary, loadVars, selectFrame, selectThread, setDebug, toggleRow, viewOf, type Frame, type Session, type Variable } from './state'

export function ThreadsAndVariables(props: { session: Session }) {
  const v = () => viewOf(props.session.id)
  const paused = () => props.session.state === 'stopped'
  return (
    <div class="dbg-split">
      <div class="dbg-frames" data-testid="debug-frames">
        <Show when={paused()} fallback={<div class="dbg-muted pad">{props.session.state === 'starting' ? t('Starting…') : t('The program is running.')}</div>}>
          <Show when={(v()?.threads.length ?? 0) > 1}>
            <select class="dbg-threads" data-testid="debug-threads" value={v()?.thread ?? ''} onChange={(e) => void selectThread(props.session.id, Number(e.currentTarget.value))}>
              <For each={v()?.threads}>{(th) => <option value={th.id}>{th.name}</option>}</For>
            </select>
          </Show>
          <Frames session={props.session} />
        </Show>
      </div>
      <div class="dbg-vars" data-testid="debug-variables">
        <Show when={paused()}>
          <For each={v()?.scopes}>
            {(sc) => (
              <VarRow session={props.session.id} depth={0} path={sc.name} name={sc.name} reference={sc.variablesReference} scope />
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}

function Frames(props: { session: Session }) {
  const v = () => viewOf(props.session.id)
  const libs = () => (v()?.frames ?? []).filter(isLibrary).length
  const shown = () => (v()?.libraries ? v()!.frames : (v()?.frames ?? []).filter((f, i) => i === 0 || !isLibrary(f)))
  const open = (f: Frame) => {
    void selectFrame(props.session.id, f.id)
    if (f.source?.path && f.line) void api.openFile({ path: f.source.path, line: f.line - 1 })
  }
  return (
    <div class="dbg-frame-list" role="list">
      <For each={shown()}>
        {(f) => (
          <div
            class="dbg-frame"
            role="listitem"
            data-testid="debug-frame"
            classList={{ active: v()?.frame === f.id, library: isLibrary(f) }}
            title={f.source?.path ?? ''}
            onClick={() => open(f)}
          >
            <span class="dbg-frame-name">{f.name}</span>
            <span class="dbg-frame-place">
              {f.source?.name ?? api.project.basename(f.source?.path ?? '')}:{f.line}
            </span>
          </div>
        )}
      </For>
      <Show when={libs()}>
        <button class="dbg-libs" data-testid="debug-libraries" onClick={() => setDebug('views', props.session.id, 'libraries', !v()?.libraries)}>
          {v()?.libraries ? t('Hide library frames') : t('{n} library frames', { n: libs() })}
        </button>
      </Show>
    </div>
  )
}

/** The family of a value: its icon in the tree. */
function kindOf(x: { type?: string; variablesReference: number; presentationHint?: Variable['presentationHint'] }) {
  const k = x.presentationHint?.kind
  if (k === 'method' || k === 'class' || k === 'interface') return k
  if (x.type && /^(\[\]|\[\d+\]|map\[|array|list)/i.test(x.type)) return 'array'
  return x.variablesReference > 0 ? 'object' : 'primitive'
}

function VarRow(props: { session: string; depth: number; path: string; name: string; reference: number; value?: string; type?: string; hint?: Variable['presentationHint']; scope?: boolean }) {
  const v = () => viewOf(props.session)
  const open = () => !!v()?.open[props.path]
  const children = () => v()?.vars[props.reference]
  const toggle = () => props.reference > 0 && toggleRow(props.session, props.path, props.reference)
  const menu = (e: MouseEvent) => {
    if (props.scope) return
    api.ui.contextMenu(e, [
      { label: t('Copy value'), action: () => void api.ui.copyText(props.value ?? '') },
      { label: t('Copy name'), action: () => void api.ui.copyText(props.name) },
    ])
  }
  return (
    <>
      <div
        class="dbg-var"
        classList={{ scope: !!props.scope, [`hint-${props.hint?.visibility ?? ''}`]: !!props.hint?.visibility }}
        style={{ 'padding-left': `${6 + props.depth * 14}px` }}
        data-testid="debug-var"
        data-name={props.name}
        onClick={toggle}
        onContextMenu={menu}
      >
        <span class="dbg-twisty">{props.reference > 0 ? <Icon name={open() ? 'down' : 'chevron'} size={11} /> : null}</span>
        <Show when={!props.scope} fallback={<span class="dbg-scope-name">{props.name}</span>}>
          <span class={`dbg-kind dbg-kind-${kindOf({ type: props.type, variablesReference: props.reference, presentationHint: props.hint })}`} />
          <span class="dbg-var-name">{props.name}</span>
          <span class="dbg-eq"> = </span>
          <Show when={props.type}>
            <span class="dbg-var-type">{`{${props.type}} `}</span>
          </Show>
          <span class="dbg-var-value" title={props.value}>
            {props.value}
          </span>
        </Show>
      </div>
      <Show when={open()}>
        <Show when={children()} fallback={<LoadRow session={props.session} depth={props.depth + 1} reference={props.reference} />}>
          <For each={children()}>
            {(c) => (
              <VarRow session={props.session} depth={props.depth + 1} path={`${props.path}/${c.name}`} name={c.name} reference={c.variablesReference} value={c.value} type={c.type} hint={c.presentationHint} />
            )}
          </For>
        </Show>
      </Show>
    </>
  )
}

/** A row waiting for the children of an opened one. */
function LoadRow(props: { session: string; depth: number; reference: number }) {
  void loadVars(props.session, props.reference)
  return (
    <div class="dbg-var dbg-muted" style={{ 'padding-left': `${6 + props.depth * 14}px` }}>
      {t('Loading…')}
    </div>
  )
}

