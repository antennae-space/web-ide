// Precompresses the front end built by Vite (pod/webdist/dist): a .br and a .gz next to each text
// asset over 1 KB, embedded in the pod with the rest. serveStatic picks the variant the browser
// accepts; the Service Worker of the relay decodes what came through the tunnel (#207). A variant
// not 10 % smaller than its file is not written. index.html is left out: the pod rewrites it on
// every request.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const dist = new URL('../../pod/webdist/dist/', import.meta.url).pathname
const text = /\.(js|mjs|css|html|svg|json|webmanifest|wasm|map|txt)$/
// Brotli at quality 11 takes half a minute on the 26 MB speech runtime, for 15 % less than 9.
const BIG = 4 * 1024 * 1024

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p)
    else yield p
  }
}

let raw = 0
let br = 0
let gz = 0
for (const p of files(dist)) {
  if (!text.test(p) || p === join(dist, 'index.html')) continue
  const data = readFileSync(p)
  if (data.length <= 1024) continue
  const variants = {
    br: brotliCompressSync(data, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: data.length > BIG ? 9 : 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    }),
    gz: gzipSync(data, { level: 9 }),
  }
  raw += data.length
  for (const [ext, out] of Object.entries(variants)) {
    if (out.length > data.length * 0.9) continue
    writeFileSync(`${p}.${ext}`, out)
    if (ext === 'br') br += out.length
    else gz += out.length
  }
}
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB'
console.log(`compress: ${mb(raw)} of text assets, ${mb(br)} brotli, ${mb(gz)} gzip`)
