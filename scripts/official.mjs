// Puts the release archives of the official plugins for one architecture into
// pod/plugins/official/archives/current/, to be embedded by the next `go build`:
//   node scripts/official.mjs linux-amd64
// For each entry of pod/plugins/official/official.json: its plugin.json at the tag v<version>
// (a shallow clone) gives the address of its archives; the archive must have the sha256 of the
// list, else the build stops. The release workflow runs it before the go build of each arch.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arch = process.argv[2]
if (!/^linux-(amd64|arm64)$/.test(arch ?? '')) {
  console.error('usage: node scripts/official.mjs linux-amd64|linux-arm64')
  process.exit(2)
}
const root = new URL('..', import.meta.url).pathname
const dir = join(root, 'pod/plugins/official/archives/current')
const list = JSON.parse(readFileSync(join(root, 'pod/plugins/official/official.json'), 'utf8'))
mkdirSync(dir, { recursive: true })
for (const f of readdirSync(dir)) if (f.endsWith('.tar.gz')) rmSync(join(dir, f))

for (const e of list) {
  const want = e.sha256?.[arch]
  if (!want) throw new Error(`${e.id} ${e.version}: no sha256 for ${arch} in official.json`)
  const tmp = mkdtempSync(join(tmpdir(), 'official-'))
  try {
    execFileSync('git', ['-c', 'advice.detachedHead=false', 'clone', '-q', '--depth', '1', '--branch', 'v' + e.version, e.url, tmp], { stdio: 'inherit' })
    const m = JSON.parse(readFileSync(join(tmp, 'plugin.json'), 'utf8'))
    if (m.id !== e.id || m.version !== e.version) throw new Error(`${e.url} v${e.version} holds ${m.id} ${m.version}`)
    const url = m.assets.replaceAll('{version}', e.version).replaceAll('{arch}', arch)
    const r = await fetch(url)
    if (!r.ok) throw new Error(`${url}: ${r.status}`)
    const data = Buffer.from(await r.arrayBuffer())
    const got = createHash('sha256').update(data).digest('hex')
    if (got !== want) throw new Error(`${url}: sha256 ${got}, official.json says ${want}`)
    writeFileSync(join(dir, `${e.id}-${e.version}.tar.gz`), data)
    console.log(`official: ${e.id} ${e.version} ${arch} (${(data.length / 1048576).toFixed(1)} MB)`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
