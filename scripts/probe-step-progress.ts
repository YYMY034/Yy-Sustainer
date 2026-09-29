/**
 * T93 P2 步进度 + 实时上下文的活体探针（不随 run-all-checks 跑）：
 *
 *   npx tsx scripts/probe-step-progress.ts
 *
 * 起一个**会答话的假 provider**（返回一次带工具调用的流式响应 + 一次纯文本响应），
 * 让网关真的跑两步，然后连 WS 收广播，验证：
 *   ① status 事件带 step / maxSteps（「第 N/M 步」）
 *   ② ctxPct 用的是**真实输入 token**（假 provider 在 usage 里报了 1234，不是估算）
 *   ③ TUI/网关都没漏接（loop 之前一直在报，压根没人接）
 */
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { WebSocket } from "ws"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-sp-"))
const PORT = await pickFreePort()
const FAKE_PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`
const WS_URL = `ws://127.0.0.1:${PORT}/ws`
/** 假 provider 声明的输入 token——探针据此断言 ctxPct 来自真实用量而不是估算 */
const FAKE_INPUT_TOKENS = 1234
const CONTEXT_TOKENS = 131_072
const EXPECT_PCT = Math.min(100, Math.round((FAKE_INPUT_TOKENS / CONTEXT_TOKENS) * 100))

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

/** 假 provider：第一次回答带一个 bash 工具调用，第二次回答纯文本 */
function fakeProvider(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
  if (req.url?.includes("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ data: [{ id: "m1" }] }))
    return
  }
  let raw = ""
  req.on("data", (c) => { raw += String(c) })
  req.on("end", () => {
    // 请求体是分片到达的——按片 parse 只会拿到最后一片，那会让「是否已有工具结果」永远判错，
    // 假 provider 就无限重发同一个工具调用（第一版探针就是这么跑了 50 步的）。
    let messages: Array<{ role: string; content: unknown }> = []
    try { messages = (JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [] } catch { /* 不是 JSON 就按没有 */ }
    // 只认 tool 消息判「是否已执行过工具」。原来还看 content 里有没有关键词——
    // 用户文本「跑一下 echo hi」含 hi，第一跳就被判成已执行，两步脚本永远走不到
    // （T98 扩展断言时抓到的探针 bug，不是引擎 bug——直接复现 onStep 是两次的）
    const hasToolResult = messages.some((m) => m.role === "tool")
    const chunk = (delta: unknown, finish?: string, usage?: unknown): string =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(usage ? { usage } : {}) })}\n\n`
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
    if (!hasToolResult) {
      res.write(chunk({ role: "assistant", content: "" }))
      res.write(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }] }, "tool_calls", { prompt_tokens: FAKE_INPUT_TOKENS, completion_tokens: 5, total_tokens: FAKE_INPUT_TOKENS + 5 }))
    } else {
      res.write(chunk({ role: "assistant", content: "" }))
      // T101：原生思考流（deepseek 风格 reasoning_content）——引擎应包 <thinking> 转发
      res.write(chunk({ reasoning_content: "先确认 echo 已经跑过了" }))
      res.write(chunk({ content: "跑完了" }, "stop", { prompt_tokens: FAKE_INPUT_TOKENS, completion_tokens: 3, total_tokens: FAKE_INPUT_TOKENS + 3 }))
    }
    res.write("data: [DONE]\n\n")
    res.end()
  })
}

let gw: ChildProcess | undefined
let slow: Server | undefined
let ws: WebSocket | undefined
try {
  slow = createServer(fakeProvider)
  await new Promise<void>((r) => slow!.listen(FAKE_PORT, "127.0.0.1", r))

  mkdirSync(join(HOME, ".yyagent"), { recursive: true })
  writeFileSync(
    join(HOME, ".yyagent", "config.json"),
    JSON.stringify(
      {
        providers: { fake: { baseURL: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: "k" } },
        model: "fake/m1",
        contextTokens: CONTEXT_TOKENS,
        permission: "full-auto",
        interactiveTimeoutMs: 0,
      },
      null,
      2,
    ),
  )

  gw = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
    env: { ...process.env, HOME, USERPROFILE: HOME, YYAGENT_GATEWAY_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) }); if (r.ok) break } catch { /* 没起 */ }
    await new Promise((s) => setTimeout(s, 500))
  }
  check("网关起在会答话的假 provider 上", true)

  const created = await (await fetch(`${BASE}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: process.cwd() }),
  })).json() as { id: string }
  const sid = created.id

  // 连 WS 收广播
  const events: Array<Record<string, unknown>> = []
  await new Promise<void>((resolve, reject) => {
    ws = new WebSocket(WS_URL)
    ws.on("open", () => resolve())
    ws.on("error", reject)
    const timer = setTimeout(() => reject(new Error("WS 连不上")), 10_000)
    ws.on("open", () => clearTimeout(timer))
  })
  const sock = ws as WebSocket
  sock.on("message", (raw) => {
    try { events.push(JSON.parse(String(raw)) as Record<string, unknown>) } catch { /* 非 JSON */ }
  })

  const chat = await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid, text: "跑一下 echo hi" }),
  })
  check("chat 受理", chat.status === 200)

  // 等它落库（两步：工具调用 + 最终文本）
  let assistantText = ""
  for (let i = 0; i < 80; i++) {
    const f = await (await fetch(`${BASE}/api/sessions/${sid}`)).json() as { messages: Array<{ role: string; content: string }> }
    const last = [...f.messages].reverse().find((m) => m.role === "assistant")
    if (last && last.content.trim()) { assistantText = last.content; break }
    await new Promise((s) => setTimeout(s, 500))
  }
  check("真的跑完了两步", assistantText.includes("跑完了"), JSON.stringify(assistantText))
  // REST 轮询和 WS 投递是两条连接，没有顺序保证——最后几条 status（第二步的 turnIn）
  // 可能还在路上，沉淀一下再分析事件（T98 第一版探针在这翻过车）
  await new Promise((s) => setTimeout(s, 800))

  const statuses = events.filter((e) => e.type === "status")
  const withStep = statuses.filter((e) => typeof e.step === "number" && typeof e.maxSteps === "number")
  check("status 事件带 step / maxSteps", withStep.length > 0, `共 ${statuses.length} 条 status，带步数的 ${withStep.length} 条`)
  // 主轮内必须单调；收敛续跑是另一段（上限 8），序号从头开始是**设计如此**，不是倒退
  const mainRun = withStep.filter((e) => e.maxSteps === 50)
  const convergeRun = withStep.filter((e) => e.maxSteps === 8)
  check("主轮内步序号单调递增", mainRun.every((e, i) => i === 0 || (e.step as number) > (mainRun[i - 1].step as number)),
    mainRun.map((e) => e.step).join(","))
  check("收敛续跑是独立的一段（上限 8，序号从头）", convergeRun.length === 0 || convergeRun.every((e) => (e.step as number) <= 8),
    convergeRun.map((e) => `${e.step}/${e.maxSteps}`).join(" "))
  check("文案里就是「第 N/M 步」", withStep.some((e) => String(e.text).includes("第 ") && String(e.text).includes(" 步")), JSON.stringify(withStep[0]?.text))

  const withCtx = statuses.filter((e) => typeof e.ctxPct === "number")
  check("status 事件带 ctxPct", withCtx.length > 0)
  check("ctxPct 用的是真实输入 token（不是估算）", withCtx.some((e) => e.ctxPct === EXPECT_PCT),
    `期望 ${EXPECT_PCT}%，实际 ${JSON.stringify(withCtx.map((e) => e.ctxPct))}`)

  // T98：status 事件带本回合累计真实 token（turnIn/turnOut，来自 onStep 的累加）
  const withTok = statuses.filter((e) => typeof e.turnIn === "number" && typeof e.turnOut === "number")
  const lastTok = withTok[withTok.length - 1]
  const expectIn = FAKE_INPUT_TOKENS + FAKE_INPUT_TOKENS // 两步各报一次 FAKE_INPUT_TOKENS
  check("status 事件带 turnIn/turnOut", withTok.length > 0)
  check("turnIn 是两步真实输入的累计", lastTok && (lastTok.turnIn as number) === expectIn,
    `期望 ${expectIn}，实际 ${JSON.stringify(withTok.map((e) => e.turnIn))}；全部 status：${JSON.stringify(statuses.map((e) => ({ t: e.text, i: e.turnIn })))}`)

  // T101：原生思考（reasoning_content）被包 <thinking> 走 text 流
  const textDeltas = events.filter((e) => e.type === "text").map((e) => String(e.delta ?? ""))
  const joined = textDeltas.join("")
  check("reasoning 被包 <thinking> 标签进文本流", joined.includes("<thinking>") && joined.includes("先确认 echo 已经跑过了"), joined.slice(0, 160))
  check("思考闭合且不污染正文断言（正文仍在）", joined.includes("</thinking>") && joined.includes("跑完了"), joined.slice(-120))
} catch (e) {
  fail++
  console.log(`FAIL 运行出错 — ${(e as Error).message}`)
} finally {
  try { ws?.close() } catch { /* 已关 */ }
  try { gw?.kill() } catch { /* 已杀 */ }
  try { slow?.close() } catch { /* 已关 */ }
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
