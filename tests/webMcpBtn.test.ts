/**
 * Web UI「浏览器工具三态按钮」的无头行为测试（白皮书 10.29/10.32）。
 *
 * 为什么需要：三态按钮的真浏览器 E2E 一直被沙箱网络堵着（agent-browser 的 196MB
 * Chromium 从 GitHub 下载 21 分钟没落一个字节——和记忆里「隧道建得起、数据不动」
 * 的沙箱限制同型）。但按钮的逻辑（渲染/循环/fetch 载荷/兜底）是纯 JS，可以在 node 里
 * 用最小 DOM 桩确定性验证——真浏览器只多验一层像素渲染。
 *
 * 做法：从 web/index.html 抽出三态代码块（按标记定位，标记没了就大声失败——
 * 逼后来的人 conscious 更新，而不是静默跳过），在 new Function 里用桩执行。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const web = readFileSync(fileURLToPath(new URL("../web/index.html", import.meta.url)), "utf8")

/** 抽三态代码块：从 `let mcpOn = null` 到下一个section注释之前 */
function extractBlock(): string {
  const start = web.indexOf("let mcpOn = null")
  const end = web.indexOf("// T93 P2 断点恢复")
  assert.ok(start > 0 && end > start, "抽不到三态代码块——标记变了？来本文件更新抽取边界（别静默跳过）")
  return web.slice(start, end)
}

/** 最小 DOM 桩：只实现按钮用到的面 */
function makeStubs(log: Array<{ url: string; method: string; body?: string }>) {
  const btn = { textContent: "", title: "", classes: new Set<string>(), onclick: null as unknown, classList: { toggle: (c: string, on: boolean) => { on ? btn.classes.add(c) : btn.classes.delete(c) } } }
  const status = { textContent: "" }
  const $ = (id: string): unknown => (id === "mcpBtn" ? btn : id === "status" ? status : null)
  const fetchStub = async (url: string, opts?: { method?: string; body?: string }): Promise<unknown> => {
    log.push({ url, method: opts?.method ?? "GET", body: opts?.body })
    return { ok: true, json: async () => fetchStub.responder(url, opts) }
  }
  // responder 可在测试里换（返回什么 JSON / 抛什么错）
  fetchStub.responder = (_url: string, _opts?: { method?: string; body?: string }): unknown => ({ on: null })
  return { $, fetchStub, btn, status }
}

test("三态按钮：自动→开→关→自动 的完整循环（标签/class/状态文案/fetch 载荷）", async () => {
  const log: Array<{ url: string; method: string; body?: string }> = []
  const { $, fetchStub, btn, status } = makeStubs(log)
  const api = new Function("$", "fetch", "activeId", extractBlock() + `
; return { sync: syncMcpState, click: () => $("mcpBtn").onclick() }
`) as unknown as ($: unknown, f: unknown, a: string) => { sync: () => Promise<void>; click: () => Promise<void> }
  const { sync, click } = api($, fetchStub, "sid-1")

  // ① 初始同步：GET 返回 on:null（自动态）
  fetchStub.responder = () => ({ on: null })
  await sync()
  assert.equal(btn.textContent, "浏览器:自动", "自动态标签")
  assert.equal(btn.classes.has("active"), false, "自动态不高亮")
  assert.equal(btn.classes.has("off"), false, "自动态不置灰")
  assert.equal(log.at(-1)?.url, "/api/sessions/sid-1/mcp", "同步走嵌套路由")
  assert.equal(log.at(-1)?.method, "GET")

  // ② 点第一下：null → true（开）
  fetchStub.responder = () => ({ on: true })
  await click()
  assert.equal(btn.textContent, "浏览器:开", "开态标签")
  assert.equal(btn.classes.has("active"), true, "开态要高亮")
  assert.ok(status.textContent.includes("每轮都加载"), status.textContent)
  assert.equal(log.at(-1)?.body, '{"on":true}', "第一跳载荷 on:true")
  assert.equal(log.at(-1)?.method, "POST")

  // ③ 点第二下：true → false（关）
  fetchStub.responder = () => ({ on: false })
  await click()
  assert.equal(btn.textContent, "浏览器:关", "关态标签")
  assert.equal(btn.classes.has("off"), true, "关态要置灰（和自动态区分）")
  assert.ok(status.textContent.includes("不加载"), status.textContent)
  assert.equal(log.at(-1)?.body, '{"on":false}')

  // ④ 点第三下：false → null（回自动）
  fetchStub.responder = () => ({ on: null })
  await click()
  assert.equal(btn.textContent, "浏览器:自动", "回到自动态")
  assert.equal(btn.classes.has("active") || btn.classes.has("off"), false, "自动态两个 class 都没有")
  assert.equal(log.at(-1)?.body, '{"on":null}', "回自动的载荷是 on:null（不是省略字段）")
})

test("兜底：没会话不请求；fetch 挂了标签不变（不因网络抖动乱显状态）", async () => {
  const log: Array<{ url: string; method: string; body?: string }> = []
  const { $, fetchStub, btn, status } = makeStubs(log)
  const api = new Function("$", "fetch", "activeId", extractBlock() + `
; return { sync: syncMcpState, click: () => $("mcpBtn").onclick() }
`) as unknown as ($: unknown, f: unknown, a: string) => { sync: () => Promise<void>; click: () => Promise<void> }
  const noSession = api($, fetchStub, "")
  await noSession.sync()
  await noSession.click()
  assert.equal(log.length, 0, "没会话一个请求都不该发")
  assert.equal(status.textContent, "先选择一个会话", "点了要提示先选会话")

  // fetch 挂：标签保持上一次的值
  const { sync, click } = api($, fetchStub, "sid-2")
  fetchStub.responder = () => ({ on: true })
  await sync() // 先同步成「开」
  assert.equal(btn.textContent, "浏览器:开")
  const before = btn.textContent
  ;(fetchStub as unknown as { responder: () => unknown }).responder = () => { throw new Error("network down") }
  await click() // 点击时网络挂 → catch 静默，标签不能变
  assert.equal(btn.textContent, before, "网络挂了标签不能变（静默兜底）")
})
