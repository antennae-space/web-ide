// The Database explorer on a project over SSH (#152): its SQLite file is on the host, so each
// statement is the sqlite3 command of that host, which the IDE runs for the plugin (the core
// call exec, the grant exec:sqlite3). The host is the SSH server of the tests (sshtestd, built
// here), whose sqlite3 is fixtures/fake-sqlite3.py (no sqlite3 on the machines of the tests):
// the tree of the file, a table view with its total, every call in safe mode, the tree's read
// only.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawn } = require('child_process')
const { run, assert, installOfficial, WS } = require('../common.cjs')

const pod = path.resolve(__dirname, '../../pod')
const goBin = ['go', path.join(os.homedir(), 'sdk/go/bin/go')].find((g) => {
  try {
    execFileSync(g, ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sshtestd-'))
execFileSync(goBin, ['build', '-o', path.join(tmp, 'sshtestd'), './sshtest/sshtestd'], { cwd: pod })
// The sqlite3 of the host: the fake, first on the PATH of the commands sshtestd runs.
fs.mkdirSync(path.join(tmp, 'bin'))
fs.symlinkSync(path.join(__dirname, '..', 'fixtures', 'fake-sqlite3.py'), path.join(tmp, 'bin', 'sqlite3'))
const sshd = spawn(path.join(tmp, 'sshtestd'), [], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PATH: path.join(tmp, 'bin') + ':' + process.env.PATH } })
process.on('exit', () => sshd.kill())
const sshPort = new Promise((resolve) => sshd.stdout.once('data', (d) => resolve(parseInt(String(d), 10))))
const frame = (page, view) => page.frameLocator(`iframe.plugin-frame[data-view=${view}]`)

run(async ({ page }) => {
  // The file and the connection of the project on the host (the same machine here); the
  // connection of the built-in is taken by the plugin when its backend starts there.
  const dir = WS + '/other'
  fs.copyFileSync(WS + '/demo/app.db', dir + '/app.db')
  fs.mkdirSync(dir + '/.ide', { recursive: true })
  fs.writeFileSync(dir + '/.ide/connections.json', JSON.stringify([{ id: 'remote', name: 'Remote file', kind: 'sqlite', path: 'app.db', rememberPassword: false }]))
  const lock = await installOfficial('database')
  assert(lock?.grants.includes('exec:sqlite3'), 'its grant exec:sqlite3: ' + JSON.stringify(lock?.grants))

  // An SSH project on the test server, password asked when opening.
  await page.reload()
  await page.waitForSelector('.home .home-bar')
  await page.click('.home-bar button:has-text("New project")')
  await page.click('.modal [role=radio]:has-text("SSH")')
  await page.fill('.modal .field:has-text("Host") input', '127.0.0.1')
  await page.fill('.modal .field:has-text("Port") input', String(await sshPort))
  await page.selectOption('.modal .field:has-text("Authentication") select', 'password')
  await page.fill('.modal .field:has-text("Remote folder") input', dir)
  await page.fill('.modal .field:has-text("Title") input', 'remote')
  await page.click('.modal button:has-text("Create and open")')
  await page.waitForSelector('.modal input[type=password]', { timeout: 15000 })
  await page.fill('.modal input[type=password]', 'pw')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.menubar', { timeout: 15000 })

  // Its tool: the tree of the file on the host.
  await page.waitForSelector('.rail-btn[data-id=database]')
  if (!(await page.isVisible('iframe.plugin-frame[data-view=database]'))) await page.click('.rail-btn[data-id=database]')
  const tool = frame(page, 'database')
  await tool.locator('.conn-row:has-text("Remote file")').click()
  await tool.locator('.tree-row:has-text("main")').click()
  await tool.locator('.tree-row:has-text("users")').first().click()
  await tool.locator('.tree-row:has-text("users_email")').waitFor({ timeout: 15000 })
  assert(true, 'the tables, columns and indexes of a SQLite file on the SSH host')

  // A table view, paged with its total.
  await tool.locator('.tree-row:has-text("users")').first().dblclick()
  const table = frame(page, 'table')
  await table.locator('.grid').waitFor()
  await page.waitForTimeout(300)
  assert((await table.locator('.toolbar').textContent()).includes('of 250'), 'the table view, paged with its total')

  // What ran on the host: sqlite3 in safe mode, the tree read only.
  const calls = fs.readFileSync(dir + '/app.db.calls.log', 'utf8').trim().split('\n')
  assert(calls.length > 3 && calls.every((c) => c.includes('-safe')), 'every statement in safe mode: ' + calls.length)
  assert(calls.some((c) => c.includes('-readonly')), 'the tree read only')
})
