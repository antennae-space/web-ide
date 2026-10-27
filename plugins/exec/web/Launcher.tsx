// Launcher of the Console: an Android-style grid of tiles shown by the new tab — a new terminal,
// the saved commands grouped by flag, then Run a command… and Edit commands…. Picking a tile
// converts the new tab into the console of that command. Keyboard-driven: the grid keeps one Tab
// stop, the first tile focused, typing filters across the groups, arrows move, Enter runs the tile
// focused, Escape leaves an opened group or clears the filter (and elsewhere, gives the focus back).
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Icon, t } from './plugin'
import { commands, consoleOfCommand, flagIcon, groupByFlag, loadCommands, openApp, runCommand, servesApp, type Command, type Flag } from './commands'
import { newConsole, releaseNewTabFocus, runTask } from './consoles'
import { openCommands } from './CommandsModal'

type Tile = { kind: 'new' } | { kind: 'back' } | { kind: 'run' } | { kind: 'edit' } | { kind: 'group'; flag: Flag; cmds: Command[] } | { kind: 'command'; cmd: Command }

export function Launcher() {
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
        void newConsole()
        return
      case 'group':
        showTiles(() => setOpenFlag(tile.flag))
        return
      case 'back':
        showTiles(() => setOpenFlag(null))
        return
      case 'command':
        void runCommand(tile.cmd)
        return
      case 'run':
        void runTask()
        return
      case 'edit':
        openCommands(commands().length ? {} : { draft: {} })
        return
    }
  }

  /** Escape: clears the filter, else leaves the group opened, else lets the key go (the focus
   *  goes back to the editor, as in the other tools). */
  function escape() {
    if (query()) {
      showTiles(() => setQuery(''))
      return true
    }
    if (openFlag()) {
      showTiles(() => setOpenFlag(null))
      return true
    }
    // Nothing to back out of: the grid lets go of the keyboard (Escape goes to the editor).
    releaseNewTabFocus()
    return false
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (escape()) {
        e.preventDefault()
        e.stopPropagation()
      }
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

  // The tiles shown change (a filter, a group, a console starting or ending): the focus stays
  // inside them while the launcher owns the keyboard.
  let ours = false
  createEffect(() => {
    shown()
    setFocus((i) => Math.min(i, Math.max(0, shown().length - 1)))
    if (ours && !document.activeElement?.closest?.('.cmd-launcher')) queueMicrotask(() => focusTile(focus()))
  })

  onMount(() => {
    void loadCommands()
    focusTile(focus())
  })

  // The grid keeps the keyboard while it is shown: a tile focused, then a modal or a prompt opened
  // from it, then nothing focused — the tile focused takes it back.
  onMount(() => {
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
      // A tile removed (the grid rebuilt) drops the focus on the body: it comes back a frame later.
      if (ours) requestAnimationFrame(() => document.activeElement === document.body && focusTile(focus()))
    })
    document.addEventListener('focusin', focusin, true)
    mo.observe(document.body, { childList: true, subtree: true })
    onCleanup(() => {
      document.removeEventListener('focusin', focusin, true)
      mo.disconnect()
    })
  })

  const badge = (c: Command) => {
    const con = consoleOfCommand(c.id)
    if (!con) return null
    return con.exited ? { text: String(con.code), cls: con.code === 0 ? 'ok' : 'danger' } : { text: '●', cls: 'running' }
  }

  return (
    <div class="cmd-launcher" data-testid="cmd-launcher" role="group" aria-label={t('Commands of the project')} ref={root} onKeyDown={onKey}>
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
            const label = tile.kind === 'new' ? t('New terminal') : tile.kind === 'back' ? t('Back') : tile.kind === 'run' ? t('Run a command…') : tile.kind === 'edit' ? (commands().length ? t('Edit commands…') : t('Create a command…')) : tile.kind === 'group' ? tile.flag : cmd!.name || t('New command')
            const icon = tile.kind === 'new' ? 'terminal' : tile.kind === 'back' ? 'up' : tile.kind === 'run' ? 'play' : tile.kind === 'edit' ? 'edit' : flagIcon[flag!]
            const title = tile.kind === 'new' ? t('A terminal of its own, in this tab') : cmd ? cmd.description || cmd.command : tile.kind === 'group' ? tile.cmds.map((c) => c.name).join('\n') : undefined
            return (
              <div
                class={`cmd-tile ${tile.kind}${flag ? ` flag-${flag}` : ''}`}
                role="button"
                tabindex={i() === focus() ? 0 : -1}
                title={title}
                data-testid="cmd-tile"
                onClick={() => activate(tile)}
              >
                <span class="cmd-tile-icon">
                  <Icon name={icon} size={22} />
                  <Show when={b}>
                    <span class={`cmd-badge ${b!.cls}`} title={b!.cls === 'running' ? t('Running') : undefined} data-testid="cmd-badge">
                      {b!.text}
                    </span>
                  </Show>
                  <Show when={tile.kind === 'group'}>
                    <span class="cmd-tile-count" data-testid="cmd-tile-count">{tile.kind === 'group' ? tile.cmds.length : ''}</span>
                  </Show>
                  <Show when={cmd && servesApp(cmd) ? cmd : null}>
                    {(app) => (
                      <button
                        class="cmd-tile-app"
                        title={t('Open “{name}” in a preview', { name: app().name })}
                        data-testid="cmd-tile-app"
                        onClick={(e) => (e.stopPropagation(), void openApp(app()))}
                      >
                        <Icon name="screen" size={12} />
                      </button>
                    )}
                  </Show>
                </span>
                <span class="cmd-tile-name">{label}</span>
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
