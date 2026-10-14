import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import type { FeedEntry } from '../shared/protocol'
import { createRule, patternFromUrl, type Rule } from '../shared/rules'
import {
  DEFAULT_SETTINGS,
  EMPTY_RULES,
  RULES_KEY,
  SETTINGS_KEY,
  type Settings,
} from '../shared/storage'
import { RuleEditor } from './components/RuleEditor'
import { RuleList } from './components/RuleList'
import { RequestDetail } from './components/RequestDetail'
import { RequestList } from './components/RequestList'
import { Toolbar, type PanelTab } from './components/Toolbar'
import { shortUrl } from './format'
import { useFeed } from './hooks/useFeed'
import { useStoredValue } from './hooks/useStoredValue'
import { isTypingTarget } from './keyboard'

/** 左栏占比，存在面板自己的 localStorage 里——这是视图偏好，不是扩展状态。 */
const SPLIT_KEY = 'api-mock:split'
const SPLIT_DEFAULT = 0.45
const SPLIT_MIN = 0.2
const SPLIT_MAX = 0.8

function clampRatio(value: number): number {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value))
}

function loadRatio(): number {
  try {
    const raw = localStorage.getItem(SPLIT_KEY)
    const value = raw === null ? Number.NaN : Number(raw)
    if (Number.isFinite(value)) return clampRatio(value)
  } catch {
    /* 隐私模式之类的会抛，用默认值就是 */
  }
  return SPLIT_DEFAULT
}

/** 两栏 + 中间一条可拖拽的分隔条。双击恢复默认。 */
function Split({ left, right }: { left: ReactNode; right: ReactNode }) {
  const [ratio, setRatio] = useState(loadRatio)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_KEY, String(ratio))
    } catch {
      /* 存不了就算了，不影响使用 */
    }
  }, [ratio])

  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const container = containerRef.current
    if (!container) return
    event.preventDefault()

    const rect = container.getBoundingClientRect()
    const onMove = (move: PointerEvent) => {
      if (rect.width === 0) return
      setRatio(clampRatio((move.clientX - rect.left) / rect.width))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('dragging-split')
    }

    // 拖拽期间整页用 col-resize，不然指针划过 iframe/代码块会闪。
    document.body.classList.add('dragging-split')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  return (
    <div
      className="split"
      ref={containerRef}
      style={{ '--split': `${ratio * 100}%` } as CSSProperties}
    >
      {left}
      <div
        className="split-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整两栏宽度"
        onPointerDown={startDrag}
        onDoubleClick={() => setRatio(SPLIT_DEFAULT)}
      />
      {right}
    </div>
  )
}

export function App() {
  const tabId = chrome.devtools.inspectedWindow.tabId

  const [rules, setRules] = useStoredValue<Rule[]>(RULES_KEY, EMPTY_RULES)
  const [settings, setSettings] = useStoredValue<Settings>(SETTINGS_KEY, DEFAULT_SETTINGS)
  const feed = useFeed(tabId)

  const [tab, setTab] = useState<PanelTab>('requests')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)

  const selected = useMemo(
    () => feed.entries.find((entry) => entry.id === selectedId) ?? null,
    [feed.entries, selectedId],
  )
  const editing = useMemo(
    () => rules.find((rule) => rule.id === editingId) ?? null,
    [rules, editingId],
  )

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => setSettings({ ...settings, ...patch }),
    [settings, setSettings],
  )

  const saveRule = useCallback(
    (next: Rule) => {
      setRules(
        rules.some((rule) => rule.id === next.id)
          ? rules.map((rule) => (rule.id === next.id ? next : rule))
          : [...rules, next],
      )
    },
    [rules, setRules],
  )

  const removeRule = useCallback(
    (id: string) => {
      setRules(rules.filter((rule) => rule.id !== id))
      setEditingId((current) => (current === id ? null : current))
    },
    [rules, setRules],
  )

  const toggleRule = useCallback(
    (id: string, enabled: boolean) => {
      setRules(rules.map((rule) => (rule.id === id ? { ...rule, enabled } : rule)))
    },
    [rules, setRules],
  )

  /** 上移/下移改变优先级：列表里排前面的规则先命中。 */
  const moveRule = useCallback(
    (id: string, delta: number) => {
      const index = rules.findIndex((rule) => rule.id === id)
      const target = index + delta
      if (index === -1 || target < 0 || target >= rules.length) return
      const next = [...rules]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      setRules(next)
    },
    [rules, setRules],
  )

  const createBlankRule = useCallback(() => {
    // URL 模式先留空会立刻报「必填」，所以给一个明显要改的占位。
    const rule = createRule({
      name: '',
      match: { patternType: 'wildcard', urlPattern: 'https://api.example.com/', method: 'ANY' },
      action: { mode: 'rewrite', bodyMode: 'merge-json', failure: 'none', body: { text: '{\n  \n}' } },
    })
    setRules([...rules, rule])
    setEditingId(rule.id)
  }, [rules, setRules])

  const createRuleFromEntry = useCallback(
    (entry: FeedEntry) => {
      const rule = createRule({
        name: shortUrl(entry.url),
        match: {
          patternType: 'wildcard',
          urlPattern: patternFromUrl(entry.url),
          method: entry.method,
        },
        // 默认给「合并一个空对象」——用户改一个字就能用，
        // 好过留一堆空字段让他猜该填什么。
        action: {
          mode: 'rewrite',
          bodyMode: 'merge-json',
          failure: 'none',
          body: { text: '{}' },
        },
      })
      setRules([...rules, rule])
      setEditingId(rule.id)
      setTab('rules')
    },
    [rules, setRules],
  )

  // Esc 只取消请求选中，不碰规则编辑器——那边有没保存的草稿，关掉就丢了。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (isTypingTarget(event.target)) return
      setSelectedId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="app">
      <Toolbar
        tab={tab}
        onTab={setTab}
        requestCount={feed.entries.length}
        ruleCount={rules.length}
        settings={settings}
        onSettings={updateSettings}
        connected={feed.connected}
        onClear={feed.clear}
        rules={rules}
        onImport={setRules}
      />

      {tab === 'requests' ? (
        <Split
          left={
            <RequestList
              entries={feed.entries}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onCreateRule={createRuleFromEntry}
            />
          }
          right={<RequestDetail entry={selected} onCreateRule={createRuleFromEntry} />}
        />
      ) : (
        <Split
          left={
            <RuleList
              rules={rules}
              editingId={editingId}
              onEdit={setEditingId}
              onToggle={toggleRule}
              onRemove={removeRule}
              onMove={moveRule}
              onCreate={createBlankRule}
            />
          }
          right={<RuleEditor rule={editing} onSave={saveRule} onRemove={removeRule} />}
        />
      )}
    </div>
  )
}
