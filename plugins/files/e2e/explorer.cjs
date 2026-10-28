// File explorer: file type icons, click to select and double click to open, git colors
// (untracked, added, ignored), folder marks, expand/collapse all, locate, options.
const fs = require('fs')
const { execFileSync } = require('child_process')
const { run, openProject, open, assert, WS, OUT } = require('../../../e2e/common.cjs')

run(async ({ page }) => {
  const demo = WS + '/demo'
  fs.writeFileSync(demo + '/.gitignore', '*.log\n')
  fs.writeFileSync(demo + '/build.log', 'log\n')
  fs.mkdirSync(demo + '/gen')
  fs.writeFileSync(demo + '/gen/generated.go', 'package gen\n')
  fs.mkdirSync(demo + '/tests')
  fs.writeFileSync(demo + '/tests/app_test.go', 'package tests\n')
  await openProject(page)
  await page.waitForSelector('.explorer .tree-row')
  const row = (name) => `.explorer .tree-row[data-path="${demo}/${name}"]`

  // File type icons.
  await page.click(row('src'))
  await page.dblclick(row('src'))
  await page.waitForSelector(row('src/main.go'))
  const kind = (name) => page.getAttribute(row(name) + ' .file-icon', 'data-kind')
  assert((await kind('src/main.go')) === 'GO' && (await kind('src/app.php')) === 'PHP' && (await kind('go.mod')) === 'GO', 'language badges')
  assert((await kind('notes.txt')) === 'line' && (await kind('.gitignore')) === 'line' && (await kind('gen')) === 'folder', 'other recognized files and folders')

  // A click selects, a double click opens and focuses the editor.
  await page.click(row('notes.txt'))
  assert(await page.isVisible(row('notes.txt') + '.selected'), 'click selects the row')
  assert(!(await page.isVisible('.pane.active .tab:has-text("notes.txt")')), 'click does not open the file')
  await page.dblclick(row('notes.txt'))
  await page.waitForSelector('.pane.active .tab.active:has-text("notes.txt")')
  await page.waitForFunction(() => document.activeElement?.classList.contains('ed-content'))
  assert(true, 'double click opens the file and focuses the editor')

  // Git colors: untracked red, added green, ignored; and the status letter at the end of the row.
  assert(await page.isVisible(row('notes.txt') + ' .tree-name.git-untracked'), 'untracked file')
  assert((await page.textContent(row('notes.txt') + ' .tree-badge')) === 'U', 'badge of an untracked file')
  assert(await page.isVisible(row('build.log') + ' .tree-name.git-ignored'), 'file ignored by .gitignore')
  execFileSync('git', ['add', 'go.mod'], { cwd: demo })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForSelector(row('go.mod') + ' .tree-name.git-added', { timeout: 10000 })
  assert((await page.textContent(row('go.mod') + ' .tree-badge')) === 'A', 'added file, badge A')
  assert(await page.isVisible(row('src') + ' .tree-name.git-untracked'), 'folder of untracked files')

  // Folder marks.
  const mark = async (name, label) => {
    await page.click(row(name), { button: 'right' })
    await page.click(`.ctx-menu .ctx-item:has-text("${label}")`)
    await page.waitForSelector(row(name) + `[data-mark]`)
  }
  await mark('gen', 'Excluded folder')
  await mark('tests', 'Test folder')
  await mark('src', 'Source folder')
  const marks = JSON.parse(fs.readFileSync(demo + '/.ide/folders.json', 'utf8')).folders
  assert(marks.gen === 'excluded' && marks.tests === 'tests' && marks.src === 'source', 'marks saved in .ide/folders.json')
  assert(await page.isVisible(row('gen') + '.excluded .file-icon.mark-excluded'), 'excluded folder dimmed, orange icon')

  // Explorer decorations v2 (#179): the kind tints the row, the label sits after the name.
  const tint = async (name) => (await page.getAttribute(row(name), 'data-tint')) || ''
  const label = async (name) => (await page.textContent(row(name) + ' .tree-label')) || ''
  assert((await tint('gen')) === 'ignored' && (await tint('tests')) === 'test' && (await tint('src')) === 'marked', 'the row of a marked folder is tinted with its kind')
  assert((await label('tests')) === 'Test folder' && (await label('gen')) === 'Excluded folder', 'a label after the name of a marked folder')
  assert((await tint('build.log')) === 'ignored', 'a file ignored by .gitignore is tinted')
  assert(!(await page.$(row('notes.txt') + ' .tree-label')), 'a plain file has no label')
  await page.keyboard.press('Control+p')
  await page.waitForSelector('.pick-input')
  await page.keyboard.type('generated')
  await page.waitForTimeout(500)
  assert(!(await page.isVisible('.pick-item:has-text("generated.go")')), 'excluded folder left out of "go to file"')
  await page.keyboard.press('Escape')

  // The head of the Explorer holds its title only: its buttons sit in the corner group, next to
  // the ⋮ and the ✕ of its zone (#176).
  assert(!(await page.$$('.explorer .panel-head button').length), 'no button left in the head of the Explorer')
  const corner = await page.$$eval('[data-tool=explorer] .zone-corner button', (b) => b.map((x) => x.getAttribute('data-testid')))
  assert(
    JSON.stringify(corner) === JSON.stringify(['explorer-locate', 'explorer-expand', 'explorer-collapse', 'zone-menu']),
    'the corner group of the zone: ' + JSON.stringify(corner),
  )

  // Expand all (not the excluded folder), collapse all.
  await page.click('[data-testid=explorer-expand]')
  await page.waitForSelector(row('tests/app_test.go'))
  assert(!(await page.isVisible(row('gen/generated.go'))), 'expand all skips the excluded folder')
  // The tint and the label of a folder pass to its content (#179).
  assert((await page.getAttribute(row('tests/app_test.go'), 'data-tint')) === 'test', 'a file under a test folder keeps its tint')
  assert((await page.textContent(row('tests/app_test.go') + ' .tree-label')) === 'Test folder', 'and its label')
  // A selected tinted row keeps the background of the selection.
  await page.click(row('tests/app_test.go'))
  const bg = await page.evaluate((p) => {
    const row = document.querySelector(`.explorer .tree-row[data-path="${p}"]`)
    const probe = document.createElement('div')
    probe.style.background = getComputedStyle(document.documentElement).getPropertyValue('--bg-active').trim()
    document.body.append(probe)
    const active = getComputedStyle(probe).backgroundColor
    probe.remove()
    return { row: getComputedStyle(row).backgroundColor, active, selected: row.classList.contains('selected') }
  }, demo + '/tests/app_test.go')
  const rgb = (c) => c.replace(/\s+/g, '')
  assert(bg.selected && rgb(bg.row) === rgb(bg.active), `a selected tinted row keeps --bg-active: ${JSON.stringify(bg)}`)
  await page.screenshot({ path: OUT + '/explorer.png' })
  await page.click('[data-testid=explorer-collapse]')
  await page.waitForFunction(() => !document.querySelector('.explorer .tree-row[aria-expanded=true]'))
  assert(true, 'collapse all')

  // Locate the active file.
  await open(page, 'main.go')
  await page.click('[data-testid=explorer-locate]')
  await page.waitForSelector(row('src/main.go') + '.selected')
  assert(true, 'locate opens the folders and selects the file')

  // The options of the Explorer, in the ⋮ of its zone.
  const labels = () => page.$$eval('.ctx-menu .ctx-item .ctx-label', (els) => els.map((e) => e.textContent.trim()))
  const option = async (label) => {
    await page.click('[data-tool=explorer] [data-testid=zone-menu]')
    await page.waitForSelector('.ctx-menu')
    await page.click(`.ctx-menu .ctx-item:has-text("${label}")`)
  }
  await page.click('[data-tool=explorer] [data-testid=zone-menu]')
  await page.waitForSelector('.ctx-menu')
  const menu = await labels()
  assert(
    JSON.stringify(menu) === JSON.stringify(['Open in a window', 'Close', 'New file…', 'New folder…', 'Show the hidden files', 'Show the excluded folders', 'Open files with a single click', 'Always select the opened file', 'Refresh all']),
    'the items of the ⋮ of the Explorer: ' + JSON.stringify(menu),
  )
  await page.keyboard.press('Escape')
  await page.waitForSelector('.ctx-menu', { state: 'detached' })
  // The same list from a right click on the head of the zone (its title).
  await page.click('[data-tool=explorer] .panel-title', { button: 'right' })
  await page.waitForSelector('.ctx-menu')
  assert(JSON.stringify(await labels()) === JSON.stringify(menu), 'a right click on the zone opens the same list')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.ctx-menu', { state: 'detached' })

  await option('Show the hidden files')
  await page.waitForSelector(row('.gitignore'), { state: 'detached' })
  assert(true, 'hidden files hidden')
  await option('Show the excluded folders')
  await page.waitForSelector(row('gen'), { state: 'detached' })
  assert(true, 'excluded folders hidden')
  await option('Open files with a single click')
  await page.click(row('go.mod'))
  await page.waitForSelector('.pane.active .tab.active:has-text("go.mod")')
  assert(true, 'single click option opens the file')

  // The same items from the ⋮ of a tile of the Explorer are checked by the desks suite (a Grid
  // desk is the one that shows a tool as a tile).
})
