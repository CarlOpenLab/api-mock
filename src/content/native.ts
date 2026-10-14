/**
 * 在模块求值时就把「原生」fetch 抓下来。
 *
 * inject.ts 先 import 这个模块（叶子节点，最先求值），再安装 hook，
 * 所以这里拿到的永远是未被包装的版本。XHR 的改写路径要发真实请求时也用它，
 * 免得撞上我们自己装的 hook 造成递归。
 */
export const nativeFetch: typeof fetch | undefined =
  typeof window !== 'undefined' && typeof window.fetch === 'function'
    ? window.fetch.bind(window)
    : undefined
