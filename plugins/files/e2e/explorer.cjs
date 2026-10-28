// File explorer: file type icons, click to select and double click to open, git colors
// (untracked, added, ignored), folder marks, expand/collapse all, locate, options.
const fs = require('fs')
const { execFileSync } = require('child_process')
const { run, openProject, open, assert, WS, OUT } = require('../../../e2e/common.cjs')

run(async ({ page }) => {
  const demo = WS + '/demo'
  fs.writeFileSync(demo + '/.gitignore', '*.log\nnode_modules/\n')
  fs.writeFileSync(demo + '/build.log', 'log\n')
  fs.mkdirSync(demo + '/gen')
  fs.writeFileSync(demo + '/gen/generated.go', 'package gen\n')
  fs.mkdirSync(demo + '/tests')
  fs.writeFileSync(demo + '/tests/app_test.go', 'package tests\n')
  // The paths the built-in rules of the Files plugin know (#182).
  fs.mkdirSync(demo + '/node_modules', { recursive: true })
  fs.writeFileSync(demo + '/node_modules/dep.js', 'module.exports = 1\n')
  fs.writeFileSync(demo + '/package.json', '{ "name": "demo" }\n')
  fs.writeFileSync(demo + '/.env', 'DEMO=1\n')
  fs.writeFileSync(demo + '/src/main_test.go', 'package src\n')
  fs.writeFileSync(demo + '/src/x.spec.ts', 'export const x = 1\n')
  fs.mkdirSync(demo + '/pkg')
  fs.writeFileSync(demo + '/pkg/x.spec.ts', 'export const y = 1\n')
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
  assert((await page.textContent(row('go.mod') + ' .tree-badge')) === 'A↑', 'added file, badge A↑')
  assert(await page.isVisible(row('src') + ' .tree-name.git-untracked'), 'folder of untracked files')

  // The two columns of git status: a change in the worktree (↓) or in the index (↑), #180.
  const git = (args) => execFileSync('git', args, { cwd: demo })
  const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')))
  // The pod refreshes the status after every change: a row can show one column before the
  // other lands, so the letter must hold for a moment before it counts.
  const badgeIs = async (name, want) => {
    const sel = row(name) + ' .tree-badge'
    for (let end = Date.now() + 12000; Date.now() < end; ) {
      await page.waitForFunction(([sel, want]) => document.querySelector(sel)?.textContent === want, [sel, want], { timeout: 12000 })
      await page.waitForTimeout(700)
      if ((await page.textContent(sel)) === want) return true
    }
    return false
  }
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'e2e'])
  fs.appendFileSync(demo + '/src/main.go', '// touched\n')
  await focus()
  await page.waitForSelector(row('src/main.go') + ' .tree-name.git-modified', { timeout: 10000 })
  assert(await badgeIs('src/main.go', 'M↓'), 'worktree change, blue name and badge M↓')
  git(['add', 'src/main.go'])
  fs.appendFileSync(demo + '/src/main.go', '// again\n')
  await focus()
  assert(await badgeIs('src/main.go', 'M↓↑'), 'staged and modified, badge M↓↑')
  fs.appendFileSync(demo + '/go.mod', '\n')
  git(['add', 'go.mod'])
  await focus()
  await page.waitForSelector(row('go.mod') + ' .tree-name.git-staged', { timeout: 10000 })
  assert(await badgeIs('go.mod', 'M↑'), 'staged only, its own shade and badge M↑')
  assert(await page.isVisible(row('src') + ' .tree-badge.git-modified'), 'folder badge colored like its state')
  assert(await badgeIs('src', 'M↓↑'), 'folder carries the letter of the strongest state below it')

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
  const label = async (name) => (await page.$eval(row(name) + ' .tree-label', (e) => e.textContent).catch(() => '')) || ''
  assert((await tint('gen')) === 'ignored' && (await tint('tests')) === 'test' && (await tint('src')) === 'marked', 'the row of a marked folder is tinted with its kind')
  assert((await label('tests')) === 'Test folder' && (await label('gen')) === 'Excluded folder', 'a label after the name of a marked folder')
  assert((await tint('build.log')) === 'ignored', 'a file ignored by .gitignore is tinted')
  assert(!(await page.$(row('notes.txt') + ' .tree-label')), 'a plain file has no label')

  // The built-in rules of the Files plugin (#182): tests, library roots, manifests, by name.
  assert((await tint('package.json')) === 'manifest' && (await tint('go.mod')) === 'manifest' && (await tint('.env')) === 'manifest', 'manifests and config files are tinted')
  assert(!(await label('package.json')), 'a manifest has no label')
  assert((await tint('src/main_test.go')) === 'test' && (await tint('src/x.spec.ts')) === 'test', 'a test file keeps its tint under a folder marked source (its own answer wins)')
  assert((await label('src/main_test.go')) === 'Source folder', 'a test file keeps no label of its own but the one of its folder')
  assert((await tint('node_modules')) === 'library' && (await label('node_modules')) === 'Library root', 'a library root is tinted and labelled')
  assert((await tint('src')) === 'marked' && (await tint('src/main.go')) === 'marked', 'a marked folder tints its content')
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

  // Expand all (not the excluded folder, not a library root), collapse all.
  await page.click('[data-testid=explorer-expand]')
  await page.waitForSelector(row('tests/app_test.go'))
  assert(!(await page.isVisible(row('gen/generated.go'))), 'expand all skips the excluded folder')
  assert(!(await page.isVisible(row('node_modules/dep.js'))), 'expand all skips a library root')
  await page.dblclick(row('node_modules'))
  await page.waitForSelector(row('node_modules/dep.js'))
  assert((await page.getAttribute(row('node_modules/dep.js'), 'data-tint')) === 'library', 'the content of a library root inherits its tint')
  assert((await label('node_modules/dep.js')) === 'Library root', 'and its label')
  // The tint and the label of a folder pass to its content (#179).
  assert((await page.getAttribute(row('tests/app_test.go'), 'data-tint')) === 'test', 'a file under a test folder keeps its tint, whatever its name')
  assert((await page.$eval(row('tests/app_test.go') + ' .tree-label', (e) => e.textContent).catch(() => '')) === 'Test folder', 'and its label')
  assert((await tint('pkg/x.spec.ts')) === 'test' && !(await label('pkg/x.spec.ts')), 'a test file in an unmarked folder is tinted by its name alone')
  // A selected tinted row keeps the background of the selection (#182: on a library root and a test).
  const keepsActive = async (name) => {
    await page.click(row(name))
    const bg = await page.evaluate((p) => {
      const row = document.querySelector(`.explorer .tree-row[data-path="${p}"]`)
      const probe = document.createElement('div')
      probe.style.background = getComputedStyle(document.documentElement).getPropertyValue('--bg-active').trim()
      document.body.append(probe)
      const active = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { row: getComputedStyle(row).backgroundColor, active, selected: row.classList.contains('selected') }
    }, demo + '/' + name)
    const rgb = (c) => c.replace(/\s+/g, '')
    assert(bg.selected && rgb(bg.row) === rgb(bg.active), `a selected tinted row keeps --bg-active (${name}): ${JSON.stringify(bg)}`)
  }
  await keepsActive('tests/app_test.go')
  await keepsActive('package.json')
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
    JSON.stringify(menu) === JSON.stringify(['Open in a window', 'Close', 'New file…', 'New folder…', 'Show the hidden files', 'Show the excluded folders', 'Open files with a single click', 'Always select the opened file', 'Row tints', 'Refresh all']),
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

  // Row tints: a submenu of the ⋮ with one switch per family of the built-in rules (#182).
  await page.dblclick(row('pkg'))
  await page.waitForSelector(row('pkg/x.spec.ts'))
  const openTints = async () => {
    await page.click('[data-tool=explorer] [data-testid=zone-menu]')
    await page.waitForSelector('.ctx-menu')
    await page.click('.ctx-menu .ctx-item:has-text("Row tints")')
    await page.waitForSelector('.ctx-menu.sub')
  }
  await openTints()
  const tintsMenu = await page.$$eval('.ctx-menu.sub .ctx-item .ctx-label', (els) => els.map((e) => e.textContent.trim()))
  assert(JSON.stringify(tintsMenu) === JSON.stringify(['Tests', 'Library roots', 'Manifests', 'Marked folders', 'Ignored files']), 'the items of the Row tints submenu: ' + JSON.stringify(tintsMenu))
  await page.click('.ctx-menu.sub .ctx-item:has-text("Tests")')
  await page.waitForSelector('.ctx-menu', { state: 'detached' })
  assert((await tint('pkg/x.spec.ts')) === '', 'unchecking Tests takes the tint off the test rows at once')
  assert((await tint('src/main_test.go')) === 'marked', 'such a row falls back to the mark of its folder')
  assert((await tint('package.json')) === 'manifest' && (await tint('node_modules')) === 'library', 'the other families keep their tint')
  // The switch is remembered in the desk.
  await page.waitForTimeout(800)
  await page.reload()
  await page.waitForSelector('.explorer .tree-row')
  assert((await tint('pkg/x.spec.ts')) === '', 'the test rows are still untinted after a reload')
  await openTints()
  assert(await page.isVisible('.ctx-menu.sub .ctx-item[aria-checked=false]:has-text("Tests")'), 'the Tests switch is still unchecked after a reload')
  // Keyboard: ArrowLeft closes the submenu only, ArrowRight opens it, Escape closes the menu.
  await page.keyboard.press('ArrowLeft')
  assert(!(await page.$('.ctx-menu.sub')) && !!(await page.$('.ctx-menu:not(.sub)')), 'ArrowLeft closes the submenu, the menu stays open')
  await page.keyboard.press('ArrowRight')
  await page.waitForSelector('.ctx-menu.sub')
  await page.keyboard.press('Escape')
  assert(!(await page.$('.ctx-menu.sub')) && !!(await page.$('.ctx-menu:not(.sub)')), 'Escape closes the submenu first')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.ctx-menu', { state: 'detached' })
  await openTints()
  await page.click('.ctx-menu.sub .ctx-item:has-text("Tests")')
  await page.waitForFunction(() => !!document.querySelector('.explorer .tree-row[data-tint=test]'))
  assert((await tint('pkg/x.spec.ts')) === 'test', 'checking Tests back tints the rows again')

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
