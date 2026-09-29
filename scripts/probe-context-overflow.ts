/**
 * T93 P3 活体探针（不随 run-all-checks 跑）：
 *
 *   npx tsx scripts/probe-context-overflow.ts
 *
 * 验证「上下文超长不再等于任务死亡」：
 *   ① 假 provider 在历史很长时返回 context_length_exceeded，之后恢复正常
 *      → 任务应自己压缩历史后跑完，用户看到的是完成，不是报错
 *   ② 假 provider **一直**返回超长
 *      → 只压一次就停，落库的失败文案说清该调什么（而不是「不支持所选参数」）
 *   ③ 假 provider 在**工具结果之后**才超限（executed>0）
 *      → 不得整轮重发（那会把工具再跑一遍），必须带上病因失败
 */
import { createServer, type Server } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-co-"))
const PORT = await pickFreePort()
const FAKE_PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`
const WORK = join(HOME, "work")
const TARGET = join(WORK, "out.txt")

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

/** 模式：recover = 第一次超长后恢复；always = 一直超长；afterTool = 工具结果之后才超长 */
let mode: "recover" | "always" | "afterTool" = "recover"
let calls = 0

function fakeProvider(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
  if (req.url?.includes("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ data: [{ id: "m1" }] }))
    return
  }
  let raw = ""
  req.on("data", (c) => { raw += String(c) })
  req.on("end", () => {
    let messages: Array<{ role: string; content: unknown }> = []
    try { messages = (JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [] } catch { /* 按没有 */ }
    calls++
    const hasToolResult = messages.some((m) => m.role === "tool")
    const historyChars = messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0)
    // 压缩摘要请求不演超长——真provider 答得了摘要，演了就等于「压不动」，
    // 测的就不是恢复而是另一个故障了
    const isSummarizer = messages.some((m) => m.role === "system" && String(m.content).includes("历史压缩器"))
    // 历史够长就演一次「窗口太小」
    const overflow = !isSummarizer && historyChars > 2000 && (mode === "always" || (mode === "recover" ? calls <= 2 : hasToolResult))
    const err = (msg: string, status: number): string =>
      `data: ${JSON.stringify({ error: { message: msg, type: "invalid_request_error", code: "context_length_exceeded" } })}\n\n`
    const chunk = (delta: unknown, finish?: string, usage?: unknown): string =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(usage ? { usage } : {}) })}\n\n`
    // 压缩走 generateText（stream:false），主对话走 streamText（stream:true）。
    // 一律回 SSE 会让 generateText 报 "Invalid JSON response"、压缩永远失败——
    // 第一版探针就这么错的，表现是「恢复跑了但压不动」。
    // generateText 不带 stream:true（期望纯 JSON），streamText 带（期望 SSE）。
    // 判错方向的代价是压缩永远失败（AI_JSONParseError），第一版探针就这么错的。
    let stream = false
    try { stream = (JSON.parse(raw) as { stream?: boolean }).stream === true } catch { /* 按非流式 */ }

    if (overflow) {
      if (stream) {
        res.writeHead(400, { "Content-Type": "text/event-stream" })
        res.write(err(`This model's maximum context length is 2048 tokens. However, your messages resulted in ${historyChars} tokens.`, 400))
        res.write("data: [DONE]\n\n")
      } else {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message: `This model's maximum context length is 2048 tokens. However, your messages resulted in ${historyChars} tokens.`, type: "invalid_request_error", code: "context_length_exceeded" } }))
      }
      res.end()
      return
    }

    const summaryText = "【摘要】前 12 轮在反复记录背景信息，结论待写入 out.txt。"
    if (isSummarizer) {
      // 摘要请求回一段**文本**——回工具调用会让 generateText 拿不到 text，压不动
      if (stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(chunk({ role: "assistant", content: "" }))
        res.write(chunk({ content: summaryText }, "stop", { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }))
        res.write("data: [DONE]\n\n")
        res.end()
      } else {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: summaryText }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }))
      }
      return
    }

    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
      if (!hasToolResult) {
        res.write(chunk({ role: "assistant", content: "" }))
        res.write(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: JSON.stringify({ file_path: TARGET, content: "写完了\n" }) } }] }, "tool_calls", { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }))
      } else {
        res.write(chunk({ role: "assistant", content: "" }))
        res.write(chunk({ content: "任务完成" }, "stop", { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 }))
      }
      res.write("data: [DONE]\n\n")
      res.end()
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "任务完成" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 } }))
    }
  })
}

let gw: ChildProcess | undefined
let fake: Server | undefined

function writeCfg(contextTokens: number): void {
  mkdirSync(join(HOME, ".yyagent"), { recursive: true })
  const cfg = JSON.parse(readFileSync(join(process.cwd(), "yyagentd.config.json"), "utf8")) as Record<string, unknown>
  const providers = (cfg.providers ?? {}) as Record<string, { baseURL?: string; apiKey?: string }>
  const first = Object.keys(providers)[0]
  const modelId = String(cfg.model ?? "m1").split("/")[1] ?? "m1"
  writeFileSync(join(HOME, ".yyagent", "config.json"), JSON.stringify({
    ...cfg,
    providers: { ...providers, [first]: { ...providers[first], baseURL: `http://127.0.0.1:${FAKE_PORT}/v1` } },
    model: `${first}/${modelId}`,
    permission: "full-auto",
    interactiveTimeoutMs: 0,
    contextTokens, // 故意拍大：比假 provider 的「真实窗口」大得多
  }, null, 2))
}
async function startGw(): Promise<boolean> {
  gw = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
    env: { ...process.env, HOME, USERPROFILE: HOME, YYAGENT_GATEWAY_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) }); if (r.ok) return true } catch { /* 没起 */ }
    await new Promise((s) => setTimeout(s, 500))
  }
  return false
}
const newSession = async (): Promise<string> =>
  ((await (await fetch(`${BASE}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: WORK }),
  })).json()) as { id: string }).id
/** 轮询「本轮**新**产生的助手消息」。种子历史里已经有助手消息了，
 *  直接找最后一条会立刻命中、根本不等这一轮跑完（第一版探针就这么错的）。 */
const runTurn = async (sid: string, text: string): Promise<Array<{ role: string; content: string; ts: number }>> => {
  const pre = await (await fetch(`${BASE}/api/sessions/${sid}`)).json() as { messages: Array<{ ts: number }> }
  const watermark = Math.max(0, ...pre.messages.map((m) => m.ts))
  await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid, text }),
  })
  for (let i = 0; i < 120; i++) {
    const f = await (await fetch(`${BASE}/api/sessions/${sid}`)).json() as { messages: Array<{ role: string; content: string; ts: number }> }
    const last = [...f.messages].reverse().find((m) => m.role === "assistant")
    if (last && last.ts > watermark && last.content.trim()) return f.messages
    await new Promise((s) => setTimeout(s, 500))
  }
  return []
}

/** 造一段足够长的历史，让假 provider 判定「超限」 */
async function seedLongHistory(sid: string): Promise<void> {
  const f = await (await fetch(`${BASE}/api/sessions/${sid}`)).json() as { meta: Record<string, unknown>; messages: Array<Record<string, unknown>> }
  // 时间戳必须全在**过去**——用未来时间戳会让本轮新消息的 ts 小于水位线，轮询永远等不到
  const base = Date.now() - 60_000
  const msgs: Array<Record<string, unknown>> = []
  for (let i = 0; i < 12; i++) {
    msgs.push({ role: "user", content: `第 ${i} 轮：${"背景信息".repeat(120)}`, ts: base + i * 1000 })
    msgs.push({ role: "assistant", content: `第 ${i} 轮回复：${"已经记录".repeat(120)}`, ts: base + i * 1000 + 500 })
  }
  msgs.push({ role: "user", content: "把结论写到 out.txt", ts: base + 20_000 })
  writeFileSync(join(HOME, ".yyagent", "sessions", `${sid}.json`), JSON.stringify({ meta: f.meta, messages: msgs }, null, 2))
}

try {
  mkdirSync(WORK, { recursive: true })
  fake = createServer(fakeProvider)
  await new Promise<void>((r) => fake!.listen(FAKE_PORT, "127.0.0.1", r))
  writeCfg(131_072) // 故意拍大
  if (!(await startGw())) throw new Error("网关没起来")
  check("网关起在假 provider 上（contextTokens 故意拍大）", true)

  // ============ ① 超长一次然后恢复 ============
  mode = "recover"
  calls = 0
  const sid = await newSession()
  await seedLongHistory(sid)
  const before = JSON.parse(readFileSync(join(HOME, ".yyagent", "sessions", `${sid}.json`), "utf8")) as { messages: unknown[] }
  const msgs = await runTurn(sid, "把结论写到 out.txt")
  const last = [...msgs].reverse().find((m) => m.role === "assistant")
  check("任务跑完了（没有死在超限上）", !!last && !last.content.includes("[出错]"), JSON.stringify(last?.content ?? null).slice(0, 120))
  const after = JSON.parse(readFileSync(join(HOME, ".yyagent", "sessions", `${sid}.json`), "utf8")) as { messages: Array<{ role: string; content: string }> }
  check("历史被压缩后落库（条数变少）", after.messages.length < before.messages.length, `${before.messages.length} → ${after.messages.length}`)
  check("压缩后的历史以滚动摘要开头", JSON.stringify(after.messages[0]).includes("滚动摘要"))
  check("文件真的写出来了", existsSync(TARGET) && readFileSync(TARGET, "utf8") === "写完了\n", existsSync(TARGET) ? readFileSync(TARGET, "utf8") : "(不存在)")

  // ============ ② 一直超长 ============
  mode = "always"
  calls = 0
  const sid2 = await newSession()
  await seedLongHistory(sid2)
  const msgs2 = await runTurn(sid2, "把结论写到 out.txt")
  const last2 = [...msgs2].reverse().find((m) => m.role === "assistant")
  check("一直超长时任务失败（不无限重试）", !!last2 && last2.content.includes("[出错]"), JSON.stringify(last2?.content ?? null).slice(0, 100))
  check("失败文案说清该调 contextTokens", !!last2 && last2.content.includes("contextTokens"), JSON.stringify(last2?.content ?? null).slice(0, 200))
  check("文案说「已自动压缩后重试，仍然超限」", !!last2 && last2.content.includes("已自动压缩"), JSON.stringify(last2?.content ?? null).slice(0, 160))
  check("不是原来那句误导人的「不支持所选参数」", !!last2 && !last2.content.includes("不支持所选参数"), JSON.stringify(last2?.content ?? null).slice(0, 120))

  // ============ ③ 工具结果之后才超限（executed>0）============
  mode = "afterTool"
  calls = 0
  const sid3 = await newSession()
  await seedLongHistory(sid3)
  const msgs3 = await runTurn(sid3, "把结论写到 out.txt")
  const last3 = [...msgs3].reverse().find((m) => m.role === "assistant")
  check("工具后超限：任务失败", !!last3 && last3.content.includes("[出错]"), JSON.stringify(last3?.content ?? null).slice(0, 100))
  check("失败文案提到已执行的工具调用（幂等护栏生效）", !!last3 && last3.content.includes("工具调用"), JSON.stringify(last3?.content ?? null).slice(0, 200))
  // 关键：不能整轮重发 → write 只该被执行一次
  const toolRuns = msgs3.filter((m) => typeof m.content === "string" && m.content.includes("工具调用")).length
  check("没有重放副作用（只失败一次，不重跑）", toolRuns <= 1, `${toolRuns} 次`)
} catch (e) {
  fail++
  console.log(`FAIL 运行出错 — ${(e as Error).message}`)
} finally {
  try { gw?.kill() } catch { /* 已杀 */ }
  try { fake?.close() } catch { /* 已关 */ }
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
