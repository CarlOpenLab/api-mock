/**
 * content script 单独用 esbuild 构建。
 *
 * 原因是硬的：manifest 里声明的 content script 是经典脚本，**不能是 ES module**，
 * 所以不能用 Vite 那套（Vite 输出 ESM + 公共 chunk，content script 加载不了）。
 * 每个入口单独打成自包含的 IIFE，rollup 的 code-splitting 在这里反而用不上。
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')

const ENTRIES = [
  ['src/content/inject.ts', 'dist/content/inject.js'],
  ['src/content/bridge.ts', 'dist/content/bridge.js'],
]

function optionsFor(entry, outfile) {
  return {
    entryPoints: [resolve(root, entry)],
    outfile: resolve(root, outfile),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome111',
    legalComments: 'none',
    logLevel: 'warning',
  }
}

for (const [entry, outfile] of ENTRIES) {
  if (watch) {
    const context = await esbuild.context(optionsFor(entry, outfile))
    await context.watch()
    console.log(`[content] watching ${entry}`)
  } else {
    await esbuild.build(optionsFor(entry, outfile))
    console.log(`[content] ${entry} → ${outfile}`)
  }
}

if (!watch) {
  console.log('[content] done')
}
