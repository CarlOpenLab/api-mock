/**
 * 每个标签页的请求流缓冲。
 *
 * 放在 background 而不是面板里，是为了扛住页面跳转：面板在导航时不该丢历史。
 * MV3 的 service worker 随时可能休眠，醒来后这份内存就没了——不算事故，
 * 页面刷新后重新抓即可。
 */

import type { FeedEntry, ReportPatch } from '../shared/protocol'

const MAX_ENTRIES_PER_TAB = 500

const feeds = new Map<number, FeedEntry[]>()

export type FeedListener = (tabId: number, entries: FeedEntry[], reset: boolean) => void
const listeners = new Set<FeedListener>()

/**
 * 按 id 插入或合并一条记录。
 * 先报元数据、后补 body 的两段式上报就靠这里的合并。
 */
export function upsert(tabId: number, patch: ReportPatch): FeedEntry {
  const list = feeds.get(tabId) ?? []
  const index = list.findIndex((entry) => entry.id === patch.id)

  let entry: FeedEntry
  if (index === -1) {
    entry = {
      ts: Date.now(),
      url: '',
      method: 'GET',
      transport: 'fetch',
      outcome: 'passthrough',
      ...patch,
    } as FeedEntry
    list.push(entry)
    if (list.length > MAX_ENTRIES_PER_TAB) {
      list.splice(0, list.length - MAX_ENTRIES_PER_TAB)
    }
  } else {
    entry = { ...list[index], ...patch } as FeedEntry
    list[index] = entry
  }

  feeds.set(tabId, list)
  notify(tabId, [entry], false)
  return entry
}

export function snapshot(tabId: number): FeedEntry[] {
  return feeds.get(tabId) ?? []
}

export function clear(tabId: number): void {
  feeds.delete(tabId)
  notify(tabId, [], true)
}

export function drop(tabId: number): void {
  feeds.delete(tabId)
}

export function subscribe(listener: FeedListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify(tabId: number, entries: FeedEntry[], reset: boolean): void {
  for (const listener of listeners) {
    try {
      listener(tabId, entries, reset)
    } catch {
      // 单个监听器抛错不该影响其他监听器。
    }
  }
}
