// The official language packs of PHP, Python and JavaScript/TypeScript (#149): installed as
// official plugins (their release archives, or E2E_PLUGIN_LANG_PHP…: local builds), their
// grammars highlight the files the core no longer knows; each server found on the PATH of the
// pod (intelephense or phpactor, pyright-langserver, basedpyright-langserver or pylsp,
// typescript-language-server) runs confined, from its npm or pip install, and its diagnostics
// reach Problems. A language whose server is not installed is said and skipped.
const fs = require('fs')
const path = require('path')
const { run, openProject, open, assert, installOfficial, WS } = require('../../../e2e/common.cjs')

const has = (p) => (process.env.PATH ?? '').split(':').some((d) => d && fs.existsSync(path.join(d, p)))
const files = [
  { name: 'broken.php', text: '<?php\nnamespace App;\n\nfunction f() {\n  $x = ;\n}\n', keyword: 'namespace', servers: ['intelephense', 'phpactor'] },
  { name: 'broken.py', text: 'def f(:\n    return lambda: 1\n', keyword: 'lambda', servers: ['pyright-langserver', 'basedpyright-langserver', 'pylsp'] },
  { name: 'broken.ts', text: "interface A { n: number }\nconst a: A = { n: 'x' }\nexport default a\n", keyword: 'interface', servers: ['typescript-language-server'] },
  { name: 'broken.js', text: 'function* g() {\n  yield 1\n}\nlet = ;\n', keyword: 'yield', servers: ['typescript-language-server'] },
]

run(async ({ page }) => {
  const locks = await installOfficial(['lang-php', 'lang-python', 'lang-typescript'])
  assert(Object.values(locks).every((l) => l?.official), 'the three packs installed, official: ' + Object.keys(locks).filter((k) => locks[k]).join(', '))
  assert(locks['lang-typescript'].grants.includes('program:typescript-language-server') && locks['lang-python'].grants.includes('path:NODE'), 'their grants: ' + JSON.stringify(locks['lang-typescript'].grants))

  const demo = WS + '/demo'
  for (const [f, t] of [['composer.json', '{}'], ['pyproject.toml', '[project]\nname = "demo"\n'], ['package.json', '{"name": "demo"}'], ['tsconfig.json', '{"compilerOptions": {"strict": true, "allowJs": true, "checkJs": true}}']])
    fs.writeFileSync(path.join(demo, f), t)
  for (const f of files) fs.writeFileSync(path.join(demo, f.name), f.text)
  // HTML hands the content of <style> and <script> to CSS and to the pack's JavaScript (#227).
  fs.writeFileSync(path.join(demo, 'page.html'), '<html>\n<style>\nbody { margin: 0 }\n</style>\n<script>\nconst t = `a\nb</script>\n<section id="after"></section>\n<script>yield</script>\n')
  await openProject(page)

  for (const f of files) {
    await open(page, f.name)
    // The pack's grammar: its keyword highlighted in the shown file.
    const colored = await page
      .waitForFunction((kw) => [...(CSS.highlights.get('tok-keyword') ?? [])].some((r) => r.startContainer.data?.slice(r.startOffset, r.endOffset) === kw), f.keyword, { timeout: 10000 })
      .then(() => true, () => false)
    assert(colored, `${f.name}: highlighted by its pack (${f.keyword})`)
  }

  await open(page, 'page.html')
  const tokens = (type) => page.evaluate((t) => [...(CSS.highlights.get('tok-' + t) ?? [])].map((r) => r.startContainer.data?.slice(r.startOffset, r.endOffset)), type)
  await page.waitForFunction(() => [...(CSS.highlights.get('tok-keyword') ?? [])].some((r) => r.startContainer.data?.slice(r.startOffset, r.endOffset) === 'const'), null, { timeout: 10000 }).catch(() => {})
  assert((await tokens('keyword')).includes('const') && (await tokens('property')).includes('margin'), 'page.html: the JavaScript of <script> and the CSS of <style> are highlighted')
  const tags = await tokens('tag')
  assert(tags.includes('</script>') && tags.some((x) => x?.startsWith('<section')), '</script> ends the block even inside a template string, the HTML after it is HTML: ' + JSON.stringify(tags))
  assert((await tokens('keyword')).includes('yield'), 'a second <script> is JavaScript again')

  if (!(await page.isVisible('[data-tool=problems]'))) await page.click('.rail-right .rail-btn[title^="Problems"]')
  await page.click('[data-tool=problems] .tab:has-text("Problems")')
  for (const f of files) {
    const server = f.servers.find(has)
    if (!server) {
      console.log(`  (${f.servers.join(', ')} not installed: no server for ${f.name})`)
      continue
    }
    await open(page, f.name)
    const listed = await page
      .waitForFunction((n) => document.querySelector('[data-tool=problems]')?.textContent.includes(n), f.name, { timeout: 60000 })
      .then(() => true, () => false)
    assert(listed, `${f.name}: ${server} runs confined, its diagnostics in Problems`)
  }
})
