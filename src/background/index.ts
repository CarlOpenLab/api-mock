/**
 * MV3 service worker：配置下发 + 请求流中转。
 *
 * 它不参与任何一次请求的决策——页面里的 hook 自己拿着规则副本同步匹配，
 * 因为决策必须是同步的（XHR 的同步模式不允许 await），而且每次请求都往返
 * 一趟消息会白白加延迟。background 在这里只做「存」和「广播」。
 */

import {
  PAGE_PORT,
  PANEL_PORT,
  type BackgroundToPagePort,
  type BackgroundToPanelPort,
  type PagePortMessage,
  type PanelPortMessage,
} from '../shared/protocol'
import * as feed from './feed'
import { isConfigChange, readConfig } from './store'

const pagePorts = new Set<chrome.runtime.Port>()
const panelPorts = new Map<chrome.runtime.Port, number>()

async function pushConfigToPages(): Promise<void> {
  const message: BackgroundToPagePort = { t: 'config', config: await readConfig() }
  for (const port of [...pagePorts]) {
    try {
      port.postMessage(message)
    } catch {
      pagePorts.delete(port)
    }
  }
}

feed.subscribe((tabId, entries, reset) => {
  const message: BackgroundToPanelPort = reset
    ? { t: 'feed', entries, reset: true }
    : { t: 'feed', entries }

  for (const [port, portTabId] of [...panelPorts]) {
    if (portTabId !== tabId) continue
    try {
      port.postMessage(message)
    } catch {
      panelPorts.delete(port)
    }
  }
})

function handlePagePort(port: chrome.runtime.Port): void {
  pagePorts.add(port)

  port.onDisconnect.addListener(() => {
    pagePorts.delete(port)
  })

  port.onMessage.addListener((message: PagePortMessage) => {
    if (message?.t === 'page-ready') {
      void readConfig().then((config) => {
        try {
          port.postMessage({ t: 'config', config } satisfies BackgroundToPagePort)
        } catch {
          /* 端口已断，忽略 */
        }
      })
      return
    }

    if (message?.t === 'report' && message.entry) {
      const tabId = port.sender?.tab?.id
      if (tabId === undefined) return
      feed.upsert(tabId, message.entry)
    }
  })
}

function handlePanelPort(port: chrome.runtime.Port): void {
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port)
  })

  port.onMessage.addListener((message: PanelPortMessage) => {
    if (message?.t === 'init') {
      panelPorts.set(port, message.tabId)
      try {
        port.postMessage({
          t: 'feed',
          entries: feed.snapshot(message.tabId),
          reset: true,
        } satisfies BackgroundToPanelPort)
      } catch {
        panelPorts.delete(port)
      }
      return
    }

    if (message?.t === 'clear') {
      feed.clear(message.tabId)
    }
  })
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PAGE_PORT) handlePagePort(port)
  else if (port.name === PANEL_PORT) handlePanelPort(port)
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !isConfigChange(changes)) return
  void pushConfigToPages()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  feed.drop(tabId)
})
