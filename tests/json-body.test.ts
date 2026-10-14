import { describe, expect, it } from 'vitest'
import {
  MAX_HIGHLIGHT_LENGTH,
  describeBody,
  prettyJson,
  tokenizeJson,
} from '../src/devtools/json-body'

describe('prettyJson', () => {
  it('缩进对象和数组', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyJson('[1,2]')).toBe('[\n  1,\n  2\n]')
  })

  it('忽略首尾空白', () => {
    expect(prettyJson('  \n {"a":1}  ')).toBe('{\n  "a": 1\n}')
  })

  it('不对非对象/数组下手', () => {
    // `123` 和 `"x"` 也是合法 JSON，但「格式化」它们没有意义
    expect(prettyJson('123')).toBeNull()
    expect(prettyJson('"hello"')).toBeNull()
    expect(prettyJson('true')).toBeNull()
  })

  it('解析不了就返回 null', () => {
    expect(prettyJson('{ not json')).toBeNull()
    expect(prettyJson('')).toBeNull()
  })

  it('截断的 body 不会被硬凑', () => {
    // 采集上限截断后 JSON 几乎一定不完整，这时应该老实显示原文
    expect(prettyJson('{"a":1,"b":[1,2')).toBeNull()
  })

  it('超长文本直接放弃', () => {
    const huge = `{"a":"${'x'.repeat(300 * 1024)}"}`
    expect(prettyJson(huge)).toBeNull()
  })

  it('保持数字和 unicode 原样', () => {
    expect(prettyJson('{"n":1e10,"s":"中文","f":1.5}')).toBe(
      '{\n  "n": 10000000000,\n  "s": "中文",\n  "f": 1.5\n}',
    )
  })
})

describe('describeBody', () => {
  it('JSON 给出两种视图', () => {
    const view = describeBody('{"a":1}')
    expect(view).not.toBeNull()
    expect(view?.json).toBe(true)
    expect(view?.raw).toBe('{"a":1}')
    expect(view?.pretty).toBe('{\n  "a": 1\n}')
  })

  it('非 JSON 时 pretty 退回原文', () => {
    const view = describeBody('hello world')
    expect(view?.json).toBe(false)
    expect(view?.pretty).toBe('hello world')
    expect(view?.raw).toBe('hello world')
  })

  it('空 body 返回 null，交给 empty 文案处理', () => {
    expect(describeBody(undefined)).toBeNull()
    expect(describeBody('')).toBeNull()
  })
})

describe('tokenizeJson', () => {
  const kinds = (text: string) => tokenizeJson(text).map((token) => token.kind)

  it('区分键、字符串值、数字、字面量和标点', () => {
    expect(kinds('{"a":1,"b":"x","c":true}')).toEqual([
      'punct',
      'key',
      'punct',
      'number',
      'punct',
      'key',
      'punct',
      'string',
      'punct',
      'key',
      'punct',
      'literal',
      'punct',
    ])
  })

  it('拼接回来和输入完全一致', () => {
    const text = '{\n  "a": [1, -2.5, 1e3],\n  "b": { "c": null }\n}'
    expect(tokenizeJson(text).map((token) => token.text).join('')).toBe(text)
  })

  it('引号里的关键字不会被当成字面量', () => {
    const tokens = tokenizeJson('{"s":"true null 123","t":false}')
    const strings = tokens.filter((token) => token.kind === 'string')
    expect(strings.map((token) => token.text)).toEqual(['"true null 123"'])
    expect(tokens.filter((token) => token.kind === 'literal').map((t) => t.text)).toEqual(['false'])
  })

  it('转义引号不会把字符串截断', () => {
    const text = '{"s":"a\\"b: c"}'
    expect(tokenizeJson(text).map((token) => token.text).join('')).toBe(text)
    expect(tokenizeJson(text).filter((t) => t.kind === 'string').map((t) => t.text)).toEqual([
      '"a\\"b: c"',
    ])
  })

  it('中文和 emoji 原样保留', () => {
    const text = '{\n  "名称": "测试 🎉"\n}'
    expect(tokenizeJson(text).map((token) => token.text).join('')).toBe(text)
  })

  it('空串不炸', () => {
    expect(tokenizeJson('')).toEqual([])
  })
})

describe('MAX_HIGHLIGHT_LENGTH', () => {
  it('是个能给 CodeBlock 用的阈值', () => {
    expect(MAX_HIGHLIGHT_LENGTH).toBeGreaterThan(1024)
    expect(MAX_HIGHLIGHT_LENGTH).toBeLessThan(1024 * 1024)
  })
})
