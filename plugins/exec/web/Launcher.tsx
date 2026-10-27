// Launcher of the Console: an Android-style grid of tiles — a new terminal, the saved commands
// grouped by flag, then Run a command… and Edit commands…. One component, two hosts: the body of
// the empty Console, and the floating panel opened by ▶. It is keyboard-driven: the grid keeps
// one Tab stop, typing filters across the groups, Enter runs the tile focused, Escape leaves an
// opened group or closes the launcher.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { api, Icon, t } from './plugin'
import { adHocCommand, commands, consoleOfCommand, flagIcon, groupByFlag, loadCommands, openApp, runCommand, servesApp, type Command, type Flag } from './commands'
import { newTerminal, runTask } from './consoles'
import { openCommands } from './CommandsModal'

type Tile = { kind: 'new' } | { kind: 'back' } | { kind: 'run' } | { kind: 'edit' } | { kind: 'save'; command: string } | { kind: 'group'; flag: Flag; cmds: Command[] } | { kind: 'command'; cmd: Command }

export function Launcher(props: { float?: boolean; anchor?: HTMLElement | null; onClose?: () => void }) {
  let root!: HTMLDivElement
  const [query, setQuery] = createSignal('')
  const [openFlag, setOpenFlag] = createSignal<Flag | null>(null)
  const [focus, setFocus] = createSignal(0)

  const groups = createMemo(() => groupByFlag())
  const shown = createMemo<Tile[]>(() => {
    const q = query().trim().toLowerCase()
    if (q) return commands().filter((c) => c.name.toLowerCase().includes(q) || c.flag.includes(q) || (c.description ?? '').toLowerCase().includes(q)).map((cmd) => ({ kind: 'command', cmd }) as Tile)
    const flag = openFlag()
    if (flag) {
      const g = groups().find((x) => x.flag === flag)
      return [{ kind: 'back' }, ...(g?.cmds.map((cmd) => ({ kind: 'command', cmd }) as Tile) ?? [])] as Tile[]
    }
    const list: Tile[] = [{ kind: 'new' }]
    for (const g of groups()) list.push(g.cmds.length > 1 ? { kind: 'group', flag: g.flag, cmds: g.cmds } : { kind: 'command', cmd: g.cmds[0] })
    if (commands().length) list.push({ kind: 'run' })
    const adHoc = adHocCommand()
    if (adHoc) list.push({ kind: 'save', command: adHoc })
    list.push({ kind: 'edit' })
    return list
  })

  const tileEls = () => [...root.querySelectorAll<HTMLElement>('.cmd-tile')]
  const focusTile = (i: number) => tileEls()[i]?.focus()
  /** Replaces the tiles shown (a group opened, a filter typed): the keyboard goes to the first one. */
  const showTiles = (fn: () => void) => {
    fn()
    setFocus(0)
    queueMicrotask(() => focusTile(0))
  }

  function move(dir: 'left' | 'right' | 'up' | 'down') {
    const rows: HTMLElement[][] = []
    for (const el of tileEls()) {
      const last = rows[rows.length - 1]
      if (last && Math.abs(last[0].offsetTop - el.offsetTop) < 10) last.push(el)
      else rows.push([el])
    }
    const cur = tileEls()[focus()]
    let r = rows.findIndex((row) => row.includes(cur))
    if (r < 0) return
    let c = rows[r].indexOf(cur)
    if (dir === 'up' || dir === 'down') {
      r = (r + (dir === 'up' ? -1 : 1) + rows.length) % rows.length
      c = Math.min(c, rows[r].length - 1)
    } else c = (c + (dir === 'left' ? -1 : 1) + rows[r].length) % rows[r].length
    const el = rows[r][c]
    setFocus(tileEls().indexOf(el))
    el.focus()
  }

  function activate(tile: Tile) {
    switch (tile.kind) {
      case 'new':
        void newTerminal()
        break
      case 'group':
        showTiles(() => setOpenFlag(tile.flag))
        return
      case 'back':
        showTiles(() => setOpenFlag(null))
        return
      case 'command':
        void runCommand(tile.cmd)
        break
      case 'run':
        void runTask()
        break
      case 'save':
        openCommands({ draft: { name: tile.command.split('\n')[0].slice(0, 40), command: tile.command } })
        break
      case 'edit':
        openCommands(commands().length ? {} : { draft: {} })
        break
    }
    // A pick leaves the launcher: the console or the modal takes the keyboard.
    props.onClose?.()
  }

  /** Escape: clears the filter, else leaves the group opened, else closes the launcher. */
  function escape() {
    if (query()) showTiles(() => setQuery(''))
    else if (openFlag()) showTiles(() => setOpenFlag(null))
    else props.onClose?.()
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      // The launcher keeps the key: the Console tool and the terminals do not see it.
      e.preventDefault()
      e.stopPropagation()
      escape()
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activate(shown()[focus()])
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      move(e.key.slice(6).toLowerCase() as 'left' | 'right' | 'up' | 'down')
      return
    }
    if (e.key === 'Backspace') {
      if (query()) {
        e.preventDefault()
        showTiles(() => setQuery(query().slice(0, -1)))
      }
      return
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      showTiles(() => setQuery(query() + e.key))
    }
  }

  // The tiles shown change: the focus stays inside them.
  createEffect(() => {
    shown()
    setFocus((i) => Math.min(i, Math.max(0, shown().length - 1)))
  })

  onMount(() => {
    void loadCommands()
    const prev = document.activeElement as HTMLElement | null
    focusTile(focus())
    onCleanup(() => {
      const ae = document.activeElement
      if (props.float && prev?.isConnected && (!ae || ae === document.body || root.contains(ae))) prev.focus()
    })
  })

  // The grid keeps the keyboard while it is shown: a tile focused, then a modal or a prompt
  // opened from it, then nothing focused — the tile focused takes it back (the tiles are also
  // rebuilt when a console starts or ends, which blurs the one focused).
  onMount(() => {
    let ours = false
    let popup = false
    const focusin = (e: Event) => {
      const el = e.target as HTMLElement
      if (el.closest?.('.cmd-launcher')) ours = true
      else if (el !== document.body && !el.closest?.('.modal, .pick, .ctx-menu')) ours = false
    }
    const mo = new MutationObserver(() => {
      if (document.querySelector('.modal, .pick, .ctx-menu')) popup = true
      else if (popup) {
        popup = false
        ours = true
      }
      if (ours && document.activeElement === document.body) focusTile(focus())
    })
    document.addEventListener('focusin', focusin, true)
    mo.observe(document.body, { childList: true, subtree: true })
    onCleanup(() => {
      document.removeEventListener('focusin', focusin, true)
      mo.disconnect()
    })
  })

  // Floating panel: a click outside closes it (the ▶ button keeps its own toggle), and Escape
  // closes it even when the focus stayed on the ▶ button or a terminal.
  onMount(() => {
    if (!props.float) return
    const down = (e: MouseEvent) => {
      if (!root.contains(e.target as Node) && !props.anchor?.contains(e.target as Node)) props.onClose?.()
    }
    const key = (e: KeyboardEvent) => {
      // A modal or a prompt opened from a tile keeps its own Escape.
      if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey || document.querySelector('.modal, .pick, .ctx-menu')) return
      e.preventDefault()
      e.stopPropagation()
      escape()
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    onCleanup(() => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
    })
  })

  const floatStyle = () => {
    const r = props.anchor?.getBoundingClientRect()
    if (!props.float || !r) return undefined
    return { left: `${Math.max(8, Math.min(r.left, window.innerWidth - 320))}px`, top: `${r.bottom + 4}px` }
  }

  const badge = (c: Command) => {
    const con = consoleOfCommand(c.id)
    if (!con) return null
    return con.exited ? { text: String(con.code), cls: con.code === 0 ? 'ok' : 'danger' } : { text: '●', cls: 'running' }
  }

  return (
    <div class={`cmd-launcher${props.float ? ' float' : ''}`} style={floatStyle()} data-testid="cmd-launcher" role="group" aria-label={t('Commands of the project')} ref={root} onKeyDown={onKey}>
      <Show when={query()}>
        <div class="cmd-query" data-testid="cmd-query">
          <Icon name="search" size={12} />
          <span>{query()}</span>
        </div>
      </Show>
      <div class="cmd-grid">
        <For each={shown()}>
          {(tile, i) => {
            const cmd = tile.kind === 'command' ? tile.cmd : null
            const flag = cmd ? cmd.flag : tile.kind === 'group' ? tile.flag : null
            const b = cmd ? badge(cmd) : null
            const label = tile.kind === 'new' ? t('New terminal') : tile.kind === 'back' ? t('Back') : tile.kind === 'run' ? t('Run a command…') : tile.kind === 'edit' ? (commands().length ? t('Edit commands…') : t('Create a command…')) : tile.kind === 'save' ? t('Save “{command}” as a command…', { command: tile.command.length > 40 ? tile.command.slice(0, 40) + '…' : tile.command }) : tile.kind === 'group' ? tile.flag : cmd!.name || t('New command')
            const icon = tile.kind === 'new' ? 'terminal' : tile.kind === 'back' ? 'up' : tile.kind === 'run' ? 'play' : tile.kind === 'edit' ? 'edit' : tile.kind === 'save' ? 'plus' : flagIcon[flag!]
            const title = tile.kind === 'new' ? `${t('New terminal')} (${api.keys.shortcut('console.new')})` : cmd ? cmd.description || cmd.command : tile.kind === 'group' ? tile.cmds.map((c) => c.name).join('\n') : undefined
            return (
              <div
                class={`cmd-tile ${tile.kind}${flag ? ` flag-${flag}` : ''}`}
                role="button"
                tabindex={i() === focus() ? 0 : -1}
                title={title}
                data-testid="cmd-tile"
                onClick={() => activate(tile)}
              >
                <Show when={b}>
                  <span class={`cmd-badge ${b!.cls}`} title={b!.cls === 'running' ? t('Running') : undefined} data-testid="cmd-badge">
                    {b!.text}
                  </span>
                </Show>
                <span class="cmd-tile-icon">
                  <Icon name={icon} size={20} />
                </span>
                <span class="cmd-tile-name">{label}</span>
                <Show when={tile.kind === 'group'}>
                  <span class="cmd-tile-count muted small">{tile.kind === 'group' ? tile.cmds.length : ''}</span>
                </Show>
                <Show when={cmd && servesApp(cmd) ? cmd : null}>
                  {(app) => (
                    <button
                      class="cmd-tile-app"
                      title={t('Open “{name}” in a preview', { name: app().name })}
                      data-testid="cmd-tile-app"
                      onClick={(e) => (e.stopPropagation(), void openApp(app()), props.onClose?.())}
                    >
                      <Icon name="screen" size={12} />
                    </button>
                  )}
                </Show>
              </div>
            )
          }}
        </For>
      </div>
      <Show when={!shown().length}>
        <p class="muted small cmd-none">{t('No command yet.')}</p>
      </Show>
    </div>
  )
}
