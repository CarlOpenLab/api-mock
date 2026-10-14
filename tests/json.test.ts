import { describe, expect, it } from 'vitest'
import { deepMerge, formatJson, mergeJsonText, parseJson } from '../src/shared/json'

describe('deepMerge', () => {
  it('递归合并对象，未提及的键保持原值', () => {
    expect(deepMerge({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 } })).toEqual({
      a: 1,
      b: { c: 9, d: 3 },
    })
  })

  it('数组整体替换，不逐项合并', () => {
    // 逐项合并在数组长度不一致时结果难以预测，所以这里刻意选择替换。
    expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] })
  })

  it('null 是有效值，直接覆盖', () => {
    expect(deepMerge({ a: { b: 1 } }, { a: null })).toEqual({ a: null })
  })

  it('类型不同时 patch 获胜', () => {
    expect(deepMerge({ a: { b: 1 } }, { a: 'text' })).toEqual({ a: 'text' })
    expect(deepMerge({ a: 'text' }, { a: { b: 1 } })).toEqual({ a: { b: 1 } })
  })

  it('不修改入参', () => {
    const target = { a: { b: 1 } }
    deepMerge(target, { a: { b: 2 } })
    expect(target.a.b).toBe(1)
  })
})

describe('mergeJsonText', () => {
  it('把 patch 合并到真实响应上', () => {
    const merged = JSON.parse(
      mergeJsonText('{"code":0,"data":{"total":10,"rows":[1,2]}}', '{"data":{"rows":[]}}'),
    )
    expect(merged).toEqual({ code: 0, data: { total: 10, rows: [] } })
  })

  it('真实响应不是 JSON 时退化为直接用 patch 文本', () => {
    expect(mergeJsonText('<html></html>', '{"a":1}')).toBe('{"a":1}')
  })

  it('patch 不是 JSON 时原样返回 patch 文本，而不是抛错', () => {
    expect(mergeJsonText('{"a":1}', 'not json')).toBe('not json')
  })
})

describe('parseJson / formatJson', () => {
  it('解析失败时带回错误信息，不抛异常', () => {
    const result = parseJson('{oops}')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBeTruthy()
  })

  it('格式化失败返回 null，让调用方保留原文', () => {
    expect(formatJson('{oops}')).toBeNull()
  })

  it('格式化合法 JSON', () => {
    expect(formatJson('{"a":1}')).toBe('{\n  "a": 1\n}')
  })
})
