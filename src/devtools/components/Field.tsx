import {
  useMemo,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'
import { MAX_HIGHLIGHT_LENGTH, describeBody, tokenizeJson } from '../json-body'

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className={error ? 'field has-error' : 'field'}>
      <span className="field-label">{label}</span>
      {children}
      {error ? (
        <span className="field-error">{error}</span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </label>
  )
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className ?? ''}`} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`input ${props.className ?? ''}`} />
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
}) {
  return (
    <div className="seg" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'seg-item active' : 'seg-item'}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  title?: string
}) {
  return (
    <button
      type="button"
      title={title}
      className={checked ? 'switch on' : 'switch'}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
    >
      <span className="switch-dot" />
      {label}
    </button>
  )
}

/**
 * 折叠一段只读文本，用于请求/响应头与 body。
 *
 * JSON 默认美化 + 上色，但**原文必须还能看到**：面板从头到尾都在说
 * 「这是应用实际收到的字节」，美化会改动空白，所以两者得能切换。
 */
export function CodeBlock({
  text,
  truncatedFrom,
  empty = '无',
}: {
  text: string | undefined
  truncatedFrom?: number
  empty?: string
}) {
  const [asRaw, setAsRaw] = useState(false)
  const view = useMemo(() => describeBody(text), [text])

  if (text === undefined || text === '') {
    return <pre className="code empty-code">{empty}</pre>
  }

  const formatted = view?.json === true && !asRaw
  const body = formatted ? view.pretty : text
  // 高亮要生成上千个 span，太长就只缩进不上色。
  const tokens = formatted && body.length <= MAX_HIGHLIGHT_LENGTH ? tokenizeJson(body) : null

  return (
    <>
      {view?.json === true && (
        <div className="code-bar">
          <span className="code-note">{asRaw ? '' : '已美化（空白与原文不同）'}</span>
          <button
            type="button"
            className="code-toggle"
            onClick={() => setAsRaw((current) => !current)}
            title="美化会改动空白，要核对原始字节时切回原文"
          >
            {asRaw ? '显示格式化' : '显示原文'}
          </button>
        </div>
      )}
      <pre className={`code${formatted ? ' code-json' : ''}`}>
        {tokens
          ? tokens.map((token, index) => (
              <span key={index} className={`tok tok-${token.kind}`}>
                {token.text}
              </span>
            ))
          : body}
      </pre>
      {truncatedFrom !== undefined && (
        <div className="truncated">内容过长，已截断（原 {truncatedFrom} 字符）</div>
      )}
    </>
  )
}

/** 可折叠的一段。内容长的时候折叠比滚动好找。 */
export function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className={open ? 'section' : 'section collapsed'}>
      <h3 className="section-title">
        <button
          type="button"
          className="section-toggle"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {/* 三角由 CSS 画：▾ 这种字形在小字号下会缩成一个点 */}
          <span className="section-caret" aria-hidden="true" />
          {title}
        </button>
      </h3>
      {open && children}
    </section>
  )
}
