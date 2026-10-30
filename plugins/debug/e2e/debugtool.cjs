// The Debug tool (#189) on Go: a click in the gutter sets a line breakpoint (kept in
// .ide/breakpoints.json), Run › Debug… offers the templates of the pack while .ide/debug.json is
// empty, then starts a configuration; the tool opens focused on the stop with the execution line,
// a frame opens its line, a struct variable expands, F8 steps over, the console evaluates in the
// frame, Stop ends the session and closes the tool; the breakpoint follows an edit and is saved
// with the file. Skipped when dlv is not installed.
const fs = require('fs')
const path = require('path')
const { run, openProject, open, assert, WS, OUT } = require('../../../e2e/common.cjs')
const { hasDlv, installLangGo } = require('./lib/langgo.cjs')

if (!hasDlv()) {
  console.log('  (dlv not installed: suite skipped)')
  process.exit(0)
}

const FIXTURE = `package main

import "fmt"

type point struct {
	X, Y int
	Name string
}

func greet(name string) string {
	p := point{X: 1, Y: 2, Name: name}
	greeting := "hello " + name
	fmt.Println(p.Name)
	return greeting
}

func main() {
	fmt.Println(greet("monde"))
}
`
const BREAK_LINE = 12 // greeting := …, p is set
const NO_CODE_LINE = 2 // a blank line
const FILE = 'debug/dbgmain.go'

run(async ({ page }) => {
  const lock = await installLangGo()
  assert(lock?.grants.includes('debugger:go'), 'lang-go installed with its adapter granted')
  const demo = path.join(WS, 'demo')
  fs.mkdirSync(path.join(demo, 'debug'), { recursive: true })
  fs.writeFileSync(path.join(demo, FILE), FIXTURE)
  fs.rmSync(path.join(demo, '.ide', 'debug.json'), { force: true })
  await openProject(page)
  await open(page, 'dbgmain.go')

  // The lane of the gutter: a Go file takes breakpoints.
  await page.waitForSelector('.pane.active .ed-decos')
  const lines = () =>
    page.evaluate(() => {
      const pane = document.querySelector('.pane.active')
      const c = pane.querySelector('.ed-content')
      const cs = getComputedStyle(c)
      const lh = parseFloat(cs.lineHeight)
      const top = c.getBoundingClientRect().top + (parseFloat(cs.paddingTop) || 0)
      const lane = pane.querySelector('.ed-decos').getBoundingClientRect()
      return { lh, top, x: lane.left + lane.width / 2 }
    })
  const g = await lines()
  await page.mouse.click(g.x, g.top + (BREAK_LINE - 1) * g.lh + g.lh / 2)
  await page.waitForSelector(`.pane.active .ed-deco[data-deco="debug:bp${BREAK_LINE}"]`)
  const bpFile = path.join(demo, '.ide', 'breakpoints.json')
  const readBps = () => (fs.existsSync(bpFile) ? JSON.parse(fs.readFileSync(bpFile, 'utf8')).files[FILE] ?? [] : [])
  for (let i = 0; i < 20 && !readBps().length; i++) await page.waitForTimeout(100)
  assert(readBps()[0]?.line === BREAK_LINE, 'a click in the gutter sets a breakpoint, saved in .ide/breakpoints.json: ' + JSON.stringify(readBps()))

  // A breakpoint on a line with no code: the adapter will not set it.
  await page.mouse.click(g.x, g.top + (NO_CODE_LINE - 1) * g.lh + g.lh / 2)
  await page.waitForSelector(`.pane.active .ed-deco[data-deco="debug:bp${NO_CODE_LINE}"]`)

  // Run › Debug… with no configuration: the templates of the pack.
  await page.click('.menubar .menu-btn:has-text("Run")')
  await page.click('.ctx-item:has-text("Debug…")')
  await page.waitForSelector('.pick .pick-item')
  const offered = await page.$$eval('.pick .pick-item', (l) => l.map((e) => e.textContent))
  assert(offered.some((x) => x.includes('Launch the package')) && offered.some((x) => x.includes('Edit configurations')), 'an empty debug.json offers the templates of the pack: ' + JSON.stringify(offered))
  await page.keyboard.press('Escape')

  // A configuration, started with Shift+F9.
  fs.mkdirSync(path.join(demo, '.ide'), { recursive: true })
  fs.writeFileSync(path.join(demo, '.ide', 'debug.json'), JSON.stringify({ configurations: [{ name: 'Debug dbg', type: 'go', request: 'launch', program: '${workspaceFolder}/debug' }] }, null, 2))
  await page.click('.pane.active .ed-content')
  await page.keyboard.press('Shift+F9')
  await page.waitForSelector('.pick .pick-item:has-text("Debug dbg")')
  await page.click('.pick .pick-item:has-text("Debug dbg")')

  // The stop: the tool opens with the focus, the editor shows the line.
  await page.waitForSelector('[data-testid="debug-status"]:has-text("Paused")', { timeout: 60000 })
  await page.waitForFunction(() => document.activeElement?.closest('[data-testid="debug-tool"]'), null, { timeout: 5000 })
  assert(true, 'the Debug tool opens on the stop and takes the focus')
  await page.waitForSelector('.pane.active .ed-lineclass[data-lineclass="debug:exec"]')
  const execAt = () =>
    page.evaluate(() => {
      const pane = document.querySelector('.pane.active')
      const c = pane.querySelector('.ed-content')
      const lh = parseFloat(getComputedStyle(c).lineHeight)
      const top = c.getBoundingClientRect().top + (parseFloat(getComputedStyle(c).paddingTop) || 0)
      const e = pane.querySelector('.ed-lineclass[data-lineclass="debug:exec"]')
      return e ? Math.round((e.getBoundingClientRect().top - top) / lh) + 1 : 0
    })
  assert((await execAt()) === BREAK_LINE, `the execution line is highlighted at ${BREAK_LINE}: ${await execAt()}`)
  assert((await page.textContent('.pane.active .tab.active')).includes('dbgmain.go'), 'the editor shows the file of the stop')
  await page.screenshot({ path: OUT + '/debugtool-stopped.png' })

  // The breakpoint the adapter could not set is crossed out, with its reason; then taken back.
  const bad = await page.$(`.pane.active .ed-deco.dbg-bp-bad[data-deco="debug:bp${NO_CODE_LINE}"]`)
  assert(!!bad && /could not set/.test((await bad.getAttribute('title')) || ''), 'a breakpoint the debugger could not set is crossed out: ' + (bad && (await bad.getAttribute('title'))))
  assert(!(await page.$(`.pane.active .ed-deco.dbg-bp-bad[data-deco="debug:bp${BREAK_LINE}"]`)), 'the breakpoint it set is not')
  const g2 = await lines()
  await page.mouse.click(g2.x, g2.top + (NO_CODE_LINE - 1) * g2.lh + g2.lh / 2)
  await page.waitForSelector(`.pane.active .ed-deco[data-deco="debug:bp${NO_CODE_LINE}"]`, { state: 'detached' })

  // The frames: the top one is greet; a click on main opens its line in another tint.
  const frames = await page.$$eval('[data-testid="debug-frame"]', (l) => l.map((e) => e.textContent))
  assert(frames[0]?.includes('main.greet') && frames.some((f) => f.includes('main.main')), 'the frames of the paused thread: ' + JSON.stringify(frames))
  await page.click('[data-testid="debug-frame"]:has-text("main.main")')
  await page.waitForSelector('.pane.active .ed-lineclass[data-lineclass="debug:frame"]')
  assert(true, 'a click on a frame shows its line')
  await page.click('[data-testid="debug-frame"]:has-text("main.greet")')

  // The variables: a struct expands on demand.
  await page.waitForSelector('[data-testid="debug-var"][data-name="p"]')
  assert(!(await page.$('[data-testid="debug-var"][data-name="X"]')), 'the fields of a struct wait for its row to open')
  await page.click('[data-testid="debug-var"][data-name="p"]')
  await page.waitForSelector('[data-testid="debug-var"][data-name="X"]')
  const x = await page.textContent('[data-testid="debug-var"][data-name="X"]')
  assert(/X\s*=\s*\{int\}\s*1/.test(x), 'a field shows as name = {type} value: ' + x)

  // F8 steps over: the execution line moves down.
  await page.keyboard.press('F8')
  for (let i = 0; i < 50 && (await execAt()) !== BREAK_LINE + 1; i++) await page.waitForTimeout(100)
  assert((await execAt()) === BREAK_LINE + 1, `F8 steps over to line ${BREAK_LINE + 1}: ${await execAt()}`)

  // The console evaluates in the frame.
  await page.click('[data-testid="debug-tab-console"]')
  await page.fill('[data-testid="debug-repl"]', 'greeting')
  await page.press('[data-testid="debug-repl"]', 'Enter')
  await page.waitForFunction(() => document.querySelector('[data-testid="debug-output"]')?.textContent.includes('hello monde'))
  assert(true, 'the console evaluates in the selected frame')
  await page.screenshot({ path: OUT + '/debugtool-console.png' })

  // Stop: the session ends and the tool closes.
  await page.click('[data-testid="debug-stop"]')
  await page.waitForSelector('[data-testid="debug-tool"]', { state: 'detached', timeout: 10000 })
  const gone = await page.waitForSelector('.pane.active .ed-lineclass[data-lineclass="debug:exec"]', { state: 'detached', timeout: 3000 }).then(() => true, () => false)
  assert(gone, 'the execution line goes with the session')

  // The breakpoint follows an edit and is saved with the file.
  await page.click('.pane.active .ed-content')
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Enter')
  await page.waitForSelector(`.pane.active .ed-deco[data-deco="debug:bp${BREAK_LINE + 1}"]`)
  assert(readBps()[0]?.line === BREAK_LINE, 'the moved line waits for the save')
  await page.keyboard.press('Control+s')
  for (let i = 0; i < 30 && readBps()[0]?.line !== BREAK_LINE + 1; i++) await page.waitForTimeout(100)
  assert(readBps()[0]?.line === BREAK_LINE + 1, 'saved with the file at its new line: ' + JSON.stringify(readBps()))
})
