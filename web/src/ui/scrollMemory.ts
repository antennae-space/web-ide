// The scroll of a tool or of a tab, kept while it is not shown: a hidden view is unmounted (a
// keyed Show), so coming back to it would start at the top. Kept for the window's life only.
import { createEffect, onCleanup } from 'solid-js'

/** Where the scrolled elements of a view were: by their path of tags from the view's root. */
export type ScrollSpots = Record<string, { top: number; left: number; end?: boolean }>

const memory = new Map<string, ScrollSpots>()

export const scrollSpots = (key: string): ScrollSpots => memory.get(key) ?? {}
export const saveScrollSpots = (key: string, spots: ScrollSpots) => memory.set(key, spots)

/**
 * Follows the scroll of the elements under `root` (and of `root`), giving them to `save`, and
 * puts those of `saved` back as the content arrives: a few seconds at most, not after the user
 * scrolls or touches. An element at the end stays at the end (a thread grown since).
 * Self-contained: the sandbox bootstrap runs its source in a plugin's frame, plain ES2020.
 */
export function keepScroll(root: HTMLElement, saved: ScrollSpots, save: (spots: ScrollSpots) => void): () => void {
  const spots: ScrollSpots = { ...saved }
  // The path of an element: the tag of each ancestor under root and its rank among the siblings
  // of that tag (classes change with the state, the tags of a view do not).
  const pathOf = (el: Element) => {
    const parts: string[] = []
    for (let e: Element | null = el; e && e !== root; e = e.parentElement) {
      let i = 0
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++
      parts.unshift(e.tagName + ':' + i)
    }
    return parts.join('/')
  }
  const find = (path: string) => {
    let el: Element | null = root
    for (const part of path ? path.split('/') : []) {
      const [tag, n] = part.split(':')
      let i = Number(n)
      let c: Element | null = el.firstElementChild
      for (; c; c = c.nextElementSibling) if (c.tagName === tag && i-- === 0) break
      if (!c) return null
      el = c
    }
    return el
  }
  let timer = 0
  const flush = () => {
    clearTimeout(timer)
    timer = 0
    save({ ...spots })
  }
  const onScroll = (e: Event) => {
    const el = e.target
    if (!(el instanceof Element) || !(el === root || root.contains(el))) return
    const path = pathOf(el)
    if (el.scrollTop <= 0 && el.scrollLeft === 0) delete spots[path]
    else spots[path] = { top: el.scrollTop, left: el.scrollLeft, end: el.scrollTop >= el.scrollHeight - el.clientHeight - 4 }
    clearTimeout(timer)
    timer = setTimeout(flush, 150) as unknown as number
  }
  // Restored frame by frame as the content arrives (a list loaded, a view mounted late), then
  // watched until the end: a list drawn again falls back to the top, it is put back (a scroll
  // the view makes itself elsewhere, a file revealed, is its own).
  const pending = { ...saved }
  const done = new Map<string, Element>()
  const until = Date.now() + 3000
  let frame = 0
  const restore = () => {
    frame = 0
    for (const path of Object.keys(pending)) {
      const el = find(path)
      if (!el) continue
      const s = pending[path]
      const max = el.scrollHeight - el.clientHeight
      if (s.end) {
        if (max > 0) el.scrollTop = max
      } else if (done.get(path) === el && el.scrollTop > 0) continue
      else if (max >= s.top - 1) {
        el.scrollTop = s.top
        el.scrollLeft = s.left
        done.set(path, el)
      }
    }
    if (Object.keys(pending).length && Date.now() < until) frame = requestAnimationFrame(restore)
  }
  const stopRestore = () => {
    cancelAnimationFrame(frame)
    frame = 0
    for (const k of Object.keys(pending)) delete pending[k]
  }
  const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown']
  root.addEventListener('scroll', onScroll, true)
  inputs.forEach((n) => root.addEventListener(n, stopRestore, true))
  if (Object.keys(pending).length) frame = requestAnimationFrame(restore)
  return () => {
    stopRestore()
    if (timer) flush()
    root.removeEventListener('scroll', onScroll, true)
    inputs.forEach((n) => root.removeEventListener(n, stopRestore, true))
  }
}

/** Keeps the scroll of what `root` shows under `key` (a tool, a tab), following its changes. */
export function useScrollMemory(root: () => HTMLElement | undefined, key: () => string | undefined) {
  createEffect(() => {
    const el = root()
    const k = key()
    if (!el || !k) return
    onCleanup(keepScroll(el, scrollSpots(k), (s) => saveScrollSpots(k, s)))
  })
}
