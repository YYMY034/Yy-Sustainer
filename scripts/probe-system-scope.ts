// T72 验证：主提示词是否在所有路径（含带专用 system 的调用）都注入。
// 替换 globalThis.fetch 拦截发往 provider 的请求，直接读请求体（比 undici mock 更直接）。
import { runAgentStream } from "../src/agent/loop.js"

const sse = [
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
  "data: [DONE]\n\n",
].join("")

const captured: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
  if (url.includes("/chat/completions")) {
    const b = init?.body
    captured.push(typeof b === "string" ? b : Buffer.isBuffer(b) ? b.toString("utf8") : b instanceof Uint8Array ? Buffer.from(b).toString("utf8") : "(unreadable body)")
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
  }
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

const run = async (opts: Record<string, unknown>) => {
  captured.length = 0
  await runAgentStream("探针", { cwd: process.cwd(), tools: {}, maxSteps: 1, ...opts }, { onText: () => {}, onStatus: () => {} })
  const raw = captured[0] ?? ""
  const body = raw && raw !== "(unreadable body)" ? JSON.parse(raw) : {}
  const sys = (body.messages ?? []).filter((m: { role: string }) => m.role === "system").map((m: { content: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n")
  return sys
}

const HEAD = "你是 Yy Sustainer，由 YYMY 开发"
const out: Record<string, Record<string, unknown>> = {}

const sys1 = await run({})
out["1 主对话（不传 system）"] = { 含主提示词: sys1.includes(HEAD), 字符数: sys1.length }

const role2 = "你是子代理：只回结论。"
const sys2 = await run({ system: role2 })
out["2 子代理（传专用 system）"] = { 含主提示词: sys2.includes(HEAD), 含作用域声明: sys2.includes("基础层的作用边界"), 角色提示在末尾: sys2.trimEnd().endsWith(role2), 字符数: sys2.length }

const role3 = "你是辅助对话（子代理），在旁边协助用户。"
const sys3 = await run({ system: role3, disableInjection: true })
out["3 辅助对话（system+disableInjection）"] = { 含主提示词: sys3.includes(HEAD), 含作用域声明: sys3.includes("基础层的作用边界"), 角色提示在末尾: sys3.trimEnd().endsWith(role3), 字符数: sys3.length }

const role4 = "你是任务拆分器。只输出 JSON，不要输出任何其他内容。"
const sys4 = await run({ system: role4, disableInjection: true })
out["4 拆分器（禁用 envScan 但注入基础层）"] = { 含主提示词: sys4.includes(HEAD), 含作用域声明: sys4.includes("基础层的作用边界"), 角色在末尾: sys4.trimEnd().endsWith(role4), 字符数: sys4.length }

const sys5 = await run({ systemSuffix: "[环境扫描段占位]" })
out["5 主对话带 systemSuffix"] = { 含主提示词: sys5.includes(HEAD), 含后缀: sys5.includes("[环境扫描段占位]"), 无作用域声明: !sys5.includes("基础层的作用边界"), 字符数: sys5.length }

console.log(JSON.stringify(out, null, 2))
const pass =
  out["1 主对话（不传 system）"].含主提示词 === true &&
  out["2 子代理（传专用 system）"].含主提示词 === true && out["2 子代理（传专用 system）"].角色提示在末尾 === true && out["2 子代理（传专用 system）"].含作用域声明 === true &&
  out["3 辅助对话（system+disableInjection）"].含主提示词 === true && out["3 辅助对话（system+disableInjection）"].角色提示在末尾 === true && out["3 辅助对话（system+disableInjection）"].含作用域声明 === true &&
  out["4 拆分器（禁用 envScan 但注入基础层）"].含主提示词 === true && out["4 拆分器（禁用 envScan 但注入基础层）"].含作用域声明 === true && out["4 拆分器（禁用 envScan 但注入基础层）"].角色在末尾 === true &&
  out["5 主对话带 systemSuffix"].含主提示词 === true && out["5 主对话带 systemSuffix"].含后缀 === true && out["5 主对话带 systemSuffix"].无作用域声明 === true
console.log(pass ? "\n✅ 全部符合预期" : "\n❌ 有不符合项")
globalThis.fetch = realFetch
process.exit(pass ? 0 : 1)
