/**
 * 把面板跑起来所需的最小 chrome.* 宿主桩。
 *
 * 面板跑在 DevTools 里，依赖 chrome.devtools / chrome.storage / chrome.runtime。
 * 打上桩之后，构建出来的 panel.js 就能在普通页面里真跑起来——用来写自动化烟测，
 * 也用来人眼看一眼 UI 到底长什么样。
 *
 * 面板代码本身一行都不用改。
 */

;(() => {
  const changeListeners = []
  const portListeners = []
  const writes = []
  let stored = {}

  const preview = {
    /** 面板发给 background 的消息。 */
    sent: [],
    writes,
    port: null,
    getStored: () => stored,

    /**
     * 模拟 background 侧写 storage。
     * 走 onChanged 而不是直接塞进去，和真实路径一致——面板订阅的就是它。
     */
    seed(patch) {
      const changes = {}
      for (const [key, value] of Object.entries(patch)) {
        changes[key] = { oldValue: stored[key], newValue: value }
      }
      stored = { ...stored, ...patch }
      for (const listener of changeListeners) listener(changes, 'local')
    },

    /** 模拟 background 往面板推请求流。 */
    pushFeed(entries, reset) {
      preview.port?.__push({ t: 'feed', entries, reset })
    },
  }

  window.__preview = preview

  Object.defineProperty(window, 'chrome', {
    configurable: true,
    value: {
      devtools: { inspectedWindow: { tabId: 7 }, panels: { create() {} } },
      storage: {
        local: {
          get: async (keys) => {
            const result = {}
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (key in stored) result[key] = stored[key]
            }
            return result
          },
          set: async (patch) => {
            writes.push(patch)
            stored = { ...stored, ...patch }
          },
        },
        onChanged: {
          addListener: (fn) => changeListeners.push(fn),
          removeListener: (fn) => {
            const index = changeListeners.indexOf(fn)
            if (index !== -1) changeListeners.splice(index, 1)
          },
        },
      },
      runtime: {
        id: 'preview',
        connect() {
          portListeners.length = 0
          const port = {
            name: 'api-mock-panel',
            postMessage: (message) => preview.sent.push(message),
            onMessage: { addListener: (fn) => portListeners.push(fn) },
            onDisconnect: { addListener: () => {} },
            disconnect() {},
            __push(message) {
              for (const fn of portListeners) fn(message)
            },
          }
          preview.port = port
          return port
        },
      },
    },
  })
})()
