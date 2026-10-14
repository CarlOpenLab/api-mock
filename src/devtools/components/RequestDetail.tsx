import type { FeedEntry } from '../../shared/protocol'
import { formatDuration, formatTime, outcomeLabel, outcomeTone, statusText } from '../format'
import { CodeBlock, Section } from './Field'

export function RequestDetail({
  entry,
  onCreateRule,
}: {
  entry: FeedEntry | null
  onCreateRule: (entry: FeedEntry) => void
}) {
  if (!entry) {
    return (
      <div className="pane detail-pane">
        <div className="empty">
          <p className="empty-title">在左边选一条请求</p>
          <p className="empty-hint">选中后可以看它被改写成了什么，并据此建规则。</p>
        </div>
      </div>
    )
  }

  const tone = outcomeTone(entry)

  return (
    <div className="pane detail-pane">
      <div className="detail-head">
        <span className={`method method-${entry.method}`}>{entry.method}</span>
        <span className="detail-url" title={entry.url}>
          {entry.url}
        </span>
        <button type="button" className="btn primary" onClick={() => onCreateRule(entry)}>
          以此请求建规则
        </button>
      </div>

      <dl className="kv">
        <dt>结果</dt>
        <dd className={`tone-${tone}`}>
          {outcomeLabel(entry)}
          {entry.ruleName ? ` · ${entry.ruleName}` : ''}
          {entry.ruleId && !entry.ruleName ? ' · 未命名规则' : ''}
        </dd>

        <dt>应用看到的状态码</dt>
        <dd>{statusText(entry)}</dd>

        {entry.realStatus !== undefined && entry.realStatus !== entry.status && (
          <>
            <dt>网络真实状态码</dt>
            <dd>{entry.realStatus}</dd>
          </>
        )}

        <dt>耗时</dt>
        <dd>
          {formatDuration(entry.totalMs)}
          {entry.outcome === 'rewritten' &&
            entry.durationMs !== undefined &&
            entry.totalMs !== entry.durationMs && (
              <span className="muted">（其中网络 {formatDuration(entry.durationMs)}）</span>
            )}
        </dd>

        <dt>通道</dt>
        <dd>{entry.transport === 'fetch' ? 'fetch' : 'XMLHttpRequest'}</dd>

        <dt>时间</dt>
        <dd>{formatTime(entry.ts)}</dd>
      </dl>

      <Section title="响应头">
        <CodeBlock
          text={headersToText(entry.responseHeaders)}
          empty={entry.outcome === 'failed' ? '（请求失败，没有响应）' : '（无响应头）'}
        />
      </Section>

      <Section title="响应体（应用实际收到的）">
        <CodeBlock text={entry.responseBody} truncatedFrom={entry.truncatedFrom} />
      </Section>

      <Section title="请求头">
        <CodeBlock text={headersToText(entry.requestHeaders)} />
      </Section>

      <Section title="请求体">
        <CodeBlock text={entry.requestBody} />
      </Section>
    </div>
  )
}

function headersToText(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`)
  return lines.length ? lines.join('\n') : undefined
}
