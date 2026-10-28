// The built-in rules the Files plugin gives the Explorer decorations (#182): which name is a test,
// a library root or a manifest, and what a folder mark gives to the folder and to its content. The
// rules answer on the `kind` / `tint` / `label` channels (docs/design/plugins.md); the Explorer
// merges them with what the other plugins say (Git: `state` + `badge`).
import type { FileDecoration, FileKind } from '@ide/types'
import { api, desk, t } from './plugin'

export type FolderMark = 'source' | 'tests' | 'excluded'

/** The category a folder mark gives it and its content. */
export const markKinds: Record<FolderMark, FileKind> = { source: 'marked', tests: 'test', excluded: 'ignored' }
export const markLabels: Record<FolderMark, string> = { source: 'Source folder', tests: 'Test folder', excluded: 'Excluded folder' }

/**
 * Name patterns of a test file, one RegExp per family, matched on the name only (never on the
 * path). User-defined globs stay out of the plugin (#182).
 */
const testPatterns: RegExp[] = [
  /^.*_test\.\w+$/, // *_test.go, *_test.py, *_test.rs
  /^.*\.(test|spec)\.\w+$/, // *.test.ts, *.spec.tsx
  /^(test_|spec_).*\.py$/, // test_*.py, spec_*.py
  /^.*[Tt]est\.(php|java|kt|kts|cs|scala)$/, // *Test.php, *Test.java
  /^.*[Ss]pec\.(php|java|kt|cs)$/,
]

/** Folders taken as a root of dependencies or of build output, at any depth. */
const libraryNames = new Set(['node_modules', 'vendor', '.git', '.venv', 'venv', 'dist', 'build', 'target', 'out', 'pods', '__pycache__', '.terraform', 'coverage'])

/** Names of a manifest or a configuration file. */
const manifestNames = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'go.mod', 'go.sum', 'composer.json', 'composer.lock', 'tsconfig.json', 'jsconfig.json', 'makefile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'])

/** True for the name of a folder taken as a library root. */
export const isLibraryName = (name: string) => libraryNames.has(name.toLowerCase())

const isTestName = (name: string) => testPatterns.some((re) => re.test(name))
const isManifestName = (name: string) => manifestNames.has(name.toLowerCase()) || name === '.env' || name.startsWith('.env.')

/**
 * What the Files plugin knows of a path, by its name and the marks of its folders. The first rule
 * that answers wins: the name of the entry itself, then the mark of the folder itself, then the
 * mark of the nearest marked folder above it. Null when no rule knows it, or when the family is
 * switched off in the desk (the row then falls back to what its folder passes down).
 */
export function decorate(path: string, dir: boolean): FileDecoration | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const s = desk.get()
  const of = (kind: FileKind, label?: string): FileDecoration => ({ kind, tint: kind, label })
  if (s.tintTests && isTestName(name)) return of('test')
  if (s.tintManifests && isManifestName(name)) return of('manifest')
  if (s.tintLibrary && dir && isLibraryName(name)) return of('library', t('Library root'))
  if (!s.tintMarks) return null
  const mark = api.folders.mark(path)
  if (mark) return of(markKinds[mark], t(markLabels[mark]))
  const above = api.folders.markOf(path)
  return above ? of(markKinds[above], t(markLabels[above])) : null
}
