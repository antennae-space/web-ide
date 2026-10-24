// A language pack (#145): a fixture pack for a toy language (its grammar, its server: the Go
// program of e2e/fixtures/toy-lsp on the PATH of the pod, a folder of the host it is granted)
// installed as official. A .toy file is highlighted by the pack's grammar; its server runs
// confined (it neither reads the pod's key nor writes the project) and gives diagnostics,
// listed in Problems, and completion, a word of its granted folder included.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { run, openProject, open, assert, WS } = require('../../../e2e/common.cjs')

const DATA = process.env.E2E_DATA
const TMP = process.env.E2E_TMP

run(async ({ page }) => {
  // The server, on the PATH of the pod.
  const goBin = [process.env.GO, path.join(os.homedir(), 'sdk/go/bin/go'), 'go'].find((g) => g && (g === 'go' || fs.existsSync(g)))
  execFileSync(goBin, ['build', '-o', path.join(TMP, 'bin', 'toy-lsp'), path.join(__dirname, '..', '..', '..', 'e2e', 'fixtures', 'toy-lsp', 'main.go')], { env: { ...process.env, CGO_ENABLED: '0' } })
  // A folder of the host the server needs (path:TOYLIB).
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-toylib-'))
  fs.writeFileSync(path.join(lib, 'words.txt'), 'libword\n')

  // The pack: no view, no backend; a language, its grammar and its server.
  const manifest = {
    id: 'lang-toy', name: 'Toy language', version: '1.0.0', apiVersion: 1, ide: '*', assets: 'https://example.invalid/{version}/{arch}.tar.gz',
    permissions: ['program:toy-lsp', 'path:TOYLIB'],
    contributes: {
      languages: [{
        id: 'toy', name: 'Toy', extensions: ['.toy'], markers: ['toy.mod'], grammar: 'grammars/toy.json',
        servers: [{ argv: ['toy-lsp'], paths: [{ name: 'TOYLIB', candidates: ['$TOYLIB_UNSET', lib], env: true }] }],
        tests: { '.toy': '{name}_spec.toy' },
      }],
    },
  }
  const grammar = { id: 'x', name: 'x', extensions: [], states: { root: [{ token: 'keyword', regex: '\\b(?:toy|play)\\b' }, { token: 'comment', regex: '#.*' }] } }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-langpack-'))
  fs.mkdirSync(path.join(dir, 'grammars'))
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(dir, 'grammars', 'toy.json'), JSON.stringify(grammar))
  const archive = execFileSync('tar', ['czf', '-', '-C', dir, '.'])
  const arch = 'linux-' + (os.arch() === 'arm64' ? 'arm64' : 'amd64')
  const off = path.join(DATA, '..', 'official')
  fs.writeFileSync(path.join(off, 'official.json'), JSON.stringify([{ id: 'lang-toy', url: 'https://example.invalid/lang-toy', constraint: '*', version: '1.0.0', sha256: { [arch]: crypto.createHash('sha256').update(archive).digest('hex') } }]))
  fs.writeFileSync(path.join(off, 'archives', 'current', 'lang-toy-1.0.0.tar.gz'), archive)
  execFileSync('bash', [process.env.E2E_RESTART_POD])
  const lockFile = path.join(DATA, 'plugins.lock')
  for (let i = 0; i < 100 && !(fs.existsSync(lockFile) && JSON.parse(fs.readFileSync(lockFile, 'utf8')).plugins['lang-toy']); i++) await new Promise((r) => setTimeout(r, 100))
  assert(JSON.parse(fs.readFileSync(lockFile, 'utf8')).plugins['lang-toy']?.grants.join() === 'program:toy-lsp,path:TOYLIB', 'the pack installed with its grants')

  // A toy file: highlighted by the pack's grammar.
  fs.writeFileSync(WS + '/demo/toy.mod', '')
  fs.writeFileSync(WS + '/demo/hello.toy', 'toy play # a toy\nthis is bad\n\n')
  await openProject(page)
  await open(page, 'hello.toy')
  await page.waitForFunction(() => CSS.highlights.get('tok-keyword')?.size >= 2, null, { timeout: 10000 })
  assert(true, 'highlighted by the grammar of the pack')

  // Its server: a diagnostic on "bad", its confinement held, listed in Problems.
  await page.waitForFunction(() => CSS.highlights.get('diag-error')?.size, null, { timeout: 15000 })
  assert(true, 'the server of the pack gives diagnostics')
  if (!(await page.isVisible('[data-tool=problems]'))) await page.click('.rail-right .rail-btn[title="Problems"]')
  await page.click('[data-tool=problems] .tab:has-text("Problems")')
  await page.waitForSelector('.problem:has-text("bad toy")')
  const problems = await page.textContent('[data-tool=problems]')
  assert(problems.includes('toy: confined') && !problems.includes('LEAK'), 'the server runs confined: ' + problems)
  assert(!fs.existsSync(WS + '/demo/toy-probe.txt'), 'it cannot write the project')

  // Completion: its words, one read in the folder it is granted.
  await page.click('.pane.active .ed-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('lib')
  await page.keyboard.press('Control+Space')
  await page.waitForSelector('.completion-item:has-text("libword")', { timeout: 10000 })
  assert(true, 'a completion of the server, from its granted folder')
  await page.keyboard.press('Escape')
})
