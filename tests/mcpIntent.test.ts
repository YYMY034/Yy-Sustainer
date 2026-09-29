/**
 * MCP 按需加载的意图判定守卫。
 *
 * 起因：白皮书 10.29 拆解出每步固定开销 22k token 里 **4.3k 是 35 个 MCP 浏览器
 * 工具的 schema**——而 ensureDefaultMcpServers() 给每个新用户默认种下两个浏览器
 * 服务器，纯文件/编码任务永远用不到，每一步都在白付。
 *
 * 盯四件事：
 *   ① 明确指向浏览器/网页操作的表达必须命中（漏判 = 任务做不了）
 *   ② 泛词不命中（「这个页面很慢」是代码任务——误加载只多花 token，但能省则省）
 *   ③ override 三态：手动开/手动关优先于意图自动判
 *   ④ 判定理由是人话——进 envScan 文案，出问题能一眼看出为什么
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_MCP_KEYWORDS, hasMcpIntent, resolveMcpLoading } from "../src/mcp/intent.js"

test("明确指向浏览器/网页操作的表达必须命中", () => {
  const mustHit = [
    "帮我用浏览器打开 https://example.com",
    "这个网页打不开，帮我看看",
    "打开这个网址",
    "去网站上把这张图截个图",
    "点击页面上的提交按钮",
    "自动填写表单并提交",
    "爬取这个网站的商品价格",
    "模拟登录后台",
    "open the browser and search",
    "take a screenshot of the webpage",
    "用 Playwright 跑个自动化",
  ]
  for (const t of mustHit) {
    assert.ok(hasMcpIntent(t), `漏判：「${t}」应当命中浏览器意图`)
  }
})

test("泛词不命中（代码/文件任务不该拖出 35 个浏览器工具）", () => {
  const mustMiss = [
    "这个页面加载很慢，帮我优化",
    "帮我重构 src/agent/loop.ts",
    "设计的原则有哪些",
    "在吗",
    "帮我把这个文件转成 pdf",
    "跑一下测试套件",
    "edge case 覆盖一下",
    "数据库连接池配置一下",
  ]
  for (const t of mustMiss) {
    assert.equal(hasMcpIntent(t), undefined, `误判：「${t}」不应当命中`)
  }
})

test("边界词的有意取舍：宁多命中，不漏（写爬虫/带链接都算浏览器意图）", () => {
  // 「爬虫」：写脚本也可能要浏览器（JS 渲染页），且用户说「只写思路」时代价仅是多带工具
  assert.ok(hasMcpIntent("写个爬虫脚本"))
  // 「链接」：中文里常指 URL；「软链接」等误命中的代价同样只是多带工具
  assert.ok(hasMcpIntent("这个链接打不开"))
  assert.ok(hasMcpIntent("ln -s 建个软链接") === "链接", "确认这是已知的代价，不是没看到")
})

test("override 优先于意图自动判（手动开的产品决策）", () => {
  // 手动开：没命中意图也加载
  const on = resolveMcpLoading("帮我看下这个文件", true)
  assert.equal(on.load, true)
  assert.ok(on.reason.includes("手动开启"), on.reason)
  // 手动关：命中了意图也不加载
  const off = resolveMcpLoading("用浏览器打开网页", false)
  assert.equal(off.load, false)
  assert.ok(off.reason.includes("手动关闭"), off.reason)
  // 不override：按意图
  assert.equal(resolveMcpLoading("用浏览器打开", undefined).load, true)
  assert.equal(resolveMcpLoading("改个 bug", undefined).load, false)
})

test("判定理由是人话，且带命中的词（envScan 文案直接用）", () => {
  const d = resolveMcpLoading("爬取这个网站", undefined)
  assert.equal(d.load, true)
  assert.equal(d.matched, "爬取")
  assert.ok(d.reason.includes("爬取"), d.reason)
  const miss = resolveMcpLoading("你好", undefined)
  assert.equal(miss.matched, undefined)
  assert.ok(miss.reason.length > 0, "没命中也要有原因")
})

test("空文本与大小写：不炸、不误判", () => {
  assert.equal(hasMcpIntent(""), undefined)
  assert.equal(hasMcpIntent(undefined as unknown as string), undefined)
  // 大小写不敏感：英文词必须能命中大写形态
  assert.ok(hasMcpIntent("Open The Browser"))
  assert.ok(hasMcpIntent("PLAYWRIGHT test"))
})

test("关键词表没有重复项（重复项是手工维护漂移的第一信号）", () => {
  const seen = new Set<string>()
  for (const k of DEFAULT_MCP_KEYWORDS) {
    assert.ok(!seen.has(k), `关键词重复：${k}`)
    seen.add(k)
    assert.ok(k === k.toLowerCase(), `关键词应统一小写（匹配时已 toLowerCase，表里混大小写必然漏）：${k}`)
  }
})
