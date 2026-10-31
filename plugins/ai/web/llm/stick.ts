// A thread that stays at its end while the user is there: the Assistant and the Agents tool.
// Any growth follows — new messages, a message updated in place higher up, late renders
// (Markdown, diagrams, images) — and so does the view shrinking (the message box growing).
import { onCleanup } from 'solid-js'

/** Distance to the end under which the view is at the end, px. */
const NEAR = 60

/**
 * Follows the end of `scroller` (its first child is the content). Only a move up stops
 * following: the event of our own scroll to the end may come after the thread grew again.
 */
export function stickToEnd(scroller: HTMLElement) {
  let stuck = true
  let lastTop = 0
  const end = () => {
    scroller.scrollTop = scroller.scrollHeight
    lastTop = scroller.scrollTop
  }
  const onScroll = () => {
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR) stuck = true
    else if (scroller.scrollTop < lastTop) stuck = false
    lastTop = scroller.scrollTop
  }
  scroller.addEventListener('scroll', onScroll, { passive: true })
  const ro = new ResizeObserver(() => stuck && end())
  ro.observe(scroller)
  if (scroller.firstElementChild) ro.observe(scroller.firstElementChild)
  onCleanup(() => {
    ro.disconnect()
    scroller.removeEventListener('scroll', onScroll)
  })
  return {
    stuck: () => stuck,
    /** Scrolls to the end on the next frame, when following. */
    follow: () => requestAnimationFrame(() => stuck && end()),
    /** Follows again (a message sent, another conversation) and goes to the end. */
    reset: () => {
      stuck = true
      requestAnimationFrame(end)
    },
  }
}
