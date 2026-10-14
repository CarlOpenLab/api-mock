/**
 * 面板冒烟：在普通页面里把构建出来的 panel.js 真跑起来，走一遍主要交互。
 *
 * 覆盖的是「渲染得出来、点得动、写对了地方」这一类只有运行期才暴露的问题：
 * 组件里字段写错、hooks 依赖搞乱、storage 键对不上，单测都看不见。
 */

const smoke = window.__preview
const results = []

function record(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : String(detail ?? '') })
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(30)
  }
  return null
}

const text = () => document.body.textContent ?? ''

function byText(selector, needle) {
  return [...document.querySelectorAll(selector)].find((el) =>
    (el.textContent ?? '').includes(needle),
  )
}

/** 按标题找详情页里的一个区块（响应头 / 响应体 / 请求头 / 请求体）。 */
function section(title) {
  return [...document.querySelectorAll('.section')].find((el) =>
    (el.querySelector('.section-title')?.textContent ?? '').includes(title),
  )
}

/** React 受控组件不认直接赋值，得走原生 setter + input 事件。 */
function typeInto(element, value) {
  const descriptor = Object.getOwnPropertyDescriptor(
    element.constructor.prototype,
    'value',
  )
  descriptor.set.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

const ENTRY = {
  id: 'e1',
  ts: Date.now(),
  url: 'https://api.example.com/v1/list?page=1',
  method: 'GET',
  transport: 'fetch',
  outcome: 'rewritten',
  status: 200,
  realStatus: 200,
  ruleId: 'r1',
  ruleName: '空列表',
  durationMs: 12,
  totalMs: 12,
  requestHeaders: { accept: 'application/json' },
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: '{"data":[]}',
}

async function main() {
  await waitFor(() => document.querySelector('.toolbar'))
  record('面板渲染出工具条', Boolean(document.querySelector('.toolbar')))

  record('请求页初始是空状态', text().includes('还没有抓到请求'))
  record('两个页签都在', Boolean(byText('.tab', '请求')) && Boolean(byText('.tab', '规则')))
  record('总开关显示「拦截中」', text().includes('拦截中'))

  // ── 请求流 ──
  const port = await waitFor(() => smoke.port)
  record('面板连上了 background 端口', Boolean(port))
  record('端口初始化时带上了 tabId', smoke.sent.some((m) => m.t === 'init' && m.tabId === 7))

  port.__push({ t: 'feed', entries: [ENTRY] })
  await sleep(80)
  record('请求流渲染出一行', document.querySelectorAll('.row').length === 1)
  record('行里显示 URL 的 path 部分', text().includes('/v1/list?page=1'))
  record('行里显示改写结果', text().includes('改写'))

  document.querySelector('.row').click()
  await sleep(80)
  record('点开详情显示完整 URL', text().includes('https://api.example.com/v1/list?page=1'))
  record('详情区分了「应用看到的状态码」', text().includes('应用看到的状态码'))

  // ── 响应体：默认美化，但必须能切回原始字节 ──
  const bodyCode = () => section('响应体')?.querySelector('.code')?.textContent ?? ''
  record('响应体自动美化了 JSON', bodyCode().includes('"data": []'), bodyCode().slice(0, 40))

  section('响应体')?.querySelector('.code-toggle')?.click()
  await sleep(60)
  record('切回原文就是应用收到的字节', bodyCode().includes('{"data":[]}'), bodyCode().slice(0, 40))

  section('响应体')?.querySelector('.code-toggle')?.click()
  await sleep(60)
  record('能再切回格式化', bodyCode().includes('"data": []'), bodyCode().slice(0, 40))

  // ── 区块折叠 ──
  record('区块默认展开', Boolean(section('响应头')?.querySelector('.code')))
  section('响应头')?.querySelector('.section-toggle')?.click()
  await sleep(60)
  record('点标题能折叠区块', section('响应头')?.querySelector('.code') === null)
  section('响应头')?.querySelector('.section-toggle')?.click()
  await sleep(60)
  record('再点能展开回来', Boolean(section('响应头')?.querySelector('.code')))

  // ── 分隔条 ──
  record('两栏之间有可拖拽的分隔条', Boolean(document.querySelector('[role="separator"]')))

  // ── 以此请求建规则 ──
  byText('button', '以此请求建规则').click()
  await sleep(120)
  record('跳到规则页并打开编辑器', Boolean(document.querySelector('.editor-pane')))
  record('URL 模式自动填好（并丢掉 query）', text().includes('https://api.example.com/v1/list*'))
  record('方法自动填成 GET', Boolean(byText('.seg-item, .input', 'GET')) || text().includes('GET'))

  await waitFor(() => (smoke.getStored()['api-mock:rules'] ?? []).length === 1)
  const created = (smoke.getStored()['api-mock:rules'] ?? [])[0]
  record('新规则写进了 storage', created !== undefined, JSON.stringify(smoke.getStored()))
  record('新规则的 path 通配正确', created?.match?.urlPattern === 'https://api.example.com/v1/list*', created?.match?.urlPattern)
  record('新规则默认是合并 JSON', created?.action?.bodyMode === 'merge-json', created?.action?.bodyMode)

  // ── 编辑与保存 ──
  const statusInput = [...document.querySelectorAll('.input')].find(
    (el) => el.getAttribute('placeholder') === '不改',
  )
  record('编辑器里有状态码输入框', Boolean(statusInput))
  typeInto(statusInput, '500')
  await sleep(60)

  const bodyArea = document.querySelector('.code-textarea')
  typeInto(bodyArea, '{"data":[],"patched":true}')
  await sleep(60)

  byText('button', '保存').click()
  await waitFor(() => (smoke.getStored()['api-mock:rules'] ?? [])[0]?.action?.status === 500)
  const saved = (smoke.getStored()['api-mock:rules'] ?? [])[0]
  record('保存写入了状态码', saved?.action?.status === 500, String(saved?.action?.status))
  record('保存写入了响应体', saved?.action?.body?.text === '{"data":[],"patched":true}', saved?.action?.body?.text)

  // ── 校验挡住非法输入 ──
  typeInto(statusInput, '99')
  await sleep(60)
  const saveButton = byText('.editor-actions button', '保存')
  record('状态码超范围时禁用保存', saveButton.disabled === true)
  typeInto(statusInput, '500')
  await sleep(60)
  record('改回合法值后恢复可保存', byText('.editor-actions button', '保存').disabled === false)

  // ── 启停与删除 ──
  document.querySelector('.checkbox').click()
  await waitFor(() => smoke.getStored()['api-mock:rules']?.[0]?.enabled === false)
  record('取消勾选把规则停用并落库', smoke.getStored()['api-mock:rules'][0].enabled === false)

  byText('.rule-actions button, .icon-btn', '✕').click()
  await waitFor(() => (smoke.getStored()['api-mock:rules'] ?? []).length === 0)
  record('删除规则并落库', (smoke.getStored()['api-mock:rules'] ?? []).length === 0)
  record('删除后回到空状态', text().includes('还没有规则'))

  // ── 总开关 ──
  byText('.switch', '拦截中').click()
  await waitFor(() => smoke.getStored()['api-mock:settings']?.enabled === false)
  record('总开关落库', smoke.getStored()['api-mock:settings'].enabled === false)

  // ── 清空 ──
  byText('.toolbar-actions button', '清空').click()
  await sleep(80)
  record('清空会通知 background', smoke.sent.some((m) => m.t === 'clear' && m.tabId === 7))

  // ── 再推一条，验证 reset 语义 ──
  // 上一步已经把规则删光了，但当前还停在「规则」页；先切回请求页再数行。
  byText('.tab', '请求').click()
  await sleep(80)
  port.__push({ t: 'feed', entries: [ENTRY], reset: true })
  await sleep(80)
  record('reset 后请求流是干净的一条', document.querySelectorAll('.row').length === 1, `实际 ${document.querySelectorAll('.row').length} 行`)

  // ── 筛选 ──
  const mixed = [
    { ...ENTRY, id: 'f1', url: 'https://api.example.com/v1/orders', outcome: 'rewritten' },
    { ...ENTRY, id: 'f2', url: 'https://api.example.com/v1/flags', outcome: 'mocked' },
    { ...ENTRY, id: 'f3', url: 'https://api.example.com/v1/recs', outcome: 'failed', status: 0, error: 'network-error' },
  ]
  const rows = () => document.querySelectorAll('.row').length

  port.__push({ t: 'feed', entries: mixed, reset: true })
  await sleep(80)
  record('推入 3 条不同结果的请求', rows() === 3, `${rows()} 行`)

  typeInto(document.querySelector('.filter-input'), 'flags')
  await sleep(80)
  record('按关键词过滤只剩命中行', rows() === 1, `${rows()} 行`)
  record('过滤后底部显示条数', text().includes('已过滤 1 / 3'))

  typeInto(document.querySelector('.filter-input'), '不存在的路径')
  await sleep(80)
  record('过滤到空时给出提示', text().includes('没有匹配的请求'))

  byText('button', '清除筛选')?.click()
  await sleep(80)
  record('清除筛选后恢复全部', rows() === 3, `${rows()} 行`)

  byText('.chip', '失败').click()
  await sleep(80)
  record('按结果筛选只剩失败那条', rows() === 1 && text().includes('/v1/recs'), `${rows()} 行`)

  byText('.chip', '全部').click()
  await sleep(80)
  record('切回「全部」显示 3 条', rows() === 3, `${rows()} 行`)

  // ── 键盘 ──
  // 直接派发到 window：处理函数挂在那儿，且 target 不是输入框。
  const press = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

  press('ArrowDown')
  await sleep(60)
  record('↓ 选中第一行', Boolean(document.querySelector('.row.selected')))

  press('Escape')
  await sleep(60)
  record('Esc 取消选中', document.querySelector('.row.selected') === null)

  press('ArrowDown')
  await sleep(60)
  const rulesBefore = (smoke.getStored()['api-mock:rules'] ?? []).length
  press('Enter')
  await sleep(140)
  const rulesAfter = (smoke.getStored()['api-mock:rules'] ?? []).length
  record('Enter 以此请求建规则', rulesAfter === rulesBefore + 1, `${rulesBefore} → ${rulesAfter}`)
}

async function finish(error) {
  if (error) record('执行过程没有抛异常', false, error?.stack ?? String(error))

  const failed = results.filter((item) => !item.ok)
  document.getElementById('out').textContent = results
    .map((item) => `${item.ok ? '✓' : '✗'} ${item.name}${item.detail ? `  — ${item.detail}` : ''}`)
    .join('\n')

  try {
    await fetch('/__results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ suite: 'panel', results }),
    })
  } catch {
    /* 服务器不在了就算了 */
  }
}

const watchdog = setTimeout(() => void finish(new Error('超时：15s 内没跑完')), 15000)

main()
  .then(() => finish())
  .catch((error) => finish(error))
  .finally(() => clearTimeout(watchdog))
