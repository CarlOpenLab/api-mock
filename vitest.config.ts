import { defineConfig } from 'vitest/config'

// 单测只覆盖纯逻辑（匹配、合并、改写决策）—— 这些模块不 import 任何 chrome API，
// 所以不需要浏览器环境。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
