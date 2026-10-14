/**
 * MAIN world 与 ISOLATED world 之间、以及页面与 background 之间的消息形状。
 *
 * MAIN world 的脚本没有 chrome.* API，ISOLATED world 的脚本读不到页面的
 * window.fetch，两者各缺一半，只能靠 window.postMessage 缝合。
 */

import type { Rule } from './rules'

/** 挂在 window 消息外层的命名空间，避免和站点自己的 postMessage 撞车。 */
export const MSG_KEY = '__api_mock__' as const

/** background 下发给页面的配置。 */
export type Config = {
  rules: Rule[]
  /** 总开关。关掉时所有请求原样放行。 */
  enabled: boolean
  /** 是否抓取未命中规则的请求/响应体。关掉可消除全部额外开销。 */
  captureBodies: boolean
}

export const DEFAULT_CONFIG: Config = {
  rules: [],
  enabled: true,
  captureBodies: true,
}

/** 页面脚本上报的一次请求。 */
export type FeedEntry = {
  id: string
  url: string
  method: string
  ts: number
  /** 应用最终拿到的是什么。 */
  outcome: 'passthrough' | 'rewritten' | 'mocked' | 'failed'
  /** 'fetch' | 'xhr' */
  transport: 'fetch' | 'xhr'
  /** 应用看到的状态码（被改写后的）。失败时为 0。 */
  status?: number
  /** 网络层真实返回的状态码。直接伪造时为 undefined。 */
  realStatus?: number
  ruleId?: string
  ruleName?: string
  /** 网络耗时，不含人为延迟。 */
  durationMs?: number
  /** 含人为延迟的总耗时。 */
  totalMs?: number
  error?: string
  requestHeaders?: Record<string, string>
  requestBody?: string
  responseHeaders?: Record<string, string>
  responseBody?: string
  /** 采集时被截断的原始字节数。 */
  truncatedFrom?: number
}

/**
 * 上报的载荷。同一个 id 会被 background 合并，所以可以先报元数据、
 * 稍后补上 body —— 面板那边看到的是一条记录被填充，而不是两条。
 */
export type ReportPatch = Partial<FeedEntry> & { id: string }

/** 页面 → bridge。 */
export type PageOutMessage =
  | { t: 'ready'; nonce: string }
  | { t: 'report'; nonce: string; entry: ReportPatch }

/** bridge → 页面。 */
export type PageInMessage =
  | { t: 'hello' }
  | { t: 'config'; nonce: string; config: Config }

/** 页面 ↔ background（Port 名）。 */
export const PAGE_PORT = 'api-mock-page'
/** 面板 ↔ background（Port 名）。 */
export const PANEL_PORT = 'api-mock-panel'

/** bridge → background。 */
export type PagePortMessage =
  | { t: 'page-ready' }
  | { t: 'report'; entry: ReportPatch }

/** background → bridge。 */
export type BackgroundToPagePort = { t: 'config'; config: Config }

/** 面板 → background。 */
export type PanelPortMessage =
  | { t: 'init'; tabId: number }
  | { t: 'clear'; tabId: number }

/** background → 面板。feed 是增量合并；reset 表示整体替换。 */
export type BackgroundToPanelPort =
  | { t: 'feed'; entries: FeedEntry[]; reset?: false }
  | { t: 'feed'; entries: FeedEntry[]; reset: true }
