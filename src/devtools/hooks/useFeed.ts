import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PANEL_PORT,
  type BackgroundToPanelPort,
  type FeedEntry,
  type PanelPortMessage,
} from '../../shared/protocol'

const MAX_ENTRIES = 500
const RECONNECT_DELAY_MS = 1000

function merge(
  previous: FeedEntry[],
  incoming: FeedEntry[],
  reset: boolean,
): FeedEntry[] {
  const byId = new Map<string, FeedEntry>()
  if (!reset) {
    for (const entry of previous) byId.set(entry.id, entry)
  }
  for (const entry of incoming) {
    const existing = byId.get(entry.id)
    // 两段式上报：同 id 的第二条只带 body，靠合并补到同一条记录上。
    byId.set(entry.id, existing ? { ...existing, ...entry } : entry)
  }

  const list = [...byId.values()].sort((a, b) => b.ts - a.ts)
  return list.length > MAX_ENTRIES ? list.slice(0, MAX_ENTRIES) : list
}

export type FeedState = {
  entries: FeedEntry[]
  connected: boolean
  clear: () => void
}

/** 订阅某个标签页的请求流。 */
export function useFeed(tabId: number): FeedState {
  const [entries, setEntries] = useState<FeedEntry[]>([])
  const [connected, setConnected] = useState(false)
  const portRef = useRef<chrome.runtime.Port | null>(null)

  useEffect(() => {
    let disposed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (disposed) return

      let port: chrome.runtime.Port
      try {
        port = chrome.runtime.connect({ name: PANEL_PORT })
      } catch {
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS)
        return
      }
      portRef.current = port
      setConnected(true)

      port.onMessage.addListener((message: BackgroundToPanelPort) => {
        if (message?.t !== 'feed') return
        setEntries((previous) =>
          merge(previous, message.entries, message.reset === true),
        )
      })

      port.onDisconnect.addListener(() => {
        portRef.current = null
        setConnected(false)
        // MV3 的 service worker 会休眠，断开是常态，重连即可。
        if (disposed) return
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS)
      })

      port.postMessage({ t: 'init', tabId } satisfies PanelPortMessage)
    }

    connect()

    return () => {
      disposed = true
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      portRef.current?.disconnect()
      portRef.current = null
    }
  }, [tabId])

  const clear = useCallback(() => {
    portRef.current?.postMessage({ t: 'clear', tabId } satisfies PanelPortMessage)
  }, [tabId])

  return { entries, connected, clear }
}
