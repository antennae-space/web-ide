// The view in focus kept in the desk (#201): a phone opening the project from the home page lands
// on the desk last used on the PC, on the view the PC had in focus; what the phone shows is
// followed live by the PC while the PC is not in use, never while it is.
const { run, openProject, assert, OUT } = require('../common.cjs')

const phoneView = (p) => p.getAttribute('[data-testid=mobile-rail] .rail-btn.active', 'data-id')
// Whether the window is in use, as the page reads it (headless pages all say they have the focus).
const inUse = (p, v) => p.evaluate((v) => (document.hasFocus = () => v), v)

run(async ({ page, browser }) => {
  await openProject(page)
  // The PC: desk 2, the assistant in focus.
  await page.click('[data-testid=desk-add]')
  await page.waitForFunction(() => location.pathname.endsWith('/desk/2'))
  await page.click('.rail-btn[data-id=assistant]')
  await page.waitForSelector('.zone.focused[data-tool=assistant]')
  await page.waitForTimeout(800)

  // The phone opens the project from the home page: desk 2, the assistant shown.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, locale: 'en-US' })
  const phone = await ctx.newPage()
  await phone.goto(`${process.env.E2E_URL}/?token=${process.env.E2E_TOKEN}`)
  await phone.waitForSelector('.project-open:has-text("demo")')
  await phone.waitForFunction(() => document.querySelector('.project-open')?.getAttribute('href')?.endsWith('/desk/2'))
  await phone.click('.project-open:has-text("demo")')
  await phone.waitForSelector('[data-testid=mobile-rail]')
  assert(new URL(phone.url()).pathname.endsWith('/desk/2'), 'the home page opens the desk last used on another device: ' + phone.url())
  await phone.waitForFunction(() => document.querySelector('[data-testid=mobile-rail] .rail-btn.active')?.getAttribute('data-id') === 'assistant')
  assert((await phoneView(phone)) === 'assistant', 'the phone shows the view the PC had in focus')
  await phone.screenshot({ path: OUT + '/deskfocus-phone.png' })

  // The phone shows Git: the PC, not in use, follows (a highlight: the keyboard stays where it was).
  await inUse(page, false)
  await inUse(phone, true)
  await phone.tap('[data-testid=mobile-rail] [data-id=git]')
  await page.waitForSelector('.zone.focused[data-tool=git]', { timeout: 5000 })
  assert(true, 'the PC not in use follows the view shown on the phone')

  // The PC in use is never moved.
  await inUse(page, true)
  await inUse(phone, true)
  await phone.tap('[data-testid=mobile-rail] [data-id=assistant]')
  await page.waitForTimeout(1200)
  assert(await page.$('.zone.focused[data-tool=git]'), 'a window in use keeps its focus')

  // Back to the PC: what it puts in focus reaches the phone, not in use.
  await inUse(phone, false)
  await page.click('.rail-btn[data-id=explorer]')
  await phone.waitForFunction(() => document.querySelector('[data-testid=mobile-rail] .rail-btn.active')?.getAttribute('data-id') === 'explorer', null, { timeout: 5000 })
  assert(true, 'the phone not in use follows the PC')
  await ctx.close()
})
