/**
 * MAIN world 入口：装 hook + 和 bridge 通信。
 *
 * 这个脚本跑在页面自己的 JS 环境里，所以能改到页面用的 window.fetch；
 * 但代价是**没有任何 chrome.* API**，只能靠 postMessage 找 bridge 转发。
 */

import { DEFAULT_CONFIG, MSG_KEY, type Config } from '../shared/protocol'
import { matchRule, newId } from '../shared/rules'
import type { HookContext, ReportPatch } from './context'
import { installFetchHook } from './fetch-hook'
import { installXhrHook } from './xhr-hook'

let config: Config = DEFAULT_CONFIG

/**
 * 本次页面加载随机生成的一次性凭证，用来把「我们自己发的消息」和
 * 站点自己发的 postMessage 区分开。
 *
 * 这是卫生措施，不是安全边界——页面只要愿意，本来就能拿到原始 fetch
 * 绕开 hook。别把它当防线用。
 */
const nonce = newId()

function post(message: unknown): void {
  try {
    // 同窗口 postMessage，targetOrigin 不参与投递判定。
    window.postMessage({ [MSG_KEY]: message }, '*')
  } catch {
    /* 页面可能冻结了 window，忽略 */
  }
}

const ctx: HookContext = {
  match({ url, method }) {
    if (!config.enabled) return null
    return matchRule(config.rules, { url, method })
  },
  report(patch: ReportPatch) {
    post({ t: 'report', nonce, entry: patch })
  },
  captureBodies() {
    return config.captureBodies
  },
}

// 先挂监听再装 hook：bridge 随时可能发 hello 进来，而 hook 必须尽早生效。
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return
  const message = (event.data as Record<string, unknown> | null)?.[MSG_KEY] as
    | { t?: string; nonce?: string; config?: Config }
    | undefined
  if (!message || typeof message !== 'object') return

  if (message.t === 'hello') {
    post({ t: 'ready', nonce })
    return
  }

  if (message.t === 'config' && message.nonce === nonce && message.config) {
    config = message.config
  }
})

installFetchHook(ctx)
installXhrHook(ctx)
