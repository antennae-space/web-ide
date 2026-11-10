// The Database explorer, an official external plugin (#144): its release archive installed at
// start (installOfficial: the version of official.json, or E2E_PLUGIN_DATABASE: a local build). The data of the built-in it was are migrated (connections of
// the project, a remembered secret, the SQL history); its tool, a console with the IDE's editor
// (two statements: the chooser, the result), a table view; the AI through the MCP: a read-only
// query runs, a write refused by the database itself, execute read only by default; its consoles
// in Scratches and Consoles of the Explorer (#245).
const fs = require('fs')
const os = require('os')
const path = require('path')
const { run, openProject, assert, mcp, installOfficial, WS } = require('../common.cjs')

const DATA = process.env.E2E_DATA
const frame = (page, view) => page.frameLocator(`iframe.plugin-frame[data-view=${view}]`)
const text = (r) => r.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(r)

run(async ({ page }) => {
  // The data of the built-in Database explorer: a connection of the project, a remembered
  // secret, a SQL history.
  await openProject(page)
  const projects = JSON.parse(fs.readFileSync(path.join(DATA, 'projects.json'), 'utf8'))
  const demo = (projects.projects ?? projects).find((p) => p.root === WS + '/demo' || p.path === WS + '/demo')
  assert(demo?.id, 'the demo project: ' + JSON.stringify(projects).slice(0, 200))
  fs.mkdirSync(WS + '/demo/.ide', { recursive: true })
  fs.writeFileSync(WS + '/demo/.ide/connections.json', JSON.stringify([{ id: 'legacy', name: 'Legacy', kind: 'sqlite', path: 'app.db', rememberPassword: false }]))
  fs.writeFileSync(path.join(DATA, 'secrets.json'), JSON.stringify({ [`${demo.id}/pg`]: { password: 'pw' } }))
  fs.mkdirSync(path.join(DATA, 'sql-history'), { recursive: true })
  fs.writeFileSync(path.join(DATA, 'sql-history', `${demo.id}-legacy.json`), JSON.stringify([{ ts: new Date().toISOString(), query: 'SELECT 1 -- before', durationMs: 1, rows: 1 }]))

  // Official, from its archive: installed at the next start; the first start of this pod
  // marked the migration done (nothing to move then): again.
  const lock = await installOfficial('database', () => fs.rmSync(path.join(DATA, 'migrations.json'), { force: true }))
  assert(lock?.official && lock.grants.includes('dial') && lock.grants.includes('vault'), 'installed, official, its permissions granted: ' + JSON.stringify(lock))
  const secrets = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8'))
  assert(secrets[`plugin:database/${demo.id}/pg`] === '{"password":"pw"}' && !secrets[`${demo.id}/pg`], 'the secret moved to its vault: ' + JSON.stringify(secrets))
  assert(fs.existsSync(path.join(DATA, 'plugin-data', 'database', 'sql-history', `${demo.id}-legacy.json`)), 'the SQL history moved')

  // Its tool: the connection of the built-in, its tree.
  await page.reload()
  await page.waitForSelector('.rail-btn[data-id=database]')
  if (!(await page.isVisible('iframe.plugin-frame[data-view=database]'))) await page.click('.rail-btn[data-id=database]')
  const tool = frame(page, 'database')
  await tool.locator('.conn-row:has-text("Legacy")').click()
  await tool.locator('.tree-row:has-text("main")').click()
  await tool.locator('.tree-row:has-text("users")').first().click()
  await tool.locator('.tree-row:has-text("users_email")').waitFor()
  assert(true, 'the migrated connection, its tables, columns and indexes')
  assert(fs.existsSync(path.join(DATA, 'plugin-data', 'database', 'connections', `${demo.id}.json`)), 'its connections in its data folder')

  // The tree is kept in the desk (#200): a new desk shows it folded, desk 1 finds it as it was
  // left, after a reload too.
  const showTool = async () => {
    const shown = await page.waitForSelector('iframe.plugin-frame[data-view=database]', { state: 'visible', timeout: 3000 }).then(() => true, () => false)
    if (!shown) await page.click('.rail-btn[data-id=database]')
    await frame(page, 'database').locator('.conn-row:has-text("Legacy")').waitFor()
  }
  await page.waitForTimeout(600)
  await page.click('[data-testid=desk-add]')
  await page.waitForFunction(() => location.pathname.endsWith('/desk/2'))
  await showTool()
  await page.waitForTimeout(500)
  assert(!(await frame(page, 'database').locator('.tree-row:has-text("users_email")').count()), 'a new desk shows the tree folded')
  await page.click('[data-testid=desk-1]')
  await page.waitForFunction(() => !location.pathname.includes('/desk/'))
  await showTool()
  await frame(page, 'database').locator('.tree-row:has-text("users_email")').waitFor()
  await page.reload()
  await page.waitForSelector('.rail-btn[data-id=database]')
  await showTool()
  await frame(page, 'database').locator('.tree-row:has-text("users_email")').waitFor()
  assert(true, 'desk 1 finds its tree as it was left, after a reload too')

  // The connections in a modal of the IDE (#154), centered, titled with the plugin.
  await tool.locator('button[title="Edit the connections"]').click()
  await page.waitForSelector('.modal-plugin iframe.plugin-frame[data-view=connections]')
  assert((await page.textContent('.modal-plugin .modal-head h2')) === 'Database explorer · Database connections', 'the connections in a modal of the IDE')
  await frame(page, 'connections').locator('.conn-item:has-text("Legacy")').waitFor()
  await page.click('.modal-plugin .modal-head button')
  await page.waitForSelector('.modal-plugin', { state: 'detached' })

  // A table view, paged.
  await tool.locator('.tree-row:has-text("users")').first().dblclick()
  const table = frame(page, 'table')
  await table.locator('.grid').waitFor()
  await page.waitForTimeout(300)
  assert((await table.locator('.toolbar').textContent()).includes('of 250'), 'the table view, paged with its total')

  // A console: the IDE's editor above, two statements: the chooser, the result.
  await tool.locator('.conn-row:has-text("Legacy")').click()
  await tool.locator('button[title^="Open a console"]').click()
  await page.waitForSelector('[data-testid=plugin-editor] .ed-content')
  const con = frame(page, 'sql')
  await con.locator('.sql-console .conn-label:has-text("Legacy")').waitFor()
  assert(true, 'the console knows its connection (a call of the frame at load is answered)')
  await page.click('[data-testid=plugin-editor] .ed-content')
  await page.keyboard.type('SELECT count(*) AS n FROM users;\nSELECT name FROM users WHERE id < 4;')
  await page.keyboard.press('Control+Enter')
  await page.waitForSelector('.pick .pick-item')
  assert((await page.textContent('.pick .pick-item.selected')).includes('WHERE id < 4'), 'the chooser of the IDE preselects the statement under the caret')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await con.locator('.sql-result .grid').waitFor()
  assert((await con.locator('.sql-result .grid').textContent()).includes('250'), 'the result of the first statement')
  await page.screenshot({ path: path.join(process.env.E2E_OUT ?? os.tmpdir(), 'database-console.png') })

  // The console in Scratches and Consoles of the Explorer (#245), under the node of its
  // connection; a hidden tab keeps its node (the background frame lists the console tabs), a
  // double click shows it, its menu renames it or closes it.
  if (!(await page.isVisible('.explorer'))) await page.click('.rail-left .rail-btn[title^="Explorer"]')
  const connNode = '.explorer .tree-row[data-path="node:scratches/database:conn:legacy"]'
  const consoleNodes = '.explorer .tree-row[data-path^="node:scratches/database:conn:legacy/database:console:"]'
  const consolesShown = () => page.evaluate(() => document.querySelectorAll('[data-path^="node:scratches/database:conn:legacy/database:console:"]').length)
  await page.waitForSelector(connNode)
  await page.click(connNode + ' .tree-twist')
  await page.waitForSelector(consoleNodes)
  assert((await page.textContent(connNode + ' .tree-name')) === 'Legacy', 'the connection of the console in Scratches and Consoles')
  await page.click('.pane.active .tab:has-text("users")')
  await page.waitForTimeout(500)
  assert(await page.isVisible(consoleNodes), 'a hidden console tab keeps its node')
  await page.dblclick(consoleNodes)
  await page.waitForSelector('.pane.active .tab.active:has-text("Console")')
  assert(true, 'a double click on the console shows its tab')

  // A second console of the same connection: the two consoles under one connection node.
  await tool.locator('button[title^="Open a console"]').click()
  await page.waitForSelector('[data-testid=plugin-editor] .ed-content')
  for (let i = 0; i < 20 && (await consolesShown()) < 2; i++) await page.waitForTimeout(250)
  assert((await consolesShown()) === 2, 'two consoles of one connection')
  assert((await page.$$(connNode)).length === 1, 'they share one connection node')

  // Close in the menu of a node closes that console; Rename… names it, in the tree and on its tab.
  await page.locator(consoleNodes).last().click({ button: 'right' })
  await page.click('.ctx-menu >> text=Close')
  for (let i = 0; i < 20 && (await consolesShown()) > 1; i++) await page.waitForTimeout(250)
  assert((await consolesShown()) === 1, 'Close in its menu closes the console')
  await page.click(consoleNodes, { button: 'right' })
  await page.click('.ctx-menu >> text=Rename…')
  await page.fill('.modal.modal-small input', 'Users console')
  await page.keyboard.press('Enter')
  for (let i = 0; i < 20 && (await page.textContent(consoleNodes + ' .tree-name')) !== 'Users console'; i++) await page.waitForTimeout(250)
  assert((await page.textContent(consoleNodes + ' .tree-name')) === 'Users console', 'Rename… names the console in the Explorer')
  assert(!!(await page.$('.pane.active .tab:has-text("Users console")')), 'and its tab takes the name')
  await page.click(consoleNodes, { button: 'right' })
  await page.click('.ctx-menu >> text=Close')
  await page.waitForSelector(consoleNodes, { state: 'detached' })
  assert(!(await page.$(connNode)), 'its connection node goes with the last console closed')

  // The AI: the connections, a read-only query, a write refused by the database, execute read only.
  let r = await mcp('database_connections', {})
  assert(text(r).includes('Legacy') && text(r).includes('legacy'), 'its connections: ' + text(r))
  r = await mcp('database_query', { conn: 'legacy', query: 'SELECT count(*) AS n FROM users' })
  assert(!r.result?.isError && text(r).includes('250'), 'a read-only query: ' + text(r))
  r = await mcp('database_query', { conn: 'legacy', query: 'DELETE FROM users' })
  assert(r.result?.isError || /readonly|read-only|query_only/i.test(text(r)), 'a write in a read-only query fails in the database: ' + text(r))
  r = await mcp('database_execute', { conn: 'legacy', query: 'DELETE FROM users' })
  assert(r.result?.isError && text(r).includes('read only'), 'execute is read only by default: ' + text(r))
  r = await mcp('database_query', { conn: 'legacy', query: 'SELECT count(*) AS n FROM users' })
  assert(text(r).includes('250'), 'nothing deleted: ' + text(r))
})
