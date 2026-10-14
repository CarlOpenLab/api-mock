import type { Rule } from '../../shared/rules'
import { ruleIsNoop, ruleSummary } from '../format'

export function RuleList({
  rules,
  editingId,
  onEdit,
  onToggle,
  onRemove,
  onMove,
  onCreate,
}: {
  rules: Rule[]
  editingId: string | null
  onEdit: (id: string) => void
  onToggle: (id: string, enabled: boolean) => void
  onRemove: (id: string) => void
  onMove: (id: string, delta: number) => void
  onCreate: () => void
}) {
  return (
    <div className="pane list-pane">
      <div className="list-head rules-head">
        <span className="col-enabled">启用</span>
        <span className="col-rule">规则</span>
        <span className="col-actions">优先级</span>
      </div>

      <div className="list-body">
        {rules.length === 0 && (
          <div className="empty">
            <p className="empty-title">还没有规则</p>
            <p className="empty-hint">
              点「新建规则」，或在请求页选一条请求点「以此请求建规则」。
            </p>
          </div>
        )}

        {rules.map((rule, index) => (
          <div
            key={rule.id}
            className={`row rule-row${rule.id === editingId ? ' selected' : ''}${
              rule.enabled ? '' : ' disabled'
            }`}
          >
            <input
              type="checkbox"
              className="checkbox"
              checked={rule.enabled}
              onChange={(event) => onToggle(rule.id, event.target.checked)}
              title={rule.enabled ? '停用这条规则' : '启用这条规则'}
            />
            <button type="button" className="rule-main" onClick={() => onEdit(rule.id)}>
              <span className="rule-name">
                {rule.name || rule.match.urlPattern || '（未命名）'}
              </span>
              <span className="rule-pattern">
                <span className="rule-method">{rule.match.method}</span>
                {rule.match.urlPattern || <span className="muted">未填 URL 模式</span>}
              </span>
              <span className={ruleIsNoop(rule) ? 'rule-summary warn' : 'rule-summary'}>
                {ruleIsNoop(rule) ? '没有任何动作，这条规则不会有任何效果' : ruleSummary(rule)}
              </span>
            </button>
            <span className="rule-actions">
              <button
                type="button"
                className="icon-btn"
                disabled={index === 0}
                onClick={() => onMove(rule.id, -1)}
                title="上移（排在前面的规则先命中）"
              >
                ↑
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={index === rules.length - 1}
                onClick={() => onMove(rule.id, 1)}
                title="下移"
              >
                ↓
              </button>
              <button
                type="button"
                className="icon-btn danger"
                onClick={() => onRemove(rule.id)}
                title="删除"
              >
                ✕
              </button>
            </span>
          </div>
        ))}
      </div>

      <div className="list-foot">
        <button type="button" className="btn primary" onClick={onCreate}>
          + 新建规则
        </button>
      </div>
    </div>
  )
}
