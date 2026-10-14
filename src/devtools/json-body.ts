/**
 * body 的展示处理：JSON 美化 + 给高亮用的分词。
 *
 * 面板对用户的承诺是「应用实际收到的 body」，所以美化只能是一种**视图**：
 * 原始文本必须还能原样看到，否则这个工具就在骗人。CodeBlock 上因此有个
 * 「原文 / 格式化」开关，这里只负责算出两者。
 */

/** 超过这个大小就不格式化了——几十万字符的 JSON.stringify 会把面板卡住。 */
const MAX_FORMAT_LENGTH = 256 * 1024

/** 高亮要生成几千个 span，太大就不上色，只做缩进。 */
export const MAX_HIGHLIGHT_LENGTH = 24 * 1024

export type BodyView = {
  /** 能不能当 JSON 读。不能的话 pretty 就等于 raw。 */
  json: boolean
  /** 缩进美化过的文本。 */
  pretty: string
  /** 原始文本，一个字符都没动过。 */
  raw: string
}

/**
 * 能解析成 JSON 就返回缩进后的文本，否则 null。
 *
 * 只对以 { 或 [ 开头的下手：数字、字符串、true 本身也是合法 JSON，
 * 但把 `123` 「格式化」成 `123` 没有意义，还会让开关显得坏了。
 */
export function prettyJson(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return null
  if (raw.length > MAX_FORMAT_LENGTH) return null
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    // 解析失败（截断的 body 很常见）或嵌套太深导致 stringify 爆栈
    return null
  }
}

export function describeBody(raw: string | undefined): BodyView | null {
  if (raw === undefined || raw === '') return null
  const pretty = prettyJson(raw)
  return { json: pretty !== null, pretty: pretty ?? raw, raw }
}

export type TokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct'
export type Token = { kind: TokenKind; text: string }

/**
 * 把美化后的 JSON 切成带类型的片段。
 *
 * 字符串分支排在最前，所以引号里面的 `true`、`{`、`123` 不会被误判——
 * 正则从当前位置往后试，遇到 `"` 就先整段吃掉。
 */
const TOKEN_RE = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

export function tokenizeJson(text: string): Token[] {
  const tokens: Token[] = []
  let cursor = 0

  TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const whole = match[0]
    if (match.index > cursor) {
      tokens.push({ kind: 'punct', text: text.slice(cursor, match.index) })
    }

    const [, quoted, colon, literal, number] = match
    if (quoted !== undefined) {
      // 后面紧跟着冒号的是键，否则是字符串值。
      if (colon !== undefined) {
        tokens.push({ kind: 'key', text: quoted })
        tokens.push({ kind: 'punct', text: colon })
      } else {
        tokens.push({ kind: 'string', text: quoted })
      }
    } else if (literal !== undefined) {
      tokens.push({ kind: 'literal', text: literal })
    } else if (number !== undefined) {
      tokens.push({ kind: 'number', text: number })
    }

    cursor = match.index + whole.length
  }

  if (cursor < text.length) tokens.push({ kind: 'punct', text: text.slice(cursor) })
  return tokens
}
