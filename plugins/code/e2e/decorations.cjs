// Editor decorations given by a plugin (editorDecorations, #187): the Hello plugin (test plugin,
// WEBIDE_TEST_PLUGINS) decorates deco.txt with a mark in the gutter, a class on a line, a widget
// at the end of a line, a hover, a click and menu items. The marks follow the edits, and a file
// no plugin decorates keeps its gutter.
const fs = require('fs')
const { run, openProject, open, assert, WS, OUT, openMenu } = require('../../../e2e/common.cjs')

run(async ({ page }) => {
  fs.writeFileSync(WS + '/demo/deco.txt', 'one\ntwo\nthree\nfour\nfive\n')
  fs.writeFileSync(WS + '/demo/plain.txt', 'alpha\nbeta\ngamma\n')
  await openProject(page)
  await open(page, 'deco.txt')

  // Client top of each line box (the view places its own elements there), and the elements it drew.
  const tops = () =>
    page.evaluate(() => {
      const pane = document.querySelector('.pane.active')
      const cs = getComputedStyle(pane.querySelector('.ed-content'))
      const lh = parseFloat(cs.lineHeight)
      const base = pane.querySelector('.ed-content').getBoundingClientRect().top + (parseFloat(cs.paddingTop) || 0)
      const count = [...pane.querySelectorAll('.ed-block')].reduce((n, e) => n + e.firstChild.data.split('\n').length - 1, 0)
      const lines = []
      for (let l = 0; l < count; l++) lines.push(base + l * lh)
      const q = (s) => [...pane.querySelectorAll(s)].map((e) => ({ id: e.dataset.deco || e.dataset.lineclass || e.dataset.widget, top: e.getBoundingClientRect().top, title: e.title || '', text: e.textContent || '' }))
      return { lines, decos: q('.ed-deco'), classes: q('.ed-lineclass'), widgets: q('.ed-widget'), lh: parseFloat(getComputedStyle(pane.querySelector('.ed-content')).lineHeight) }
    })

  const at = (list, line) => list.find((x) => Math.abs(x.top - topsCache.lines[line]) < 2)
  let topsCache = await tops()
  const deco = topsCache.decos.find((d) => d.id === 'hello:m1')
  const klass = topsCache.classes.find((c) => c.id === 'hello:ln')
  const widget = topsCache.widgets.find((w) => w.id === 'hello:w')
  assert(!!deco && !!at(topsCache.decos, 1), 'the plugin mark shows on its line (line 1)')
  assert(!!klass && !!at(topsCache.classes, 2), 'the plugin class covers its line (line 2)')
  assert(!!widget && !!at(topsCache.widgets, 1) && widget.text.includes('deco'), 'the plugin widget sits at the end of its line: ' + (widget && widget.text))
  await page.screenshot({ path: OUT + '/decorations-shown.png' })

  // A file no plugin decorates keeps its gutter as it was.
  await open(page, 'plain.txt')
  const plainW = await page.$eval('.pane.active .ed-gutter', (e) => e.getBoundingClientRect().width)
  assert((await page.$$eval('.pane.active .ed-deco', (l) => l.length)) === 0, 'no decoration lane for a file no plugin decorates')
  await open(page, 'deco.txt')
  const decoW = await page.$eval('.pane.active .ed-gutter', (e) => e.getBoundingClientRect().width)
  assert(decoW === plainW + 16, `the lane widens the gutter of the decorated file only (${plainW} → ${decoW})`)

  // A click in the lane puts a mark on the line clicked, and takes it back (gutterClick).
  const lane = await page.$eval('.pane.active .ed-decos', (e) => {
    const r = e.getBoundingClientRect()
    return { x: r.left + r.width / 2 }
  })
  topsCache = await tops()
  const clickLine = async (line) => {
    await page.mouse.click(lane.x, topsCache.lines[line] + topsCache.lh / 2)
    await page.waitForTimeout(250)
    return (await page.$$eval('.pane.active .ed-deco', (l) => l.map((e) => e.dataset.deco))).length
  }
  const removed = await clickLine(1)
  assert(removed === 0, 'a click on a marked line takes the mark back (' + removed + ' mark)')
  await clickLine(1)
  const added = await clickLine(3)
  topsCache = await tops()
  assert(added === 2 && !!at(topsCache.decos, 3), 'a click on an empty line of the lane adds a mark there (' + added + ' marks)')
  await clickLine(3)
  topsCache = await tops()
  assert(!!at(topsCache.decos, 1) && topsCache.decos.length === 1, 'the mark of the line is back after a second click')
  const kept = at(topsCache.decos, 1).id

  // The marks follow the edits: a line inserted above moves them down, and the plugin is told.
  await page.click('.pane.active .ed-content')
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  topsCache = await tops()
  const moved = topsCache.decos.find((d) => d.id === kept)
  assert(!!moved && !!at(topsCache.decos, 2), 'the mark moved down with its line')
  assert(/moved to 2/.test(moved.title), 'the plugin was told of the move: ' + moved.title)
  const movedWidget = topsCache.widgets.find((w) => w.id === 'hello:w')
  assert(!!movedWidget && !!at(topsCache.widgets, 2), 'the widget moved down too')
  await page.screenshot({ path: OUT + '/decorations-moved.png' })

  // Deleting the line of a mark reports it removed, and the mark goes.
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(400)
  const still = await page.$$eval('.pane.active .ed-deco', (l) => l.map((e) => e.dataset.deco))
  assert(!still.includes(kept), 'the mark of a deleted line is gone: ' + JSON.stringify(still))
  topsCache = await tops()
  assert(!topsCache.widgets.some((w) => w.id === 'hello:w'), 'the widget of the deleted line is gone too')

  // Hover: the plugin answers for an offset of the text.
  topsCache = await tops()
  await page.mouse.move(await page.$eval('.pane.active .ed-content', (e) => e.getBoundingClientRect().left + 30), topsCache.lines[1] + topsCache.lh / 2)
  await page.waitForTimeout(600)
  await page.waitForSelector('[data-testid=editor-hover]', { timeout: 3000 })
  const hoverText = await page.$eval('[data-testid=editor-hover]', (e) => e.textContent.trim())
  assert(/deco hover at line 2/.test(hoverText), 'the hover of the plugin shows: ' + hoverText)
  await page.screenshot({ path: OUT + '/decorations-hover.png' })
  await page.mouse.move(10, 10)
  await page.waitForSelector('[data-testid=editor-hover]', { state: 'detached', timeout: 3000 })
  assert(true, 'a move of the mouse closes the hover')

  // The menu of the lane, and the items the plugin adds to the menu of the text.
  topsCache = await tops()
  await page.mouse.click(lane.x, topsCache.lines[1] + topsCache.lh / 2, { button: 'right' })
  await page.waitForSelector('.ctx-menu')
  let items = await page.$$eval('.ctx-menu .ctx-item .ctx-label', (l) => l.map((e) => e.textContent.trim()))
  assert(items.includes('Clear the deco marks'), 'the lane menu holds the item of the plugin: ' + JSON.stringify(items))
  await page.keyboard.press('Escape')
  await page.waitForSelector('.ctx-menu', { state: 'detached' })

  await page.click('.pane.active .ed-content')
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  const box = await page.$eval('.pane.active .ed-content', (e) => {
    const r = e.getBoundingClientRect()
    return { x: r.left + 40, y: r.top + 34 }
  })
  await page.mouse.click(box.x, box.y, { button: 'right' })
  await page.waitForSelector('.ctx-menu')
  items = await page.$$eval('.ctx-menu .ctx-item .ctx-label', (l) => l.map((e) => e.textContent.trim()))
  assert(items.includes('Deco: mark the caret line'), 'the menu of the text holds the item of the plugin: ' + JSON.stringify(items))
  await page.click('.ctx-item:has-text("Deco: mark the caret line")')
  await page.waitForTimeout(300)
  topsCache = await tops()
  assert(!!at(topsCache.decos, 1), 'the item of the plugin added a mark on the caret line')

  // Soft wrap: a long line above takes several rows, and the mark stays on its own line.
  await page.keyboard.press('Control+Home')
  await page.keyboard.type('long ' + 'x'.repeat(300))
  await page.waitForTimeout(200)
  await openMenu(page, 'View')
  await page.click('.ctx-menu .ctx-item:has-text("Wrap the long lines")')
  await page.waitForFunction(() => document.querySelector('.pane.active .ed').classList.contains('wrap'))
  await page.waitForTimeout(400)
  const wrapped = await page.evaluate(() => {
    const pane = document.querySelector('.pane.active')
    const glyph = (line) => {
      let rest = line
      for (const el of pane.querySelectorAll('.ed-block')) {
        const parts = el.firstChild.data.split('\n')
        if (rest + 1 < parts.length) {
          let off = 0
          for (let i = 0; i < rest; i++) off += parts[i].length + 1
          const r = document.createRange()
          r.setStart(el.firstChild, off)
          r.setEnd(el.firstChild, off + 1)
          return r.getBoundingClientRect().top
        }
        rest -= parts.length - 1
      }
      return NaN
    }
    return [...pane.querySelectorAll('.ed-deco')].map((e) => ({
      line: Number(e.dataset.line),
      top: e.getBoundingClientRect().top,
      h: e.offsetHeight,
      glyph: glyph(Number(e.dataset.line)),
    }))
  })
  const on = wrapped.filter((d) => d.top <= d.glyph + 1 && d.top + d.h >= d.glyph)
  assert(wrapped.length > 0 && on.length === wrapped.length, 'with soft wrap, every mark still sits on its line: ' + JSON.stringify(wrapped))
  await page.screenshot({ path: OUT + '/decorations-wrap.png' })
})
