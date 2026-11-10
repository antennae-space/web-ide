// The drag of a handle (a resizer between zones, tiles or columns). The pointer is captured by the
// handle: an iframe under the cursor (an external plugin, a preview) would else take the moves and
// the release, and the drag would stay stuck to the mouse. The iframes take no pointer events
// while it lasts (`body.dragging`), and a lost capture ends the drag too.

/** Follows the drag started by e on its handle: move at each move, done once at the end. */
export function dragPointer(e: PointerEvent, move: (ev: PointerEvent) => void, opts: { done?: () => void; cursor?: 'col-resize' | 'row-resize' } = {}) {
  e.preventDefault()
  const handle = e.currentTarget as HTMLElement
  try {
    handle.setPointerCapture(e.pointerId)
  } catch {
    // A synthetic event has no active pointer: the listeners of the window still follow it.
  }
  const body = document.body
  body.classList.add('dragging')
  if (opts.cursor) body.style.setProperty('--drag-cursor', opts.cursor)
  const end = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    handle.removeEventListener('lostpointercapture', end)
    body.classList.remove('dragging')
    body.style.removeProperty('--drag-cursor')
    opts.done?.()
  }
  // Captured events still bubble up to the window.
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  handle.addEventListener('lostpointercapture', end)
}
