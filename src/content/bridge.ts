/**
 * ISOLATED world 中继。
 *
 * MAIN world 的 inject 能改页面的 fetch，却没有 chrome.runtime；
 * 这个脚本反过来——有 chrome.runtime，却碰不到页面的 window.fetch。
 * 两个世界各缺一半，靠它把 postMessage 和 Port 缝在一起。
 */

import { MSG_KEY, PAGE_PORT } from '../shared/protocol'

/** 向 inject 打招呼的重试上限：30ms × 100 ≈ 3s，覆盖脚本注入顺序的任何意外。 */
const HELLO_INTERVAL_MS = 30
const HELLO_MAX_ATTEMPTS = 100
const RECONNECT_DELAY_MS = 1000

let nonce: string | null = null
let port: chrome.runtime.Port | null = null
let helloAttempts = 0
let helloTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function post(message: unknown): void {
  try {
    window.postMessage({ [MSG_KEY]: message }, '*')
  } catch {
    /* 忽略 */
  }
}

function extensionAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id)
  } catch {
    // 扩展被卸载/重载后，访问 chrome.runtime 会抛。
    return false
  }
}

function stopHellos(): void {
  if (helloTimer === null) return
  clearInterval(helloTimer)
  helloTimer = null
}

function startHellos(): void {
  if (helloTimer !== null) return
  post({ t: 'hello' })
  helloAttempts = 1
  helloTimer = setInterval(() => {
    if (nonce !== null || helloAttempts >= HELLO_MAX_ATTEMPTS || !extensionAlive()) {
      stopHellos()
      return
    }
    post({ t: 'hello' })
    helloAttempts += 1
  }, HELLO_INTERVAL_MS)
}

function connect(): void {
  if (port || !extensionAlive()) return

  let next: chrome.runtime.Port
  try {
    next = chrome.runtime.connect({ name: PAGE_PORT })
  } catch {
    return
  }
  port = next

  next.onMessage.addListener((message: { t?: string; config?: unknown }) => {
    if (message?.t === 'config' && nonce) {
      post({ t: 'config', nonce, config: message.config })
    }
  })

  next.onDisconnect.addListener(() => {
    port = null
    // MV3 的 service worker 会休眠，端口断开是常态，重连即可。
    if (reconnectTimer !== null) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (extensionAlive()) connect()
    }, RECONNECT_DELAY_MS)
  })

  next.postMessage({ t: 'page-ready' })
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return
  const message = (event.data as Record<string, unknown> | null)?.[MSG_KEY] as
    | { t?: string; nonce?: string; entry?: unknown }
    | undefined
  if (!message || typeof message !== 'object') return

  if (message.t === 'ready') {
    // 只认第一次握手，之后换 nonce 的 ready 一律忽略。
    if (nonce !== null) return
    if (typeof message.nonce !== 'string' || !message.nonce) return
    nonce = message.nonce
    stopHellos()
    connect()
    return
  }

  if (message.t === 'report') {
    if (nonce === null || message.nonce !== nonce) return
    port?.postMessage({ t: 'report', entry: message.entry })
  }
})

startHellos()
