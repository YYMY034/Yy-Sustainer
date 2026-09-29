/**
 * T93 P3 活体探针（不随 run-all-checks 跑）：
 *
 *   npx tsx scripts/probe-subagent-steps.ts
 *
 * 验证「子代理截断不再静默」：
 *   ① 主代理派发 delegate，子代理每一步都被假 provider 拖着走工具调用
 *      → 用满 subagentMaxSteps 后，**主代理必须看到截断标注**，而不是把半截结果当结论
 *   ② 步数够用时一个字节的警告都不加（不污染正常结果）
 *   ③ 配置项真的被读（设 3 就按 3 截断，不是硬编码的 30）
 */
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-sa-"))
const PORT = await pickFreePort()
const FAKE_PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`
const WORK = join(HOME, "work")
const CAP = 3

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

const SUB_MARK = "写一份很长的报告"

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
    let stream = false
    try { stream = (JSON.parse(raw) as { stream?: boolean }).stream === true } catch { /* 按非流式 */ }
    // 用「user 消息恰好是任务原文」区分两层。**不能**用 system 判——
    // composeSystem 对任何调用都注入基础提示词（子代理也有），判了永远是 false。
    // 也不能用 includes：子任务结果回显里也含这段文字，但那是在 tool 消息里（role 不同）。
    const isSub = messages.some((m) => m.role === "user" && String(m.content) === SUB_MARK)
    const subToolResults = messages.filter((m) => m.role === "tool").length
    const chunk = (delta: unknown, finish?: string, usage?: unknown): string =>
      "data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(usage ? { usage } : {}) }) + "\n\n"
    const json = (content: string): string =>
      JSON.stringify({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } })
    // 非流式也要能回工具调用——子代理走 generateText，只回空文本它就一步结束，
    // 根本烧不到步数上限（第一版探针就这么错的）
    const jsonTool = (name: string, args: unknown): string =>
      JSON.stringify({
        id: "c",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
      })

    const sse = (lines: string[]): void => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
      for (const l of lines) res.write(l)
      res.write("data: [DONE]\n\n")
      res.end()
    }

    if (isSub) {
      // 子代理：永远返回一个 bash 调用，把步数烧到上限为止
      const call = JSON.stringify({ tool_calls: [{ index: 0, id: "sc", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo step" }) } }] })
      if (stream) sse([chunk({ role: "assistant", content: "" }), chunk(JSON.parse(call), "tool_calls", { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 })])
      else res.end(jsonTool("bash", { command: "echo step" }))
      return
    }
    // 主代理：第一步派发 delegate，之后收尾
    if (subToolResults === 0) {
      const call = JSON.stringify({ tool_calls: [{ index: 0, id: "mc", type: "function", function: { name: "delegate", arguments: JSON.stringify({ persona: "coder", task: SUB_MARK }) } }] })
      if (stream) sse([chunk({ role: "assistant", content: "" }), chunk(JSON.parse(call), "tool_calls", { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 })])
      else res.end(jsonTool("delegate", { persona: "coder", task: SUB_MARK }))
      return
    }
    // 主代理收尾时把子任务结果回显出来——工具结果本身不落入会话文件
    // （StoredMessage 只有 user/assistant/system），不回显就没法从会话里断言
    const lastTool = [...messages].reverse().find((m) => m.role === "tool")
    const done = `子任务结果回显：${String(lastTool?.content ?? "(无)").slice(0, 400)}`
    if (stream) sse([chunk({ role: "assistant", content: "" }), chunk({ content: done }, "stop", { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 })])
    else res.end(json(done))
  })
}

let gw: ChildProcess | undefined
let fake: Server | undefined
try {
  mkdirSync(WORK, { recursive: true })
  fake = createServer(fakeProvider)
  await new Promise<void>((r) => fake!.listen(FAKE_PORT, "127.0.0.1", r))

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
    subagentMaxSteps: CAP, // 故意设小，几秒就跑完
  }, null, 2))

  gw = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
    env: { ...process.env, HOME, USERPROFILE: HOME, YYAGENT_GATEWAY_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) }); if (r.ok) break } catch { /* 没起 */ }
    await new Promise((s) => setTimeout(s, 500))
  }
  check("网关起在假 provider 上（subagentMaxSteps=3）", true)

  const sid = ((await (await fetch(`${BASE}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: WORK }),
  })).json()) as { id: string }).id
  await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid, text: "派个任务给子代理" }),
  })

  let msgs: Array<{ role: string; content: string; ts: number }> = []
  const pre = await (await fetch(`${BASE}/api/sessions/${sid}`)).json() as { messages: Array<{ ts: number }> }
  const watermark = Math.max(0, ...pre.messages.map((m) => m.ts))
  for (let i = 0; i < 120; i++) {
    const f = await (await fetch(`${BASE}/api/sessions/${sid}`)).json() as { messages: Array<{ role: string; content: string; ts: number }> }
    msgs = f.messages
    const last = [...f.messages].reverse().find((m) => m.role === "assistant")
    if (last && last.ts > watermark && last.content.trim()) break
    await new Promise((s) => setTimeout(s, 500))
  }

  const last = [...msgs].reverse().find((m) => m.role === "assistant")
  const echoed = last?.content ?? ""
  check("截断标注回到了主对话里", echoed.includes("子任务已用完全部"), echoed.slice(0, 200))
  check("标注写的是配置的 3 步（不是硬编码 30）", echoed.includes("全部 3 步"), echoed.slice(0, 240))
  check("标注说清可能不完整、别当结论", echoed.includes("可能不完整") && echoed.includes("不要把它当作最终结论"))
  check("标注给出补救办法", echoed.includes("拆小") && echoed.includes("subagentMaxSteps"))
  check("主代理正常收尾（没被截断带崩）", !!last && last.content.includes("子任务结果回显"), JSON.stringify(last?.content ?? null).slice(0, 60))
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
