import { useEffect, useMemo, useState } from 'react'
import { formatJson } from '../../shared/json'
import { HTTP_METHODS, type Rule } from '../../shared/rules'
import { matchesUrl, type PatternType } from '../../shared/url-match'
import { ruleSummary } from '../format'
import { type Draft, fromDraft, toDraft, validateDraft } from '../rule-draft'
import { Field, Section, Seg, Select, Switch, TextInput } from './Field'

const PATTERN_TYPES: { value: PatternType; label: string }[] = [
  { value: 'wildcard', label: '通配' },
  { value: 'contains', label: '包含' },
  { value: 'regex', label: '正则' },
]

export function RuleEditor({
  rule,
  onSave,
  onRemove,
}: {
  rule: Rule | null
  onSave: (rule: Rule) => void
  onRemove: (id: string) => void
}) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [probeUrl, setProbeUrl] = useState('')

  // 只在切换规则时重置草稿——依赖 rule.id 而不是 rule 对象本身，
  // 否则 storage 回声会让没保存的编辑被冲掉。
  useEffect(() => {
    setDraft(rule ? toDraft(rule) : null)
    setProbeUrl('')
  }, [rule?.id])

  const issues = useMemo(() => (draft ? validateDraft(draft) : []), [draft])
  const blocking = issues.filter((issue) => issue.blocking)
  const warnings = issues.filter((issue) => !issue.blocking)

  if (!rule || !draft) {
    return (
      <div className="pane detail-pane">
        <div className="empty">
          <p className="empty-title">还没选中规则</p>
          <p className="empty-hint">在左边选一条，或新建一条。</p>
        </div>
      </div>
    )
  }

  const patch = (next: Partial<Draft>) => setDraft({ ...draft, ...next })
  const preview = fromDraft(rule, draft)
  const errorFor = (field: string) =>
    blocking.find((issue) => issue.field === field)?.message
  const warningFor = (field: string) =>
    warnings.find((issue) => issue.field === field)?.message

  return (
    <div className="pane detail-pane editor-pane">
      <Section title="匹配">
        <Field label="名称" hint="只影响列表里怎么显示">
          <TextInput
            value={draft.name}
            placeholder="例如：空列表"
            onChange={(event) => patch({ name: event.target.value })}
          />
        </Field>

        <Field label="URL 模式" error={errorFor('urlPattern')}>
          <div className="row-inputs">
            <Select
              className="narrow"
              value={draft.patternType}
              onChange={(event) =>
                patch({ patternType: event.target.value as PatternType })
              }
            >
              {PATTERN_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <TextInput
              value={draft.urlPattern}
              placeholder="https://api.example.com/v1/list*"
              spellCheck={false}
              onChange={(event) => patch({ urlPattern: event.target.value })}
            />
          </div>
        </Field>

        <Field label="方法">
          <Select
            className="narrow"
            value={draft.method}
            onChange={(event) => patch({ method: event.target.value })}
          >
            {HTTP_METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="试试匹配" hint="粘一个真实 URL 进来，看这条规则会不会命中">
          <TextInput
            value={probeUrl}
            spellCheck={false}
            placeholder="https://api.example.com/v1/list?page=1"
            onChange={(event) => setProbeUrl(event.target.value)}
          />
        </Field>
        {probeUrl.trim() !== '' && (
          <p
            className={
              matchesUrl(draft.patternType, draft.urlPattern, probeUrl.trim())
                ? 'verdict ok'
                : 'verdict bad'
            }
          >
            {matchesUrl(draft.patternType, draft.urlPattern, probeUrl.trim())
              ? '会命中'
              : '不会命中'}
          </p>
        )}
      </Section>

      <Section title="动作">
        <Field
          label="模式"
          hint={
            draft.mode === 'rewrite'
              ? '真实请求照发，拿到响应后在最后一刻改掉'
              : '完全不发请求，直接现造一个响应'
          }
        >
          <Seg
            value={draft.mode}
            options={[
              { value: 'rewrite', label: '穿透改写' },
              { value: 'mock', label: '直接伪造' },
            ]}
            onChange={(mode) =>
              // 伪造模式没有真实响应可合并，顺手把 body 模式拨回替换。
              patch(mode === 'mock' ? { mode, bodyMode: 'replace' } : { mode })
            }
          />
        </Field>

        <div className="row-inputs">
          <Field label="状态码" hint="留空 = 不改" error={errorFor('status')}>
            <TextInput
              className="narrow"
              inputMode="numeric"
              placeholder="不改"
              value={draft.statusText}
              onChange={(event) => patch({ statusText: event.target.value })}
            />
          </Field>
          <Field label="延迟" hint="毫秒，留空 = 不延迟" error={errorFor('delay')}>
            <TextInput
              className="narrow"
              inputMode="numeric"
              placeholder="0"
              value={draft.delayText}
              onChange={(event) => patch({ delayText: event.target.value })}
            />
          </Field>
          <Field label="故障" hint="网络错误会抛 TypeError，和真断网一致">
            <Select
              className="narrow"
              value={draft.failure}
              onChange={(event) =>
                patch({ failure: event.target.value as Draft['failure'] })
              }
            >
              <option value="none">无</option>
              <option value="network-error">网络错误</option>
              <option value="timeout">超时</option>
            </Select>
          </Field>
        </div>
      </Section>

      <Section title="响应头">
        <Field label="设置" hint="每行一条 Name: value" error={warningFor('headers')}>
          <textarea
            className="input textarea"
            rows={3}
            spellCheck={false}
            placeholder={'content-type: application/json'}
            value={draft.headerSetText}
            onChange={(event) => patch({ headerSetText: event.target.value })}
          />
        </Field>
        <Field label="删除" hint="每行一个名字，例如 set-cookie">
          <textarea
            className="input textarea"
            rows={2}
            spellCheck={false}
            value={draft.headerRemoveText}
            onChange={(event) => patch({ headerRemoveText: event.target.value })}
          />
        </Field>
      </Section>

      <Section title="响应体">
        <Switch
          label={draft.bodyEnabled ? '修改响应体' : '不动响应体'}
          checked={draft.bodyEnabled}
          onChange={(bodyEnabled) => patch({ bodyEnabled })}
        />

        {draft.bodyEnabled && (
          <>
            <Field
              label="方式"
              hint={
                draft.mode === 'mock'
                  ? '伪造模式下只能整段替换'
                  : draft.bodyMode === 'merge-json'
                    ? '深合并到真实响应上，只改你写到的字段；数组整体替换'
                    : '整段替换真实响应体'
              }
              error={warningFor('body')}
            >
              <Seg
                value={draft.bodyMode}
                options={[
                  { value: 'merge-json', label: '合并 JSON' },
                  { value: 'replace', label: '整段替换' },
                ]}
                onChange={(bodyMode) => patch({ bodyMode })}
              />
            </Field>

            <div className="body-tools">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const formatted = formatJson(draft.bodyText)
                  if (formatted === null) {
                    window.alert('不是合法 JSON，无法格式化。')
                    return
                  }
                  patch({ bodyText: formatted })
                }}
              >
                格式化
              </button>
            </div>

            <textarea
              className="input textarea code-textarea"
              rows={10}
              spellCheck={false}
              placeholder={'{\n  "data": []\n}'}
              value={draft.bodyText}
              onChange={(event) => patch({ bodyText: event.target.value })}
            />
          </>
        )}
      </Section>

      <div className="editor-foot">
        <div className="editor-actions">
          <button
            type="button"
            className="btn primary"
            disabled={blocking.length > 0}
            onClick={() => onSave(fromDraft(rule, draft))}
          >
            保存
          </button>
          <button type="button" className="btn" onClick={() => setDraft(toDraft(rule))}>
            重置
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={() => onRemove(rule.id)}
          >
            删除
          </button>
        </div>
        <p className="rule-preview">这条规则会：{ruleSummary(preview)}</p>
      </div>
    </div>
  )
}
