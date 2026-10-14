import { useRef } from 'react'
import type { Rule } from '../../shared/rules'
import type { Settings } from '../../shared/storage'
import { Switch } from './Field'

export type PanelTab = 'requests' | 'rules'

export function Toolbar({
  tab,
  onTab,
  requestCount,
  ruleCount,
  settings,
  onSettings,
  connected,
  onClear,
  rules,
  onImport,
}: {
  tab: PanelTab
  onTab: (next: PanelTab) => void
  requestCount: number
  ruleCount: number
  settings: Settings
  onSettings: (patch: Partial<Settings>) => void
  connected: boolean
  onClear: () => void
  rules: Rule[]
  onImport: (rules: Rule[]) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <header className="toolbar">
      <nav className="tabs">
        <button
          type="button"
          className={tab === 'requests' ? 'tab active' : 'tab'}
          onClick={() => onTab('requests')}
        >
          请求 <span className="badge">{requestCount}</span>
        </button>
        <button
          type="button"
          className={tab === 'rules' ? 'tab active' : 'tab'}
          onClick={() => onTab('rules')}
        >
          规则 <span className="badge">{ruleCount}</span>
        </button>
      </nav>

      <div className="toolbar-actions">
        <Switch
          label={settings.enabled ? '拦截中' : '已暂停'}
          title="总开关：关掉后所有请求原样放行"
          checked={settings.enabled}
          onChange={(enabled) => onSettings({ enabled })}
        />
        <Switch
          label="采集 Body"
          title="抓取未命中规则的请求/响应体。关掉可消除全部额外开销；流式响应（SSE）始终不采集。"
          checked={settings.captureBodies}
          onChange={(captureBodies) => onSettings({ captureBodies })}
        />

        <span className={connected ? 'conn ok' : 'conn bad'} title={connected ? '已连上 background' : '未连上 background，正在重试'}>
          ●
        </span>

        <button type="button" className="btn" onClick={onClear}>
          清空
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => exportRules(rules)}
          disabled={rules.length === 0}
        >
          导出
        </button>
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          导入
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void importRules(file, onImport)
          }}
        />
      </div>
    </header>
  )
}

function exportRules(rules: Rule[]): void {
  const blob = new Blob([JSON.stringify(rules, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'api-mock-rules.json'
  anchor.click()
  URL.revokeObjectURL(url)
}

async function importRules(
  file: File,
  onImport: (rules: Rule[]) => void,
): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(await file.text())
    if (!Array.isArray(parsed)) {
      window.alert('导入失败：文件顶层应该是一个规则数组。')
      return
    }
    onImport(parsed as Rule[])
  } catch (error) {
    window.alert(`导入失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
