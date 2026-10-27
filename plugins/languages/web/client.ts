// Code navigation through the language servers run by the pod.
import type { Doc, PickItem } from '@ide/api'
import kindsJson from './kinds.json'
import { visibilityOf, type Visibility } from './visibility'
import { api, fuzzy, pick, t, toast } from './plugin'

export interface Position {
  line: number
  character: number
}
export interface Range {
  start: Position
  end: Position
}
export interface Location {
  path: string
  range: Range
}

export interface DocumentSymbol {
  name: string
  detail?: string
  kind: number
  range: Range
  selectionRange: Range
  children?: DocumentSymbol[]
  /** The file a node stands for (a file node of the package view); its children belong to it too. */
  file?: string
}

/**
 * Symbol kinds (their LSP number) → [name, glyph, family]: the one table of web/kinds.json,
 * read by the Structure tool, the Symbols tab, the file structure list and the pod's assistant
 * (plugins/languages/kinds.go embeds the same file). A family is a color of the theme (--sym-*).
 */
export const symbolKinds = kindsJson.kinds as unknown as Record<number, [name: string, glyph: string, family: string]>
export const symbolFamilies = kindsJson.families as string[]

export class NoServer extends Error {}

export async function lsp<T = any>(path: string, method: string, params: any): Promise<T> {
  const lang = api.editor.serverLanguage(path)
  if (!lang) throw new NoServer(t('No language server for this file type'))
  return api.rpc('lsp.request', { lang, method, params })
}

function at(doc: Doc, offset: number) {
  const { line, col } = doc.pos(offset)
  return { textDocument: { uri: api.project.fileUri(doc.path) }, position: { line, character: col } }
}

export function toLocations(res: any): Location[] {
  if (!res) return []
  const list = Array.isArray(res) ? res : [res]
  return list
    .map((l: any) => {
      if (l.targetUri) return { path: api.project.pathFromUri(l.targetUri), range: l.targetSelectionRange ?? l.targetRange }
      if (l.uri) return { path: api.project.pathFromUri(l.uri), range: l.range }
      return null
    })
    .filter((l): l is Location => !!l)
}

export function jump(loc: Location) {
  return api.openFile({ path: loc.path, line: loc.range.start.line, col: loc.range.start.character })
}

/** One location: jump. Several: a list with the line of each one. */
export async function showLocations(locs: Location[], title: string) {
  if (!locs.length) {
    toast(t('{title}: no result', { title }), 'info')
    return
  }
  if (locs.length === 1) {
    await jump(locs[0])
    return
  }
  const lines = new Map<string, string[]>()
  for (const l of locs.slice(0, 200)) {
    if (!lines.has(l.path)) {
      try {
        const f = await api.files.read(l.path)
        lines.set(l.path, (f.content as string).split('\n'))
      } catch {
        lines.set(l.path, [])
      }
    }
  }
  const items: PickItem<Location>[] = locs.map((l) => ({
    label: (lines.get(l.path)?.[l.range.start.line] ?? '').trim() || api.project.basename(l.path),
    detail: `${api.project.relPath(l.path)}:${l.range.start.line + 1}`,
    value: l,
  }))
  const chosen = await pick({ placeholder: `${title} (${locs.length})`, items, codeLabel: true, pathDetail: true })
  if (chosen) await jump(chosen)
}

function contains(r: Range, line: number, ch: number) {
  if (line < r.start.line || line > r.end.line) return false
  if (line === r.start.line && ch < r.start.character) return false
  if (line === r.end.line && ch > r.end.character) return false
  return true
}

function guard(e: unknown) {
  if (e instanceof NoServer) toast(e.message, 'info')
  else toast(t('Language server: {message}', { message: (e as Error).message }), 'error')
}

/** Ctrl+B: declaration, or the usages when the caret already is on the declaration. */
export async function gotoDeclaration(doc: Doc, offset: number) {
  try {
    const locs = toLocations(await lsp(doc.path, 'textDocument/definition', at(doc, offset)))
    const { line, col } = doc.pos(offset)
    const onItself = locs.length > 0 && locs.every((l) => l.path === doc.path && contains(l.range, line, col))
    if (onItself) return findReferences(doc, offset)
    await showLocations(locs, t('Declaration'))
  } catch (e) {
    guard(e)
  }
}

export async function findReferences(doc: Doc, offset: number) {
  try {
    const locs = toLocations(await lsp(doc.path, 'textDocument/references', { ...at(doc, offset), context: { includeDeclaration: false } }))
    await showLocations(locs, t('Usages'))
  } catch (e) {
    guard(e)
  }
}

export async function gotoImplementation(doc: Doc, offset: number) {
  try {
    await showLocations(toLocations(await lsp(doc.path, 'textDocument/implementation', at(doc, offset))), t('Implementations'))
  } catch (e) {
    guard(e)
  }
}

export async function gotoTypeDefinition(doc: Doc, offset: number) {
  try {
    await showLocations(toLocations(await lsp(doc.path, 'textDocument/typeDefinition', at(doc, offset))), t('Type declaration'))
  } catch (e) {
    guard(e)
  }
}

export async function documentSymbols(path: string): Promise<DocumentSymbol[]> {
  const res = await lsp<any[]>(path, 'textDocument/documentSymbol', { textDocument: { uri: api.project.fileUri(path) } })
  if (!res) return []
  // SymbolInformation[] (flat) is converted to the hierarchical form.
  return res.map((s: any) => (s.selectionRange ? s : { name: s.name, kind: s.kind, detail: s.containerName, range: s.location.range, selectionRange: s.location.range }))
}

export function flatten(symbols: DocumentSymbol[], depth = 0, out: { s: DocumentSymbol; depth: number }[] = []) {
  for (const s of symbols) {
    out.push({ s, depth })
    if (s.children) flatten(s.children, depth + 1, out)
  }
  return out
}

/** Stable id of a symbol in a file (the folded state of the Structure tool is a list of these). */
export function symbolId(s: DocumentSymbol): string {
  return `${s.kind}:${s.selectionRange.start.line}:${s.name}`
}

/** Alphabetical order at every level: a symbol stays under its parent. */
export function sortSymbols(list: DocumentSymbol[]): DocumentSymbol[] {
  const out = [...list].sort((a, b) => a.name.localeCompare(b.name))
  return out.map((s) => (s.children?.length ? { ...s, children: sortSymbols(s.children) } : s))
}

/** A row of the tree: a symbol, its depth, whether it folds, whether it is folded, its lock, its file. */
export interface TreeRow {
  s: DocumentSymbol
  depth: number
  hasChildren: boolean
  folded: boolean
  visibility: Visibility
  /** The file the symbol belongs to (the active file in the single-file view). */
  file: string
}

/** A folded id, distinct for two files that hold a symbol of the same name. */
export function rowKey(file: string, id: string): string {
  return `${file}#${id}`
}

/** The visible rows, in tree order (the children of a folded symbol are left out). `file` is the
 * file of the symbols of this level: a file node of the package view carries its own, and gives it
 * to its children. */
export function treeRows(list: DocumentSymbol[], folded: Set<string>, lang: string, depth = 0, out: TreeRow[] = [], file = ''): TreeRow[] {
  for (const s of list) {
    const own = s.file ?? file
    const has = !!s.children?.length
    const isFolded = folded.has(rowKey(own, symbolId(s)))
    out.push({ s, depth, hasChildren: has, folded: isFolded, visibility: s.file ? 'none' : visibilityOf(lang, s), file: own })
    if (has && !isFolded) treeRows(s.children!, folded, lang, depth + 1, out, own)
  }
  return out
}

/** Exported symbols first, private after, at every level: file order kept, children kept under their parent. */
export function sortByExportability(list: DocumentSymbol[], lang: string): DocumentSymbol[] {
  const isPrivate = (s: DocumentSymbol) => !s.file && visibilityOf(lang, s) === 'private'
  const out = [...list.filter((s) => !isPrivate(s)), ...list.filter(isPrivate)]
  return out.map((s) => (s.children?.length ? { ...s, children: sortByExportability(s.children, lang) } : s))
}

/** The tree without the private symbols: a private symbol takes its children with it (a file node is never private). */
export function filterPrivate(list: DocumentSymbol[], lang: string): DocumentSymbol[] {
  return list
    .filter((s) => !!s.file || visibilityOf(lang, s) !== 'private')
    .map((s) => (s.children?.length ? { ...s, children: filterPrivate(s.children, lang) } : s))
}

/** Where a query matches a text: the positions it hits, as the core's fuzzy scorer walks them ([]: no match). */
export function fuzzyMarks(q: string, text: string): number[] {
  if (!q) return []
  const lower = text.toLowerCase()
  const at: number[] = []
  let from = 0
  for (const ch of q.toLowerCase()) {
    const i = lower.indexOf(ch, from)
    if (i < 0) return []
    at.push(i)
    from = i + 1
  }
  return at
}

/**
 * Speed Search: the symbols kept by a query. A match keeps its whole subtree; a parent of a
 * match stays with its kept children only. An empty query changes nothing.
 */
export function filterSymbols(list: DocumentSymbol[], q: string): DocumentSymbol[] {
  if (!q) return list
  const out: DocumentSymbol[] = []
  for (const s of list) {
    const self = fuzzy(q, s.name) > 0 || (!!s.detail && fuzzy(q, s.detail) > 0)
    if (self) {
      out.push(s)
      continue
    }
    const kept = s.children?.length ? filterSymbols(s.children, q) : []
    if (kept.length) out.push({ ...s, children: kept })
  }
  return out
}

/** Chain of symbols containing a position, outermost first (the opened element is its last one). */
export function enclosingSymbols(symbols: DocumentSymbol[], line: number, ch: number): DocumentSymbol[] {
  for (const s of symbols) {
    if (contains(s.range, line, ch)) return [s, ...enclosingSymbols(s.children ?? [], line, ch)]
  }
  return []
}

const methodKinds = new Set([6, 9, 12])
const typeKinds = new Set([5, 10, 11, 23])

/** Super method: type hierarchy of the enclosing class, then the method of the same name. */
export async function gotoSuperMethod(doc: Doc, offset: number) {
  try {
    const { line, col } = doc.pos(offset)
    const chain = enclosingSymbols(await documentSymbols(doc.path), line, col)
    const method = [...chain].reverse().find((s) => methodKinds.has(s.kind))
    const cls = [...chain].reverse().find((s) => typeKinds.has(s.kind))
    if (!method || !cls) {
      toast(t('The caret must be in a class method'), 'info')
      return
    }
    const items = await lsp<any[]>(doc.path, 'textDocument/prepareTypeHierarchy', {
      textDocument: { uri: api.project.fileUri(doc.path) },
      position: cls.selectionRange.start,
    }).catch(() => null)
    if (!items?.length) {
      toast(t('This language server does not provide the type hierarchy'), 'info')
      return
    }
    const supers = await lsp<any[]>(doc.path, 'typeHierarchy/supertypes', { item: items[0] })
    const found: Location[] = []
    for (const sup of supers ?? []) {
      const path = api.project.pathFromUri(sup.uri)
      const syms = await symbolsOf(path)
      const target = flatten(syms).find(({ s }) => s.name === method.name && methodKinds.has(s.kind) && contains(sup.range, s.range.start.line, s.range.start.character))
      if (target) found.push({ path, range: target.s.selectionRange })
    }
    if (!found.length) toast(t('No super method for {name}', { name: method.name }), 'info')
    else await showLocations(found, t('Super method'))
  } catch (e) {
    guard(e)
  }
}

/** Symbols of a file that may not be open: opened in the server for the request. */
export async function symbolsOf(path: string): Promise<DocumentSymbol[]> {
  try {
    const s = await documentSymbols(path)
    if (s.length) return s
  } catch {
    /* fall through */
  }
  const lang = api.editor.serverLanguage(path)
  if (!lang) return []
  const f = await api.files.read(path)
  const uri = api.project.fileUri(path)
  await api.rpc('lsp.notify', { lang, method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: api.editor.serverLanguageId(path), version: 1, text: f.content } } })
  try {
    return await documentSymbols(path)
  } finally {
    await api.rpc('lsp.notify', { lang, method: 'textDocument/didClose', params: { textDocument: { uri } } })
  }
}

/** The folder a path lives in, as the project shows it ('' for the root of the project). */
export function dirOf(path: string): string {
  const rel = api.project.relPath(path)
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

/** The most sibling files the package view lists: the cost stays that of a folder, not of the project. */
export const packageFileCap = 40

interface FsEntry {
  name: string
  path: string
  dir: boolean
  link?: boolean
  size: number
}

/**
 * The package of a file: the files of its folder served by the same language server (`app.php`
 * never joins a Go package, `.ts` and `.tsx` stay together), its `_test.go` files left out, as
 * well as the hidden files and the excluded folders. Name order, capped at `packageFileCap`;
 * `total` tells whether the cap cut the list.
 */
export async function packageFiles(path: string): Promise<{ files: string[]; total: number }> {
  const lang = api.editor.serverLanguage(path)
  if (!lang) return { files: [path], total: 1 }
  let entries: FsEntry[]
  try {
    entries = await api.rpc<FsEntry[]>('fs.list', { path: dirOf(path) })
  } catch {
    entries = []
  }
  const kept = entries
    .filter((e) => !e.dir && !e.link && !e.name.startsWith('.') && !api.folders.inExcluded(e.path))
    .filter((e) => !(lang === 'go' && e.name.endsWith('_test.go')) && (api.editor.serverLanguage(e.path) === lang || e.path === path))
    .map((e) => e.path)
  if (!kept.includes(path)) kept.push(path)
  kept.sort((a, b) => api.project.basename(a).localeCompare(api.project.basename(b)))
  return { files: kept.slice(0, packageFileCap), total: kept.length }
}

/** Symbols of several files, four at a time (a server is not flooded with `didOpen`). */
export async function packageSymbols(paths: string[]): Promise<Map<string, DocumentSymbol[]>> {
  const out = new Map<string, DocumentSymbol[]>()
  let next = 0
  const work = async () => {
    while (next < paths.length) {
      const p = paths[next++]
      out.set(p, await symbolsOf(p).catch(() => [] as DocumentSymbol[]))
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, work))
  return out
}

/** The node a file gets in the package view (its range stands for the file, it is never jumped to). */
export function fileSymbol(path: string): DocumentSymbol {
  const start = { line: 0, character: 0 }
  return { name: api.project.basename(path), kind: 1, detail: dirOf(path), range: { start, end: start }, selectionRange: { start, end: start }, file: path }
}

export async function hoverText(doc: Doc, offset: number): Promise<string> {
  const res = await lsp<any>(doc.path, 'textDocument/hover', at(doc, offset))
  if (!res?.contents) return ''
  const part = (c: any): string => (typeof c === 'string' ? c : c.value ?? '')
  const text = Array.isArray(res.contents) ? res.contents.map(part).join('\n\n') : part(res.contents)
  return text.replace(/```\w*\n?/g, '').trim()
}

export async function workspaceSymbols(path: string, query: string, signal?: AbortSignal) {
  const lang = api.editor.serverLanguage(path)
  if (!lang) return []
  const res = await api.rpc<any[]>('lsp.request', { lang, method: 'workspace/symbol', params: { query } }, signal)
  return (res ?? []).map((s: any) => ({
    name: s.name as string,
    kind: s.kind as number,
    container: (s.containerName as string) ?? '',
    loc: s.location?.range ? { path: api.project.pathFromUri(s.location.uri), range: s.location.range } : null,
  }))
}
