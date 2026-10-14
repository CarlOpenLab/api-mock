/** 同时跑两条构建流水线：Vite（面板 + background）和 esbuild（content script）。 */

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const viteBin = resolve(root, 'node_modules/.bin', isWindows ? 'vite.cmd' : 'vite')

const children = [
  spawn(viteBin, ['build', '--watch'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, ['scripts/build-content.mjs', '--watch'], {
    cwd: root,
    stdio: 'inherit',
  }),
]

function shutdown() {
  for (const child of children) child.kill()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
