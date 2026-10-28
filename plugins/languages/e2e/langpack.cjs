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
const zlib = require('zlib')
const { run, openProject, open, assert, WS } = require('../../../e2e/common.cjs')

/**
 * Pixels of that color actually painted in a screenshot of an element. A computed style is not
 * enough for a decoration: the name of a row clips its overflow (ellipsis), which can clip the
 * wavy away while its computed style stays "wavy".
 */
async function painted(page, sel, [r, g, b]) {
  const buf = await (await page.$(sel)).screenshot()
  let p = 8, w = 0, h = 0, bpp = 4, idat = Buffer.alloc(0)
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8)
    if (type === 'IHDR') { w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12); bpp = buf[p + 25] === 6 ? 4 : 3 }
    else if (type === 'IDAT') idat = Buffer.concat([idat, buf.subarray(p + 8, p + 8 + len)])
    else if (type === 'IEND') break
    p += 12 + len
  }
  const raw = zlib.inflateSync(idat), stride = w * bpp, px = Buffer.alloc(h * stride)
  for (let y = 0, o = 0; y < h; y++, o += stride + 1) {
    const f = raw[o], line = raw.subarray(o + 1, o + 1 + stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, up = y ? px[(y - 1) * stride + x] : 0
      const corner = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0
      let v = line[x]
      if (f === 1) v += a
      else if (f === 2) v += up
      else if (f === 3) v += (a + up) >> 1
      else if (f === 4) { const q = a + up - corner, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - corner); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : corner }
      px[y * stride + x] = v & 255
    }
  }
  let n = 0
  for (let i = 0; i < px.length; i += bpp) if (Math.abs(px[i] - r) < 40 && Math.abs(px[i + 1] - g) < 40 && Math.abs(px[i + 2] - b) < 40) n++
  return n
}

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
  // A second toy file, in a subfolder, for the Explorer marks (#181, #184).
  fs.mkdirSync(WS + '/demo/sub', { recursive: true })
  fs.writeFileSync(WS + '/demo/sub/broken.toy', 'toy play\n')
  await openProject(page)
  await open(page, 'hello.toy')
  await page.waitForFunction(() => CSS.highlights.get('tok-keyword')?.size >= 2, null, { timeout: 10000 })
  assert(true, 'highlighted by the grammar of the pack')

  // Its server: a diagnostic on "bad", its confinement held, listed in Problems.
  await page.waitForFunction(() => CSS.highlights.get('diag-error')?.size, null, { timeout: 15000 })
  assert(true, 'the server of the pack gives diagnostics')
  if (!(await page.isVisible('[data-tool=problems]'))) await page.click('.rail-right .rail-btn[title^="Problems"]')
  await page.click('[data-tool=problems] .tab:has-text("Problems")')
  await page.waitForSelector('.problem:has-text("bad toy")')
  const problems = await page.textContent('[data-tool=problems]')
  assert(problems.includes('toy: confined') && !problems.includes('LEAK'), 'the server runs confined: ' + problems)
  assert(!fs.existsSync(WS + '/demo/toy-probe.txt'), 'it cannot write the project')

  // The Explorer marks what the server reports in error (#184): a red "!" in the right column of
  // the file and of each folder above it, and a red wavy underline under their names, Git colors kept.
  // The file in error is committed clean first, so its name is a modified one (--info, not --danger).
  if (!(await page.isVisible('.explorer .tree-row'))) await page.click('.rail-left .rail-btn[title^="Explorer"]')
  const git = (...a) => execFileSync('git', a, { cwd: WS + '/demo', env: { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@x', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@x' } })
  git('add', 'sub/broken.toy')
  git('commit', '-q', '-m', 'toy file')
  fs.writeFileSync(WS + '/demo/sub/broken.toy', 'toy play\nthis is bad\n')
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))) // the pod refreshes the git status on focus
  await open(page, 'broken.toy')
  await page.click('[data-testid=explorer-locate]')
  const row = (n) => `.explorer .tree-row[data-path="${WS}/demo/${n}"]`
  await page.waitForSelector(row('sub/broken.toy') + ' .tree-name.git-modified.has-error', { timeout: 15000 })
  const marks = await page.evaluate((sel) => {
    const probe = (v) => {
      const el = document.createElement('span')
      el.style.color = v
      document.body.appendChild(el)
      const c = getComputedStyle(el).color
      el.remove()
      return c
    }
    const s = getComputedStyle(document.querySelector(sel))
    return { line: s.textDecorationLine, style: s.textDecorationStyle, wavyColor: s.textDecorationColor, nameColor: s.color, danger: probe('var(--danger)'), info: probe('var(--info)') }
  }, row('sub/broken.toy') + ' .tree-name')
  assert(marks.line === 'underline' && marks.style === 'wavy' && marks.wavyColor === marks.danger, 'the file in error holds a red wavy underline: ' + JSON.stringify(marks))
  assert(marks.nameColor === marks.info, 'the file in error keeps the Git color of its name: ' + marks.nameColor)
  assert(await page.isVisible(row('sub/broken.toy') + ' .tree-error-sign'), 'the file in error holds a red !')
  assert(await page.isVisible(row('sub') + ' .tree-error-sign'), 'the folder above the error holds a red !')
  assert(/git-\w+/.test((await page.getAttribute(row('sub') + ' .tree-name', 'class')) ?? '') && (await page.isVisible(row('sub') + ' .tree-badge')), 'the marked folder keeps its Git color and its status letter')
  const folder = await page.evaluate((sel) => {
    const s = getComputedStyle(document.querySelector(sel))
    return [s.textDecorationLine, s.textDecorationStyle, s.textDecorationColor]
  }, row('sub') + ' .tree-name')
  assert(folder[0] === 'underline' && folder[1] === 'wavy' && folder[2] === marks.danger, 'the folder above the error holds the wavy too: ' + folder.join(' '))
  // And it is really drawn: the name clips its overflow, which used to clip the wave away. The ink
  // of these names is the Git color (--info), so the red pixels under them are the wavy.
  const danger = marks.danger.match(/\d+/g).map(Number)
  const waves = { file: await painted(page, row('sub/broken.toy') + ' .tree-name', danger), dir: await painted(page, row('sub') + ' .tree-name', danger) }
  assert(waves.file > 20 && waves.dir > 20, 'the wavy is painted under the file and under the folder: ' + JSON.stringify(waves))
  // The sign sits in the right column, after the name and next to the status letter; the name of a
  // marked folder stays where the name of an unmarked one of the same depth is.
  const places = await page.evaluate(([r, plain]) => {
    const at = (s) => document.querySelector(s).getBoundingClientRect()
    return { name: at(r + ' .tree-name').left, sign: at(r + ' .tree-error-sign').left, badge: at(r + ' .tree-badge').left, other: at(plain + ' .tree-name').left }
  }, [row('sub'), row('src')])
  assert(places.sign > places.name && places.badge > places.sign, 'the ! is at the right end of the row, next to the status letter: ' + JSON.stringify(places))
  assert(Math.abs(places.name - places.other) < 1, 'the sign does not move the name: ' + places.name + ' vs ' + places.other)
  // The opened file: the wavy wins over the faint underline of the current row.
  const opened = await page.evaluate((sel) => {
    const s = getComputedStyle(document.querySelector(sel))
    return [s.textDecorationStyle, s.textDecorationColor]
  }, row('sub/broken.toy') + '.current .tree-name')
  assert(opened[0] === 'wavy' && opened[1] === marks.danger, 'the wavy replaces the underline of the opened file: ' + opened.join(' '))

  // Fixing the file takes the wavy and the signs away, without a reload (didChange → publish).
  await page.click('.pane.active .ed-content')
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('End')
  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace')
  await page.keyboard.press('Control+s')
  await page.waitForFunction(([bad, dot, fdot]) => !document.querySelector(bad) && !document.querySelector(dot) && !document.querySelector(fdot), [row('sub/broken.toy') + ' .tree-name.has-error', row('sub') + ' .tree-error-sign', row('sub/broken.toy') + ' .tree-error-sign'], { timeout: 15000 })
  const gone = { file: await painted(page, row('sub/broken.toy') + ' .tree-name', danger), dir: await painted(page, row('sub') + ' .tree-name', danger) }
  assert(gone.file === 0 && gone.dir === 0, 'the wavy and the ! go away with the error: ' + JSON.stringify(gone))
  await open(page, 'hello.toy')

  // Completion: its words, one read in the folder it is granted.
  await page.click('.pane.active .ed-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('lib')
  await page.keyboard.press('Control+Space')
  await page.waitForSelector('.completion-item:has-text("libword")', { timeout: 10000 })
  assert(true, 'a completion of the server, from its granted folder')
  // A reload: the restored tab keeps the grammar of its pack, without closing and reopening it
  // (the grammars are known before the session's documents detect their language).
  await page.reload()
  await page.waitForSelector('.pane.active .tab:has-text("hello.toy")')
  await page.waitForFunction(() => CSS.highlights.get('tok-keyword')?.size >= 2, null, { timeout: 10000 })
  assert(true, 'the highlighting of a pack survives a reload')

  // A grammar that arrives while its file is already open (an import in the settings): the open
  // buffer is detected again, the tab never closed.
  fs.writeFileSync(WS + '/demo/hello.zz', 'zz alpha\n')
  await page.waitForTimeout(1500)
  if (!(await page.isVisible('.tree-row:has-text("hello.zz")'))) await page.click('.rail-left .rail-btn[title^="Explorer"]')
  await page.waitForSelector('.tree-row:has-text("hello.zz")', { timeout: 10000 })
  await page.dblclick('.tree-row:has-text("hello.zz")')
  await page.waitForSelector('.pane.active .tab:has-text("hello.zz")')
  await page.waitForTimeout(500)
  const gram = path.join(TMP, 'zz.json')
  fs.writeFileSync(gram, JSON.stringify({ id: 'zz', name: 'ZZ', extensions: ['.zz'], states: { root: [{ token: 'keyword', regex: '\\bzz\\b' }] } }))
  await page.keyboard.press('Control+Alt+s')
  await page.click('.settings-nav button:has-text("Syntax highlighting")')
  await page.setInputFiles('.settings-body input[type=file]', gram)
  await page.waitForFunction(() => CSS.highlights.get('tok-keyword')?.size >= 1, null, { timeout: 10000 })
  assert(true, 'a grammar that arrives colors the buffer already open')
  await page.keyboard.press('Escape')
})
