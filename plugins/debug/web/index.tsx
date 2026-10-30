// The Debug plugin's page (pod/plugins/debug, docs/design/debug.md): the Debug tool on the
// debug.* methods and events of the debug host, the breakpoints in the gutter of Code
// (editorDecorations), Run › Debug… and the run actions with the PhpStorm keys, and what the IDE
// does when the program stops.
import { createEffect, createRoot, on } from 'solid-js'
import type { PluginModule } from '@ide/types'
import { bindApi, relOf } from './plugin'
import { act, addOutput, debug, loadStop, refreshSessions, setDebug, upsertSession, type Session } from './state'
import { decorations, refreshBreakpoints, setBreakpoints, setFileVerified, toggleBreakpoint, watchSaves, type Breakpoint } from './gutter'
import { onEnd, onStop, watchVisibility } from './focus'
import { DebugTool, debugCorner } from './DebugTool'
import { editConfigurations, runDebug } from './run'
import './debug.css'

export const debug_: PluginModule = {
  activate(api) {
    bindApi(api)
    // Events of another worktree attached to the window are not the sessions shown.
    const shown = (from?: string) => !from || from === api.project.current()
    api.on('debug.session', (s: Session, from) => {
      if (!shown(from)) return
      upsertSession(s)
      if (s.state === 'ended') onEnd()
    })
    // An adapter that sets a breakpoint later (a package loaded) tells which.
    api.on('debug.breakpoint', (e: { body: { breakpoint?: { verified?: boolean; line?: number; message?: string; source?: { path?: string } } } }, from) => {
      const b = e.body?.breakpoint
      if (!shown(from) || !b?.source?.path || !b.line) return
      const file = relOf(b.source.path)
      if (file) setFileVerified(file, [{ line: b.line, verified: !!b.verified, message: b.message }], true)
    })
    api.on('debug.stopped', (e: { session: string; thread: number; file: string; line: number }, from) => {
      if (!shown(from)) return
      const s = debug.sessions.find((x) => x.id === e.session)
      if (s) upsertSession({ ...s, state: 'stopped', thread: e.thread, file: e.file, line: e.line })
      void loadStop(e.session, e.thread).then(() => onStop(e.session, e.file, e.line))
    })
    api.on('debug.output', (e: { session: string; category: string; output: string }, from) => shown(from) && addOutput(e.session, e.category || 'console', e.output))
    api.on('debug.error', (e: { session: string; error: string }, from) => {
      if (!shown(from)) return
      addOutput(e.session, 'stderr', e.error + '\n')
      api.ui.toast(e.error, 'error')
    })
    api.on('debug.thread', (e: { session: string }, from) => {
      if (!shown(from)) return
      const s = debug.sessions.find((x) => x.id === e.session)
      if (s?.state === 'stopped') void loadStop(s.id, s.thread)
    })
    api.on('debug.verified', (e: { file: string; breakpoints: { line: number; verified: boolean; message?: string }[] }, from) => shown(from) && setFileVerified(e.file, e.breakpoints))
    api.on('debug.breakpoints', (e: { file: string; breakpoints: Breakpoint[] }, from) => shown(from) && setBreakpoints(e.file, e.breakpoints.length ? e.breakpoints : undefined!))
    watchSaves()
    watchVisibility()

    const reload = () => {
      setDebug({ sessions: [], selected: undefined, views: {} })
      void refreshSessions()
      void refreshBreakpoints()
    }
    // Another worktree shown in the window: its own sessions and breakpoints.
    createRoot(() => createEffect(on(() => api.project.current(), (id, prev) => id && prev && reload(), { defer: true })))
    // Run actions answer false when there is nothing to act on: the key goes on to the others.
    const run = (m: Parameters<typeof act>[0]) => () => {
      const s = debug.sessions.find((x) => x.id === debug.selected) ?? debug.sessions[debug.sessions.length - 1]
      const live = ['continue', 'next', 'stepIn', 'stepOut'].includes(m) ? s?.state === 'stopped' : m === 'pause' ? s?.state === 'running' : !!s
      if (!live) return false
      void act(m)
    }
    return {
      tools: { debug: { component: DebugTool } },
      toolCorner: { debug: debugCorner },
      editorDecorations: decorations,
      opened: reload,
      commands: {
        'debug.run': () => void runDebug(),
        'debug.editConfigurations': () => void editConfigurations(),
        'debug.rerun': run('restart'),
        'debug.stop': run('stop'),
        'debug.resume': run('continue'),
        'debug.pause': run('pause'),
        'debug.stepOver': run('next'),
        'debug.stepInto': run('stepIn'),
        'debug.forceStepInto': run('stepIn'),
        'debug.stepOut': run('stepOut'),
        'debug.toggleBreakpoint': () => {
          const ed = api.editor.active()
          if (!ed || !relOf(ed.doc.path)) return false
          toggleBreakpoint(ed.doc.path, ed.doc.lineAt(ed.view.getSelection().head))
        },
      },
    }
  },
}

export { debug_ as debug }
