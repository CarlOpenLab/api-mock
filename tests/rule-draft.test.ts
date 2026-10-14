import { describe, expect, it } from 'vitest'
import {
  formatHeaderSet,
  fromDraft,
  parseHeaderSet,
  toDraft,
  validateDraft,
} from '../src/devtools/rule-draft'
import { createRule, type Rule, type RuleAction } from '../src/shared/rules'

function ruleWith(action: Partial<RuleAction> = {}): Rule {
  const base = createRule({ match: { patternType: 'wildcard', urlPattern: 'https://x.com/*', method: 'ANY' } })
  return { ...base, action: { ...base.action, ...action } }
}

describe('toDraft / fromDraft 往返', () => {
  it('原样往返一条完整规则', () => {
    const rule: Rule = {
      ...ruleWith(),
      name: '空列表',
      match: { patternType: 'contains', urlPattern: '/api/list', method: 'GET' },
      action: {
        mode: 'rewrite',
        status: 503,
        delayMs: 1500,
        failure: 'none',
        bodyMode: 'merge-json',
        body: { text: '{"data":[]}' },
        headers: { set: { 'x-mock': '1' }, remove: ['set-cookie'] },
      },
    }
    expect(fromDraft(rule, toDraft(rule))).toEqual(rule)
  })

  it('留空的状态码和延迟表示「不改」，而不是 0', () => {
    const rule = ruleWith({ status: undefined, delayMs: 0 })
    const draft = toDraft(rule)
    expect(draft.statusText).toBe('')
    expect(draft.delayText).toBe('')

    const round = fromDraft(rule, draft)
    expect(round.action.status).toBeUndefined()
    expect(round.action.delayMs).toBe(0)
  })

  it('body 关闭时清掉 body 字段', () => {
    const rule = ruleWith({ body: { text: '{}' } })
    const draft = { ...toDraft(rule), bodyEnabled: false, bodyText: '{}' }
    expect(fromDraft(rule, draft).action.body).toBeUndefined()
  })

  it('响应头两边都空时不留下空壳对象', () => {
    const rule = ruleWith({ headers: { set: {}, remove: [] } })
    expect(fromDraft(rule, toDraft(rule)).action.headers).toBeUndefined()
  })

  it('数字字段空串不会变成 NaN', () => {
    const rule = ruleWith()
    const draft = { ...toDraft(rule), statusText: '  ', delayText: '  ' }
    const round = fromDraft(rule, draft)
    expect(round.action.status).toBeUndefined()
    expect(round.action.delayMs).toBe(0)
  })
})

describe('parseHeaderSet / formatHeaderSet', () => {
  it('解析每行一条的 Name: value', () => {
    expect(parseHeaderSet('content-type: application/json\nx-trace: abc')).toEqual({
      'content-type': 'application/json',
      'x-trace': 'abc',
    })
  })

  it('忽略空行和注释行', () => {
    expect(parseHeaderSet('\n# 注释\nx-a: 1\n')).toEqual({ 'x-a': '1' })
  })

  it('值里带冒号时只在第一个冒号处切分', () => {
    expect(parseHeaderSet('location: https://x.com/a')).toEqual({
      location: 'https://x.com/a',
    })
  })

  it('往返一致', () => {
    const set = { 'content-type': 'application/json', 'x-trace': 'abc' }
    expect(parseHeaderSet(formatHeaderSet(set))).toEqual(set)
  })
})

describe('validateDraft', () => {
  it('URL 模式为空是硬错误', () => {
    const issues = validateDraft({ ...toDraft(ruleWith()), urlPattern: '  ' })
    expect(issues).toContainEqual({ field: 'urlPattern', message: '必填', blocking: true })
  })

  it('非法正则是硬错误', () => {
    const issues = validateDraft({
      ...toDraft(ruleWith()),
      patternType: 'regex',
      urlPattern: '[',
    })
    expect(issues.find((issue) => issue.field === 'urlPattern')?.blocking).toBe(true)
  })

  it('状态码超出 200–599 是硬错误', () => {
    const base = toDraft(ruleWith())
    expect(validateDraft({ ...base, statusText: '100' }).some((i) => i.field === 'status' && i.blocking)).toBe(true)
    expect(validateDraft({ ...base, statusText: '600' }).some((i) => i.field === 'status' && i.blocking)).toBe(true)
    expect(validateDraft({ ...base, statusText: '500' }).some((i) => i.field === 'status')).toBe(false)
  })

  it('状态码不是数字是硬错误', () => {
    const issues = validateDraft({ ...toDraft(ruleWith()), statusText: 'abc' })
    expect(issues.some((issue) => issue.field === 'status' && issue.blocking)).toBe(true)
  })

  it('合并模式下 body 不是 JSON 只是警告，不挡保存', () => {
    const issues = validateDraft({
      ...toDraft(ruleWith()),
      bodyEnabled: true,
      bodyMode: 'merge-json',
      bodyText: '{oops}',
    })
    const issue = issues.find((item) => item.field === 'body')
    expect(issue?.blocking).toBe(false)
  })

  it('整段替换模式下 body 是任意文本都不报警', () => {
    const issues = validateDraft({
      ...toDraft(ruleWith()),
      bodyEnabled: true,
      bodyMode: 'replace',
      bodyText: '就是一段普通文本',
    })
    expect(issues.some((issue) => issue.field === 'body')).toBe(false)
  })

  it('响应头少了冒号只是警告', () => {
    const issues = validateDraft({ ...toDraft(ruleWith()), headerSetText: 'x-trace 1' })
    expect(issues.find((issue) => issue.field === 'headers')?.blocking).toBe(false)
  })

  it('一条干净的规则没有任何问题', () => {
    const draft = {
      ...toDraft(ruleWith()),
      urlPattern: 'https://x.com/api/*',
      statusText: '500',
      delayText: '300',
      bodyEnabled: true,
      bodyMode: 'replace' as const,
      bodyText: '{"msg":"boom"}',
      headerSetText: 'x-mock: 1',
    }
    expect(validateDraft(draft)).toEqual([])
  })
})
