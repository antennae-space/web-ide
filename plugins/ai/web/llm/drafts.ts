// The drafts of the message boxes, by key: the Assistant of a project (`llm.draft.<home>`), an
// agent session (`agents.draft.<session>`). A draft is a text and the attachments prepared for
// it. The text is also kept in the session of the tab (#76): a phone that discards a tab in the
// background reloads it whole, and what was being typed must still be there.
import { createStore, produce } from 'solid-js/store'
import { prepareDoodle } from './doodle/export'
import { cloneDoc, newDoc, type DoodleDoc } from './doodle/model'
import { doodleSession, openDoodle } from './doodle/session'
import type { Picture } from './doodle/background'
import { prepare, type Prepared } from './attachments'
import type { Attachment, Caps } from './state'
import { t, toast } from '../plugin'

interface Draft {
  text: string
  pending: Prepared[]
  /** Attachments being prepared (a file read, a doodle drawn as an image). */
  preparing: number
}

const [drafts, setDrafts] = createStore<Record<string, Draft>>({})

function stored(key: string) {
  try {
    return sessionStorage.getItem('webide.' + key) ?? ''
  } catch {
    return ''
  }
}

function keep(key: string, text: string) {
  try {
    if (text) sessionStorage.setItem('webide.' + key, text)
    else sessionStorage.removeItem('webide.' + key)
  } catch {
    /* storage unavailable */
  }
}

function edit(key: string, f: (d: Draft) => void) {
  setDrafts(produce((all) => f((all[key] ??= { text: stored(key), pending: [], preparing: 0 }))))
}

/** The text of a draft: the one of the session of the tab before the first edit. */
export const draftText = (key: string) => drafts[key]?.text ?? stored(key)
export const draftPending = (key: string): Prepared[] => drafts[key]?.pending ?? []
export const draftPreparing = (key: string) => drafts[key]?.preparing ?? 0

export function setDraftText(key: string, text: string) {
  edit(key, (d) => (d.text = text))
  keep(key, text)
}

/** Adds an attachment, or puts it in place of `replace` (a doodle edited again). */
export function addPending(key: string, p: Prepared, replace?: Prepared) {
  edit(key, (d) => {
    const i = replace ? d.pending.indexOf(replace) : -1
    if (i >= 0) d.pending[i] = p
    else d.pending.push(p)
  })
}

export function removePending(key: string, i: number) {
  edit(key, (d) => d.pending.splice(i, 1))
}

/** Empties a draft once sent. */
export function clearDraft(key: string) {
  edit(key, (d) => ((d.text = ''), (d.pending = [])))
  keep(key, '')
}

/** How the doodles of a box are drawn: what the reader of the message sees, in the host or not. */
export interface DoodleTarget {
  key: string
  caps: () => Caps | undefined
  /** Drawn in the host of the project window (an agent session: the Assistant may be closed). */
  external?: boolean
}

/** Converts files (picked, pasted or dropped) into attachments of the draft. */
export async function addFiles(to: DoodleTarget, files: Iterable<File>) {
  const key = to.key
  for (const f of files) {
    edit(key, (d) => d.preparing++)
    try {
      const p = await prepare(f, to.caps())
      if (p.warning) toast(`${f.name}: ${p.warning}`, 'warn')
      addPending(key, p)
    } catch (e) {
      toast(`${f.name}: ${(e as Error).message}`, 'error')
    } finally {
      edit(key, (d) => d.preparing--)
    }
  }
}

async function attachDoodle(to: DoodleTarget, doc: DoodleDoc, name: string, replace?: Prepared) {
  const key = to.key
  edit(key, (d) => d.preparing++)
  try {
    addPending(key, await prepareDoodle(doc, name, to.caps()), replace)
  } finally {
    edit(key, (d) => d.preparing--)
  }
}

const nextName = (key: string) => t('Doodle {n}', { n: draftPending(key).filter((p) => p.attachment.kind === 'doodle').length + 1 })

/** Opens a new doodle, on a picture (a page of a board, a screenshot) or blank; Attach joins it. */
export function newDoodleFor(to: DoodleTarget, background?: Picture) {
  if (doodleSession()) return
  const name = nextName(to.key)
  openDoodle({ doc: newDoc(background), name, external: to.external, onAttach: (doc) => attachDoodle(to, doc, name) })
}

/** Opens an editable copy of a doodle sent earlier: Attach joins it as a new one. */
export function reuseDoodleFor(to: DoodleTarget, a: Attachment) {
  if (doodleSession() || !a.doodle) return
  const name = nextName(to.key)
  openDoodle({ doc: cloneDoc(a.doodle), name, external: to.external, onAttach: (doc) => attachDoodle(to, doc, name) })
}

/** Opens a doodle of the draft again; Attach replaces it. */
export function editDoodleOf(to: DoodleTarget, p: Prepared) {
  const { name, doodle } = p.attachment
  openDoodle({ doc: cloneDoc(doodle!), name, external: to.external, onAttach: (doc) => attachDoodle(to, doc, name, p) })
}
