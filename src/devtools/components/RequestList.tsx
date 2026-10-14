import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FeedEntry } from '../../shared/protocol'
import { isTypingTarget } from '../keyboard'
import {
  formatDuration,
  formatTime,
  outcomeLabel,
  outcomeTone,
  shortUrl,
  statusText,
} from '../format'

/** 一屏能看的就这么多，再多也没人会滚动；超出部分明确提示而不是静默丢弃。 */
const MAX_RENDERED = 300

type Filter = 'all' | FeedEntry['outcome']

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'rewritten', label: '改写' },
  { value: 'mocked', label: '伪造' },
  { value: 'failed', label: '失败' },
  { value: 'passthrough', label: '放行' },
]

export function filterEntries(entries: FeedEntry[], query: string, filter: Filter): FeedEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle && filter === 'all') return entries
  return entries.filter((entry) => {
    if (filter !== 'all' && entry.outcome !== filter) return false
    if (!needle) return true
    return (
      entry.url.toLowerCase().includes(needle) || entry.method.toLowerCase().includes(needle)
    )
  })
}

const Row = memo(function Row({
  entry,
  selected,
  onSelect,
}: {
  entry: FeedEntry
  selected: boolean
  onSelect: (id: string) => void
}) {
  const tone = outcomeTone(entry)
  return (
    <button
      type="button"
      className={`row${selected ? ' selected' : ''}`}
      onClick={() => onSelect(entry.id)}
      title={entry.url}
    >
      <span className={`method method-${entry.method}`}>{entry.method}</span>
      <span className="row-url">{shortUrl(entry.url)}</span>
      <span className={`row-status tone-${tone}`}>{statusText(entry)}</span>
      <span className={`row-outcome tone-${tone}`}>{outcomeLabel(entry)}</span>
      <span className="row-time">{formatDuration(entry.totalMs)}</span>
      <span className="row-ts">{formatTime(entry.ts)}</span>
    </button>
  )
})

export function RequestList({
  entries,
  selectedId,
  onSelect,
  onCreateRule,
}: {
  entries: FeedEntry[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreateRule: (entry: FeedEntry) => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [follow, setFollow] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)

  const matched = useMemo(() => filterEntries(entries, query, filter), [entries, query, filter])
  const visible = matched.slice(0, MAX_RENDERED)
  const hidden = matched.length - visible.length

  // 新请求是从上面进来的，所以「跟随」就是把滚动条按回顶部。
  useEffect(() => {
    if (!follow) return
    const body = bodyRef.current
    if (body) body.scrollTop = 0
  }, [follow, entries])

  // 用键盘切换选中时把那一行带进视野；鼠标点的本来就在视野里，no-op。
  useEffect(() => {
    if (selectedId === null) return
    bodyRef.current?.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, matched.length])

  const arrow = useCallback(
    (delta: number) => {
      if (visible.length === 0) return
      const at = visible.findIndex((entry) => entry.id === selectedId)
      const next = at === -1 ? 0 : Math.min(visible.length - 1, Math.max(0, at + delta))
      onSelect(visible[next].id)
    },
    [visible, selectedId, onSelect],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === 'ArrowDown' || event.key === 'j') {
        event.preventDefault()
        setFollow(false)
        arrow(1)
        return
      }
      if (event.key === 'ArrowUp' || event.key === 'k') {
        event.preventDefault()
        setFollow(false)
        arrow(-1)
        return
      }
      if (event.key === 'Enter' && selectedId !== null) {
        const entry = visible.find((item) => item.id === selectedId)
        if (!entry) return
        event.preventDefault()
        onCreateRule(entry)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [arrow, selectedId, visible, onCreateRule])

  const filtering = query.trim() !== '' || filter !== 'all'

  return (
    <div className="pane list-pane">
      <div className="list-filter">
        <input
          type="search"
          className="filter-input"
          placeholder="过滤 URL 或方法…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="chips">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={item.value === filter ? 'chip active' : 'chip'}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="empty">
          <p className="empty-title">还没有抓到请求</p>
          <ul className="empty-hint">
            <li>页面要在插件装好后刷新过一次才会被接管</li>
            <li>确认右上角总开关是「拦截中」</li>
            <li>只抓 fetch / XMLHttpRequest，图片脚本之类的资源不在范围内</li>
          </ul>
        </div>
      ) : matched.length === 0 ? (
        <div className="empty">
          <p className="empty-title">没有匹配的请求</p>
          <p className="empty-hint">
            当前 {entries.length} 条请求里没有命中筛选条件的。
            <button
              type="button"
              className="link"
              onClick={() => {
                setQuery('')
                setFilter('all')
              }}
            >
              清除筛选
            </button>
          </p>
        </div>
      ) : (
        <>
          <div className="list-head">
            <span className="col-method">方法</span>
            <span className="col-url">URL</span>
            <span className="col-status">状态</span>
            <span className="col-outcome">结果</span>
            <span className="col-time">耗时</span>
            <span className="col-ts">时间</span>
          </div>
          <div className="list-body" ref={bodyRef}>
            {visible.map((entry) => (
              <Row
                key={entry.id}
                entry={entry}
                selected={entry.id === selectedId}
                onSelect={onSelect}
              />
            ))}
            {hidden > 0 && <div className="list-more">还有 {hidden} 条未显示</div>}
          </div>
        </>
      )}

      {entries.length > 0 && (
        <div className="list-foot">
          <span>
            {filtering ? `已过滤 ${matched.length} / ${entries.length} 条` : `共 ${entries.length} 条`}
          </span>
          <label className="follow" title="新请求到达时自动回到最新一条">
            <input
              type="checkbox"
              checked={follow}
              onChange={(event) => setFollow(event.target.checked)}
            />
            跟随最新
          </label>
        </div>
      )}
    </div>
  )
}
