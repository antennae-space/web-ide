// The view in focus is kept in the desk (`session.focus`: a tool id, or `editor` for the active tab
// of the active pane, docs/design/desks.md): a desk opened elsewhere (the phone, through the
// relay) shows what the user was on. Applied when the window shows the desk, and followed live by
// the windows of the same desk that are not in use; a window in use is never moved. On a
// computer it is a highlight only (the focused part, the tool shown in its zone), never the
// keyboard; on a phone, the view shown.
import { createEffect, createMemo, createRoot, on } from 'solid-js'
import { route } from '../app/router'
import { focusPart, setFocusPart } from './focus'
import { mobileView, phone, setMobileView } from './mobile'
import { mutate, session } from './project'
import { shownIn, showTool, zoneOf } from './zones'

/** The view this window has in focus: the one shown on a phone, the focused part elsewhere. */
function localFocus(): string {
  if (phone()) return mobileView()
  const part = focusPart()
  return part === 'editor' ? 'editor' : (shownIn(session, part) ?? 'editor')
}

const inProject = () => route().name === 'project'

// Off while the desk of the window is loading or switching: the window must not write its own
// focus into the desk it arrives on before it showed the one kept there.
let live = false

/** Shows a view kept in the desk: a tool no longer placed falls back to the editor. */
function applyFocus(id: string) {
  const z = id === 'editor' ? undefined : zoneOf(session, id)
  if (!z) {
    if (phone()) setMobileView('editor')
    setFocusPart('editor')
    return
  }
  if (shownIn(session, z) !== id) mutate((s) => showTool(s, id))
  if (phone()) setMobileView(id)
  setFocusPart(z)
}

/** The window is about to show another desk: what it has in focus is not written meanwhile. */
export function holdDeskFocus() {
  live = false
}

/** The window shows a desk (loaded, switched): its view in focus comes to the front. */
export function applyDeskFocus() {
  if (inProject() && session.focus && session.focus !== localFocus()) applyFocus(session.focus)
  live = true
}

createRoot(() => {
  // What the user puts in focus becomes the desk's: on a change of the view only (a memo), not on
  // every session received, which would write this window's focus over the other's.
  const focused = createMemo(localFocus)
  createEffect(
    on(focused, (id) => {
      if (!live || !inProject() || id === session.focus) return
      mutate((s) => (s.focus = id))
    }),
  )
  // Another window of the desk changed it: followed unless this window is in use.
  createEffect(
    on(
      () => session.focus,
      (id) => {
        if (!live || !inProject() || !id || id === localFocus() || document.hasFocus()) return
        applyFocus(id)
      },
      { defer: true },
    ),
  )
})
