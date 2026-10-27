// Code navigation with gopls through the language pack lang-go (#146), its server confined
// (skipped when gopls is not installed).
const { execSync } = require('child_process')
const { run, openProject, open, assert, text, installOfficial, OUT } = require('../../../e2e/common.cjs')
try {
  execSync('command -v gopls', { env: { ...process.env, PATH: process.env.HOME + '/go/bin:' + process.env.PATH }, stdio: 'ignore' })
} catch {
  console.log('  (gopls not installed: suite skipped)')
  process.exit(0)
}
run(async ({ page }) => {
  const lock = await installOfficial('lang-go')
  assert(lock?.grants.join() === 'program:gopls,path:GOROOT,path:GOMODCACHE', 'lang-go installed with its grants: ' + JSON.stringify(lock))
  await openProject(page)
  await open(page, 'main.go')
  const caretOn = async (needle, delta = 1) => {
    await page.evaluate(([needle, delta]) => {
      const pre = document.querySelector('.pane.active .ed-content')
      pre.focus()
      for (const block of pre.children) {
        const node = block.firstChild
        const i = node.data.indexOf(needle)
        if (i >= 0) { getSelection().setBaseAndExtent(node, i + delta, node, i + delta); break }
      }
    }, [needle, delta])
    await page.waitForTimeout(100)
  }
  const line = () => page.textContent('[data-testid=status-cursor]')
  // gopls starts cold (module loading): Ctrl+B is retried until it answers.
  let jumped = false
  for (let i = 0; i < 20 && !jumped; i++) {
    await caretOn('.Hello())', 2)
    await page.keyboard.press('Control+b')
    jumped = await page.waitForFunction(() => document.querySelector('[data-testid=status-cursor]')?.textContent.startsWith('8:'), null, { timeout: 1500 }).then(() => true, () => false)
  }
  assert(jumped, 'Ctrl+B goes to the declaration (line 8): ' + (await line()))
  // On the declaration: the usages (a single one: jump to it).
  await page.keyboard.press('Control+b')
  const usages = await page.waitForFunction(() => document.querySelector('[data-testid=status-cursor]')?.textContent.startsWith('13:') || document.querySelector('.pick'), null, { timeout: 8000 }).then(() => true, () => false)
  assert(usages, 'Ctrl+B on the declaration shows the usages')
  await page.keyboard.press('Escape')
  await page.click('.rail-right .rail-btn[title="Structure"]')
  const syms = await page
    .waitForFunction(() => {
      const names = [...document.querySelectorAll('.side-right .tree-row .tree-name')].map((x) => x.textContent)
      return names.includes('Greeter') && names.some((n) => n.includes('Hello')) && names
    }, null, { timeout: 8000 })
    .then((h) => h.jsonValue(), () => [])
  assert(syms.length > 0, 'the structure lists the symbols ' + JSON.stringify(syms))
  // The VS Code look: the glyph in a colored disc, the twisty, the folding, the sort, the clicks.
  const row = (name) => `.side-right .tree-row:has(.tree-name:text-is("${name}"))`
  const names = () => page.$$eval('.side-right .tree-row .tree-name', (e) => e.map((x) => x.textContent))
  const glyph = await page.$eval(row('Greeter') + ' .sym-glyph', (e) => ({
    text: e.textContent,
    color: getComputedStyle(e).color,
    bg: getComputedStyle(e).backgroundColor,
  }))
  assert(/[A-Za-z]/.test(glyph.text) && glyph.bg !== 'rgba(0, 0, 0, 0)', 'the glyph of Greeter sits in a colored disc: ' + JSON.stringify(glyph))
  assert(!!(await page.$(row('Greeter') + ' .tree-twist.open')), 'Greeter has a twisty')
  await page.click(row('Greeter') + ' .tree-twist')
  await page.waitForTimeout(300)
  assert(!(await names()).includes('Name'), 'the twisty folds the field under Greeter: ' + JSON.stringify(await names()))
  await page.click('[data-testid=structure-expand]')
  await page.waitForTimeout(300)
  assert((await names()).includes('Name'), 'Expand all brings the field back')
  await page.click(row('Greeter') + ' .tree-twist')
  await page.waitForTimeout(300)
  await open(page, 'go.mod')
  await open(page, 'main.go')
  await page.waitForFunction(() => [...document.querySelectorAll('.side-right .tree-row .tree-name')].some((x) => x.textContent === 'Greeter'), null, { timeout: 8000 })
  assert(!(await names()).includes('Name'), 'the fold of main.go survives a switch to another file: ' + JSON.stringify(await names()))
  await page.click('[data-testid=structure-collapse]')
  await page.waitForTimeout(300)
  assert(!(await names()).includes('Name'), 'Collapse all folds every symbol with children')
  await page.click('[data-testid=structure-options]')
  await page.waitForSelector('.ctx-menu')
  assert(await page.$('.ctx-item:disabled'), 'the menu holds the entries that come later, disabled')
  await page.click('.ctx-item:has-text("Sort alphabetically")')
  await page.click('[data-testid=structure-expand]')
  await page.waitForTimeout(400)
  const sorted = await names()
  const at = (n) => sorted.indexOf(n)
  assert(at('Name') === at('Greeter') + 1 && at('Greeter') < at('main'), 'the alphabetical sort reorders the file but keeps Name under Greeter: ' + JSON.stringify(sorted))
  await page.click(row('(Greeter).Hello'))
  assert(!!(await page.$('.tree-row.selected:has(.tree-name:text-is("(Greeter).Hello"))')), 'one click selects the row')
  await page.dblclick(row('(Greeter).Hello'))
  await page.waitForFunction(() => document.querySelector('[data-testid=status-cursor]')?.textContent.startsWith('8:'), null, { timeout: 5000 }).catch(() => {})
  assert((await line()).startsWith('8:'), 'a double click jumps to the symbol: ' + (await line()))
  // Diagnostics
  await page.click('.pane.active .ed-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nfunc broken() { return 1 }\n')
  const diag = await page
    .waitForFunction(() => CSS.highlights.get('diag-error')?.size, null, { timeout: 10000 })
    .then((h) => h.jsonValue(), () => 0)
  assert(diag > 0, `diagnostic underlined in the editor (${diag})`)
  if (!(await page.isVisible('[data-tool=problems]'))) await page.click('.rail-right .rail-btn[title="Problems"]')
  await page.click('[data-tool=problems] .tab:has-text("Problems")')
  await page.waitForTimeout(300)
  assert((await page.$$('.problem')).length > 0, 'the Problems panel lists the diagnostic')
  await page.screenshot({ path: OUT + '/lsp.png' })
  // Remove the broken function again.
  await page.click('.pane.active .ed-content')
  for (let i = 0; i < 3 && (await text(page)).includes('broken'); i++) await page.keyboard.press('Control+z')
  assert(!(await text(page)).includes('broken'), 'undo removes the broken function')

  // Completion after a trigger character, filtered while typing.
  await caretOn('.Hello())', 9)
  await page.keyboard.press('Enter')
  await page.keyboard.type('fmt.Pri')
  const shown = await page.waitForSelector('.completion-item', { timeout: 10000 }).then(() => true, () => false)
  if (!shown) {
    await page.screenshot({ path: OUT + '/nocompletion.png' })
    console.log('     texte : ' + JSON.stringify((await text(page)).slice(150, 330)))
    console.log('     toasts : ' + (await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' | '))))
  }
  assert(shown, 'the completion list shows up')
  const labels = await page.$$eval('.completion-item .completion-label', (e) => e.map((x) => x.textContent))
  assert(labels[0]?.startsWith('Print'), 'filtered on "Pri": ' + labels.slice(0, 4).join(', '))
  await page.keyboard.type('ntl')
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  const accepted = await text(page)
  assert(accepted.match(/\n\tfmt\.Println\b/g)?.length === 2, 'Enter inserts the suggestion ' + JSON.stringify(accepted.slice(180, 300)))
  assert(!(await page.isVisible('.completion')), 'the list closes')
  await page.screenshot({ path: OUT + '/completion.png' })
  await page.keyboard.type('("ok")')
  await page.keyboard.press('Enter')

  // Unimported package: the completion adds the import.
  await page.keyboard.type('strings.ToUpp')
  // The first completion of an unimported package indexes the standard library: retried.
  for (let i = 0; i < 15 && !(await page.$('.completion-item:has-text("ToUpper")')); i++) {
    await page.waitForTimeout(1500)
    if (!(await page.$('.completion-item'))) await page.keyboard.press('Control+Space')
  }
  await page.waitForTimeout(200)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  const withImport = await text(page)
  assert(/strings\.ToUpper/.test(withImport), 'strings.ToUpper completed ' + JSON.stringify(withImport.slice(0, 40) + ' … ' + withImport.slice(180, 320)))
  assert(/import \(\s*"fmt"\s*"strings"\s*\)|"strings"/.test(withImport), 'the import of strings is added')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(200)
  assert(!(await text(page)).includes('"strings"'), 'a single undo removes the completion and the import')
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press('Delete')

  // Ctrl+Space
  await page.keyboard.type('Gree')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Space')
  const manual = await page.waitForSelector('.completion-item:has-text("Greeter")', { timeout: 8000 }).then(() => true, () => false)
  assert(manual, 'Ctrl+Space suggests Greeter')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Backspace')

  // Rename (Shift+F6) across the file.
  await caretOn('type Greeter', 6)
  await page.keyboard.press('Shift+F6')
  await page.waitForSelector('.modal input')
  assert((await page.inputValue('.modal input')) === 'Greeter', 'current name suggested')
  await page.fill('.modal input', 'Saluteur')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.pane.active .ed-content').textContent.includes('Saluteur'), null, { timeout: 8000 }).catch(() => {})
  const renamed = await text(page)
  assert(!renamed.includes('Greeter') && (renamed.match(/Saluteur/g) ?? []).length >= 3, 'all occurrences renamed')

  // Formatting (Ctrl+Alt+L): gofmt fixes the indentation.
  await caretOn('return fmt.Sprintf', 0)
  await page.keyboard.press('Home')
  await page.keyboard.type('      ')
  await page.keyboard.press('Control+Alt+l')
  await page.waitForFunction(() => /\n\treturn fmt\.Sprintf/.test(document.querySelector('.pane.active .ed-content').textContent), null, { timeout: 8000 }).catch(() => {})
  assert(/\n\treturn fmt\.Sprintf/.test(await text(page)), 'gofmt puts the tab back')
})
