import { describe, expect, it } from 'vitest'
import {
  buildMockedResponse,
  buildResponseSpec,
  buildRewrittenResponse,
  isNullBodyStatus,
  needsRealBody,
  sleep,
} from '../src/content/rewriter'
import { createRule, type Rule, type RuleAction } from '../src/shared/rules'

function ruleWith(action: Partial<RuleAction>, match: Partial<Rule['match']> = {}): Rule {
  const base = createRule()
  return {
    ...base,
    match: { ...base.match, ...match },
    action: { ...base.action, ...action },
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('isNullBodyStatus', () => {
  it('认出规范不允许带 body 的状态码', () => {
    expect(isNullBodyStatus(204)).toBe(true)
    expect(isNullBodyStatus(205)).toBe(true)
    expect(isNullBodyStatus(304)).toBe(true)
    expect(isNullBodyStatus(101)).toBe(true)
    expect(isNullBodyStatus(200)).toBe(false)
  })
})

describe('needsRealBody', () => {
  it('只有「穿透改写 + 合并 JSON」才需要读真实响应体', () => {
    expect(needsRealBody(ruleWith({ mode: 'rewrite', bodyMode: 'merge-json', body: { text: '{}' } }))).toBe(true)
    expect(needsRealBody(ruleWith({ mode: 'rewrite', bodyMode: 'replace', body: { text: '{}' } }))).toBe(false)
    // 伪造模式根本没有真实响应可读
    expect(needsRealBody(ruleWith({ mode: 'mock', bodyMode: 'merge-json', body: { text: '{}' } }))).toBe(false)
    // 不动 body 就不需要读，读下去会破坏流式响应
    expect(needsRealBody(ruleWith({ mode: 'rewrite' }))).toBe(false)
  })
})

describe('buildResponseSpec', () => {
  it('没设 body 时不替换响应体', () => {
    const spec = buildResponseSpec(ruleWith({ status: 500 }), null)
    expect(spec.bodyReplaced).toBe(false)
    expect(spec.body).toBeUndefined()
    expect(spec.status).toBe(500)
  })

  it('合并模式下把真实响应合并进来', () => {
    const spec = buildResponseSpec(
      ruleWith({ bodyMode: 'merge-json', body: { text: '{"data":[]}' } }),
      JSON.stringify({ code: 0, data: [1, 2], msg: 'ok' }),
    )
    expect(JSON.parse(spec.body!)).toEqual({ code: 0, data: [], msg: 'ok' })
  })

  it('合并模式拿不到真实响应时退回整段替换', () => {
    const spec = buildResponseSpec(ruleWith({ bodyMode: 'merge-json', body: { text: '{"a":1}' } }), null)
    expect(spec.body).toBe('{"a":1}')
  })

  it('伪造模式即使没填 body 也视为「替换」（换成空 body）', () => {
    const spec = buildResponseSpec(ruleWith({ mode: 'mock' }), null)
    expect(spec.bodyReplaced).toBe(true)
    expect(spec.body).toBe('')
  })

  it('负的延迟被夹到 0', () => {
    expect(buildResponseSpec(ruleWith({ delayMs: -5 }), null).delayMs).toBe(0)
  })
})

describe('buildMockedResponse', () => {
  it('默认 200 + JSON content-type', () => {
    const response = buildMockedResponse(
      buildResponseSpec(ruleWith({ mode: 'mock', body: { text: '{"a":1}' } }), null),
      'https://x.com/api',
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('json')
  })

  it('按规则设状态码与响应头', () => {
    const response = buildMockedResponse(
      buildResponseSpec(
        ruleWith({
          mode: 'mock',
          status: 401,
          headers: { set: { 'x-trace': 'abc' } },
          body: { text: '{}' },
        }),
        null,
      ),
      'https://x.com/api',
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('x-trace')).toBe('abc')
  })

  it('204 不能带 body —— 带的话 Response 构造会直接抛错', () => {
    const response = buildMockedResponse(
      buildResponseSpec(ruleWith({ mode: 'mock', status: 204, body: { text: '{"a":1}' } }), null),
      'https://x.com/api',
    )
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })

  it('补上 url，否则读 response.url 的应用代码会拿到空字符串', () => {
    const response = buildMockedResponse(
      buildResponseSpec(ruleWith({ mode: 'mock', body: { text: '{}' } }), null),
      'https://x.com/api/list?page=2',
    )
    expect(response.url).toBe('https://x.com/api/list?page=2')
  })
})

describe('buildRewrittenResponse', () => {
  it('只改状态码时保留原始 body 流，不做缓冲', async () => {
    let push!: (chunk: string) => void
    let close!: () => void
    const encoder = new TextEncoder()
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('first'))
        push = (chunk) => controller.enqueue(encoder.encode(chunk))
        close = () => controller.close()
      },
    })

    const real = new Response(source, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })
    const out = buildRewrittenResponse(
      real,
      buildResponseSpec(ruleWith({ status: 503 }), null),
      'https://x.com/stream',
    )

    expect(out.status).toBe(503)

    // 关键断言：第二块还没入队，第一块就已经能读出来了。
    // 如果实现把 body 缓冲了，这里会一直等到 close 才有结果。
    const reader = out.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('first')

    push('second')
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toBe('second')
    close()
  })

  it('替换 body 时删掉描述网络字节的头', async () => {
    const real = jsonResponse(
      { code: 0, data: [1, 2] },
      { headers: { 'content-type': 'application/json', 'content-length': '20' } },
    )
    const out = buildRewrittenResponse(
      real,
      buildResponseSpec(ruleWith({ body: { text: '{"code":500}' } }), null),
      'https://x.com/api',
    )

    expect(out.headers.get('content-length')).toBeNull()
    expect(await out.text()).toBe('{"code":500}')
  })

  it('不改 body 时保留状态码与响应头', () => {
    const real = jsonResponse({ a: 1 }, { headers: { 'x-keep': 'yes' } })
    const out = buildRewrittenResponse(real, buildResponseSpec(ruleWith({}), null), 'https://x.com/api')

    expect(out.status).toBe(200)
    expect(out.headers.get('x-keep')).toBe('yes')
  })

  it('按 patch 增删响应头', () => {
    const real = jsonResponse({ a: 1 }, { headers: { 'x-drop': 'gone', 'x-keep': 'yes' } })
    const out = buildRewrittenResponse(
      real,
      buildResponseSpec(
        ruleWith({ headers: { set: { 'x-added': 'hi' }, remove: ['x-drop'] } }),
        null,
      ),
      'https://x.com/api',
    )

    expect(out.headers.get('x-drop')).toBeNull()
    expect(out.headers.get('x-added')).toBe('hi')
    expect(out.headers.get('x-keep')).toBe('yes')
  })

  it('补回 url —— new Response() 造出来的是空的', () => {
    const out = buildRewrittenResponse(
      jsonResponse({}),
      buildResponseSpec(ruleWith({ status: 500 }), null),
      'https://x.com/api/list',
    )
    expect(out.url).toBe('https://x.com/api/list')
  })

  it('把状态码改成 204 时丢掉 body', () => {
    const out = buildRewrittenResponse(
      jsonResponse({ a: 1 }),
      buildResponseSpec(ruleWith({ status: 204 }), null),
      'https://x.com/api',
    )
    expect(out.status).toBe(204)
    expect(out.body).toBeNull()
  })
})

describe('sleep', () => {
  it('已经取消的信号立刻 reject', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sleep(10, controller.signal)).rejects.toThrow()
  })

  it('延迟期间取消会中断等待', async () => {
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 10)
    await expect(sleep(5000, controller.signal)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('ms <= 0 时直接 resolve', async () => {
    await expect(sleep(0)).resolves.toBeUndefined()
  })
})
