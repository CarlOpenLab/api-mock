/** 规则与设置的持久化。面板直接读写 storage，background 靠 onChanged 感知并广播。 */

import type { Config } from '../shared/protocol'
import type { Rule } from '../shared/rules'
import {
  DEFAULT_SETTINGS,
  RULES_KEY,
  SETTINGS_KEY,
  type Settings,
} from '../shared/storage'

export { RULES_KEY, SETTINGS_KEY, DEFAULT_SETTINGS }
export type { Settings }

export async function readConfig(): Promise<Config> {
  const stored = await chrome.storage.local.get([RULES_KEY, SETTINGS_KEY])
  const rules = Array.isArray(stored[RULES_KEY]) ? (stored[RULES_KEY] as Rule[]) : []
  const raw = stored[SETTINGS_KEY] as Partial<Settings> | undefined

  return {
    rules,
    enabled: raw?.enabled ?? DEFAULT_SETTINGS.enabled,
    captureBodies: raw?.captureBodies ?? DEFAULT_SETTINGS.captureBodies,
  }
}

export async function readRules(): Promise<Rule[]> {
  const stored = await chrome.storage.local.get(RULES_KEY)
  return Array.isArray(stored[RULES_KEY]) ? (stored[RULES_KEY] as Rule[]) : []
}

export async function writeRules(rules: Rule[]): Promise<void> {
  await chrome.storage.local.set({ [RULES_KEY]: rules })
}

export async function readSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY)
  const raw = stored[SETTINGS_KEY] as Partial<Settings> | undefined
  return { ...DEFAULT_SETTINGS, ...raw }
}

export async function writeSettings(patch: Partial<Settings>): Promise<void> {
  const current = await readSettings()
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...patch } })
}

/** 判断一条 storage 变更是否影响页面侧的行为，需要重新下发配置。 */
export function isConfigChange(
  changes: Record<string, chrome.storage.StorageChange>,
): boolean {
  return RULES_KEY in changes || SETTINGS_KEY in changes
}
