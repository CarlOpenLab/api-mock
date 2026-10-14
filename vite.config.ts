import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = import.meta.dirname

// 只构建「能用 ES module / 需要打包分块」的产物：
//   devtools.html  注册面板
//   panel.html     面板 UI（React）
//   background.js  MV3 service worker
//
// content script 必须是经典脚本（IIFE），不能有 import，
// 所以 inject / bridge 走 scripts/build-content.mjs 里的独立 esbuild 构建。
export default defineConfig({
  root: resolve(root, 'src'),
  publicDir: resolve(root, 'public'),
  // 扩展页面里 / 本来就指向扩展根，绝对路径也能跑；用相对路径是为了让
  // 产物自己说得清文件在哪，排查时不用在脑子里做路径映射。
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'chrome111',
    rollupOptions: {
      input: {
        devtools: resolve(root, 'src/devtools/devtools.html'),
        panel: resolve(root, 'src/devtools/panel.html'),
        background: resolve(root, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
