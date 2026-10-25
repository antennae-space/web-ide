// A pack's server installed from the IDE (#153): the toy pack's server (e2e/fixtures/toy-lsp)
// is missing, so a file of its language shows a banner over the editor; Install runs the pack's
// recipe (npm, here a fake npm on the PATH of the pod that copies the toy server) in a console of
// the core, into the pack's folder of tools ($XDG_DATA_HOME/web-ide/tools/<pack>); the banner
// goes, the server runs confined from there, and Settings > Plugins shows where it is.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { run, openProject, open, assert, WS } = require('../../../e2e/common.cjs')

const DATA = process.env.E2E_DATA
const TMP = process.env.E2E_TMP

run(async ({ page }) => {
  // The server, built aside (not on the PATH); npm, a fake that "installs" it under its prefix.
  const goBin = [process.env.GO, path.join(os.homedir(), 'sdk/go/bin/go'), 'go'].find((g) => g && (g === 'go' || fs.existsSync(g)))
  const built = path.join(TMP, 'toybuild', 'toy-lsp')
  execFileSync(goBin, ['build', '-o', built, path.join(__dirname, '..', '..', '..', 'e2e', 'fixtures', 'toy-lsp', 'main.go')], { env: { ...process.env, CGO_ENABLED: '0' } })
  fs.mkdirSync(path.join(TMP, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'bin', 'npm'), `#!/bin/sh
# A fake npm: install -g --prefix <dir> … copies the toy server to <dir>/bin.
while [ $# -gt 0 ]; do [ "$1" = --prefix ] && prefix=$2; shift; done
mkdir -p "$prefix/bin" && cp ${JSON.stringify(built)} "$prefix/bin/toy-lsp" && echo "added 1 package"
`, { mode: 0o755 })
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-toylib-'))
  fs.writeFileSync(path.join(lib, 'words.txt'), 'libword\n')

  // The pack, its server with a recipe.
  const manifest = {
    id: 'lang-toy', name: 'Toy language', version: '1.0.0', apiVersion: 1, ide: '*', assets: 'https://example.invalid/{version}/{arch}.tar.gz',
    permissions: ['program:toy-lsp', 'path:TOYLIB'],
    contributes: {
      languages: [{
        id: 'toy', name: 'Toy', extensions: ['.toy'], markers: ['toy.mod'],
        servers: [{ argv: ['toy-lsp'], paths: [{ name: 'TOYLIB', candidates: [lib], env: true }], install: { manager: 'npm', packages: ['toy-lsp'] } }],
      }],
    },
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-langinstall-'))
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest))
  const archive = execFileSync('tar', ['czf', '-', '-C', dir, '.'])
  const arch = 'linux-' + (os.arch() === 'arm64' ? 'arm64' : 'amd64')
  const off = path.join(DATA, '..', 'official')
  fs.writeFileSync(path.join(off, 'official.json'), JSON.stringify([{ id: 'lang-toy', url: 'https://example.invalid/lang-toy', constraint: '*', version: '1.0.0', sha256: { [arch]: crypto.createHash('sha256').update(archive).digest('hex') } }]))
  fs.writeFileSync(path.join(off, 'archives', 'current', 'lang-toy-1.0.0.tar.gz'), archive)
  execFileSync('bash', [process.env.E2E_RESTART_POD])
  const lockFile = path.join(DATA, 'plugins.lock')
  for (let i = 0; i < 100 && !(fs.existsSync(lockFile) && JSON.parse(fs.readFileSync(lockFile, 'utf8')).plugins['lang-toy']); i++) await new Promise((r) => setTimeout(r, 100))

  // A toy file: no server, a banner.
  fs.writeFileSync(WS + '/demo/toy.mod', '')
  fs.writeFileSync(WS + '/demo/hello.toy', 'toy play\nthis is bad\n')
  await openProject(page)
  await open(page, 'hello.toy')
  await page.waitForSelector('[data-testid=server-banner]', { timeout: 10000 })
  const banner = await page.textContent('[data-testid=server-banner]')
  assert(banner.includes('No language server for Toy') && banner.includes('Install toy-lsp'), 'a banner over the editor: ' + banner)

  // Install: a console of the core runs the recipe; the banner goes.
  await page.click('[data-testid=server-banner] button:has-text("Install toy-lsp")')
  await page.waitForSelector('.console-tabs .tab:has-text("Install toy-lsp")', { timeout: 10000 })
  await page.waitForSelector('[data-testid=server-banner]', { state: 'detached', timeout: 20000 })
  const installed = path.join(TMP, 'xdg', 'web-ide', 'tools', 'lang-toy', 'npm', 'bin', 'toy-lsp')
  assert(fs.existsSync(installed), 'installed into the folder of tools of the pack')

  // The server runs from there, confined: its diagnostics.
  await page.click('.pane.active .ed-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('more bad\n')
  await page.waitForFunction(() => CSS.highlights.get('diag-error')?.size, null, { timeout: 20000 })
  assert(true, 'the installed server gives diagnostics')

  // Settings > Plugins: the server and where it is.
  await page.keyboard.press('Control+Alt+s')
  await page.click('.settings-nav button:has-text("Plugins")')
  const row = await page.textContent('[data-testid=pack-server-toy-lsp]')
  assert(row.includes(installed) && row.includes('Update'), 'Settings lists the server, found: ' + row)
})
