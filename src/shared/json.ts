/** JSON 深合并与解析工具。纯函数，便于单测。 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把 patch 深合并到 target 上。
 *
 * 语义选择（这些决定规则好不好用）：
 *   - 数组整体替换，不做逐项合并 —— 想追加一条数组元素应该是显式写全，
 *     否则下标对齐关系会让结果不可预测。
 *   - null 是有效值，直接覆盖。
 *   - 类型不同时 patch 获胜。
 */
export function deepMerge(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch
  if (!isPlainObject(target)) return patch

  const out: Record<string, unknown> = { ...target }
  for (const key of Object.keys(patch)) {
    out[key] = deepMerge(target[key], patch[key])
  }
  return out
}

export type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

export function parseJson(text: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 把真实响应体按 patch 合并。任一侧不是合法 JSON 时退化为「直接用 patch 文本」，
 * 因为对着非 JSON 响应谈合并没有意义。
 */
export function mergeJsonText(realText: string, patchText: string): string {
  const patch = parseJson(patchText)
  if (!patch.ok) return patchText

  const real = parseJson(realText)
  if (!real.ok) return patchText

  return JSON.stringify(deepMerge(real.value, patch.value), null, 2)
}

/** 格式化 JSON；失败返回 null，让调用方保留原文。 */
export function formatJson(text: string): string | null {
  const parsed = parseJson(text)
  if (!parsed.ok) return null
  return JSON.stringify(parsed.value, null, 2)
}
