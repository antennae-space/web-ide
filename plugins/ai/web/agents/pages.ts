// The board of a session of the Agents tool: the images the user sent in it (doodles go as
// images), numbered in order. An agent draws no page. Reuse draws on a copy, joined to the
// next prompt of the session.
import { createMemo, createRoot, createSignal } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { BoardSource } from '../llm/board/Board'
import type { Page } from '../llm/board/pages'
import type { DoodleDoc } from '../llm/doodle/model'
import { agentImage, threads } from './state'
import { doodleFor } from './Composer'
import { t } from '../plugin'

/** The images loaded, by session and file: their source and size. */
const [pics, setPics] = createStore<Record<string, { src: string; w: number; h: number } | null>>({})

function load(key: string, id: string, file: string) {
  if (key in pics) return
  setPics(key, null)
  agentImage(id, file)
    .then(
      (src) =>
        new Promise<void>((done) => {
          const img = new Image()
          img.onload = () => (setPics(key, { src, w: img.naturalWidth, h: img.naturalHeight }), done())
          img.onerror = () => done()
          img.src = src
        }),
    )
    .catch(() => {})
}

const docs = new Map<string, DoodleDoc>()
function docOf(key: string, p: { src: string; w: number; h: number }): DoodleDoc {
  let doc = docs.get(key)
  if (!doc) {
    doc = {
      v: 1,
      frame: { x: 0, y: 0, w: p.w, h: p.h },
      preset: 'image',
      elements: [],
      background: { src: p.src, x: 0, y: 0, w: p.w, h: p.h },
    }
    docs.set(key, doc)
  }
  return doc
}

const sources = new Map<string, BoardSource>()

/** The board of a session (made once per session). */
export function sessionBoard(id: string): BoardSource {
  let s = sources.get(id)
  if (s) return s
  s = createRoot(() => {
    const [selectedKey, setSelectedKey] = createSignal<string | null>(null)
    const list = createMemo(() => {
      const out: Page[] = []
      ;(threads[id]?.entries ?? []).forEach((e, i) => {
        if (e.kind !== 'user') return
        ;(e.attachments ?? []).forEach((a, n) => {
          if (a.kind !== 'image' || !a.file) return
          const key = `${id}:${a.file}`
          load(key, id, a.file)
          const p = pics[key]
          if (p)
            out.push({
              key: `${i}:${n}`,
              number: out.length + 1,
              name: a.name,
              doc: docOf(key, p),
              from: 'user',
              msgIndex: i,
              thumb: p.src,
            })
        })
      })
      return out
    })
    const selected = () => list().find((p) => p.key === selectedKey()) ?? list()[list().length - 1]
    return {
      pages: list,
      selected,
      select: setSelectedKey,
      reuse: (p: Page) =>
        p.doc.background &&
        doodleFor(id, {
          src: p.doc.background.src,
          w: p.doc.frame.w,
          h: p.doc.frame.h,
        }),
      newDoodle: () => doodleFor(id),
      empty: () => t('The images and doodles you send to the agent appear here.'),
    }
  })
  sources.set(id, s)
  return s
}
