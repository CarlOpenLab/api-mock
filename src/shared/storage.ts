/**
 * storage 的键与形状。
 *
 * 单独放一份在这里，是为了让面板不必 import background 的代码——面板只认
 * 这两个键，不关心 background 怎么消费它们。
 */

import type { Rule } from './rules'

export const RULES_KEY = 'api-mock:rules'
export const SETTINGS_KEY = 'api-mock:settings'

export type Settings = {
  /** 总开关。关掉时所有请求原样放行。 */
  enabled: boolean
  /** 是否采集未命中规则的请求/响应体。关掉可消除全部额外开销。 */
  captureBodies: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  captureBodies: true,
}

export const EMPTY_RULES: Rule[] = []
