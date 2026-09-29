/**
 * T93 P3 活体探针（不随 run-all-checks 跑）：
 *
 *   npx tsx scripts/probe-session-budget.ts
 *
 * 验证「token 预算真的能刹住车」：
 *   ① 轮内熔断：假 provider 每步都报真实 usage，累计越过 sessionTokenBudget
 *      → 回合必须停下来，落库文案说「已达预算」而不是「已停止」，
 *        且**这一轮的 token 必须记进 meta.usage**（否则拦不住第二次）
 *   ② 前置拒绝：已经超限的会话再发消息 → 一个 token 都不花，直接拒绝并说清数字
 *   ③ 默认 0 = 不限：不配置时跑到天荒地老也不拦
 */
import { createServer, type Server } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-bud-"))
const PORT = await pickFreePort()
const FAKE_PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`
const WORK = join(HOME, "work")
const TARGET = join(WORK, "out.txt")
/** 假 provider 每步报的用量。设小一点，几步就越限 */
const PER_STEP_IN = 400
const PER_STEP_OUT = 100

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

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
    const hasToolResult = messages.some((m) => m.role === "tool")
    const usage = { prompt_tokens: PER_STEP_IN, completion_tokens: PER_STEP_OUT, total_tokens: PER_STEP_IN + PER_STEP_OUT }
    const chunk = (delta: unknown, finish?: string): string =>
      "data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], usage }) + "\n\n"
    const json = (content: string): string =>
      JSON.stringify({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage })
    const jsonTool = (name: string, args: unknown): string =>
      JSON.stringify({
        id: "c",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
        usage,
      })

    // **永远返回工具调用**，不给收尾——否则两步就结束了，预算根本轮不到当刹车
    const call = { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo tick" }) } }] }
    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
      res.write(chunk({ role: "assistant", content: "" }))
      res.write(chunk(JSON.parse(JSON.stringify(call)), "tool_calls"))
      res.write("data: [DONE]\n\n")
      res.end()
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(jsonTool("bash", { command: "echo tick" }))
    }
  })
}

let gw: ChildProcess | undefined
let fake: Server | undefined

function writeCfg(budget: number | undefined): void {
  mkdirSync(join(HOME, ".yyagent"), { recursive: true })
  const cfg = JSON.parse(readFileSync(join(process.cwd(), "yyagentd.config.json"), "utf8")) as Record<string, unknown>
  const providers = (cfg.providers ?? {}) as Record<string, { baseURL?: string; apiKey?: string }>
  const first = Object.keys(providers)[0]
  const modelId = String(cfg.model ?? "m1").split("/")[1] ?? "m1"
  const out: Record<string, unknown> = {
    ...cfg,
    providers: { ...providers, [first]: { ...providers[first], baseURL: `http://127.0.0.1:${FAKE_PORT}/v1` } },
    model: `${first}/${modelId}`,
    permission: "full-auto",
    interactiveTimeoutMs: 0,
    maxSteps: 40, // 给足步数，让预算（而不是步数）成为刹车
  }
  if (budget !== undefined) out.sessionTokenBudget = budget
  writeFileSync(join(HOME, ".yyagent", "config.json"), JSON.stringify(out, null, 2))
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
const send = async (sid: string, text: string): Promise<number> =>
  (await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sid, text }),
    signal: AbortSignal.timeout(120_000),
  })).status
const readMsgs = async (sid: string): Promise<Array<{ role: string; content: string; ts: number }>> => {
  const f = await (await fetch(`${BASE}/api/sessions/${sid}`)).json() as { messages: Array<{ role: string; content: string; ts: number }> }
  return f.messages
}
const meta = (sid: string): { usage?: { in: number; out: number; turns: number } } => {
  const f = JSON.parse(readFileSync(join(HOME, ".yyagent", "sessions", `${sid}.json`), "utf8")) as { meta: { usage?: { in: number; out: number; turns: number } } }
  return f.meta
}

try {
  mkdirSync(WORK, { recursive: true })
  fake = createServer(fakeProvider)
  await new Promise<void>((r) => fake!.listen(FAKE_PORT, "127.0.0.1", r))

  // ============ ① 轮内熔断 ============
  const BUDGET = 1500 // 每步 500，约 3 步后越限
  writeCfg(BUDGET)
  if (!(await startGw())) throw new Error("网关没起来")
  check("网关起在假 provider 上（sessionTokenBudget=1500）", true)

  const sid = await newSession()
  const pre = await readMsgs(sid)
  const watermark = Math.max(0, ...pre.map((m) => m.ts))
  const status = await send(sid, "一直跑下去")
  check("chat 返回 200（熔断不是接口错误）", status === 200, `status=${status}`)

  let msgs: Array<{ role: string; content: string; ts: number }> = []
  for (let i = 0; i < 120; i++) {
    msgs = await readMsgs(sid)
    const last = [...msgs].reverse().find((m) => m.role === "assistant")
    if (last && last.ts > watermark && last.content.trim()) break
    await new Promise((s) => setTimeout(s, 500))
  }
  const last = [...msgs].reverse().find((m) => m.role === "assistant")
  check("回合停下了（有落库的助手消息）", !!last, JSON.stringify(last?.content ?? null).slice(0, 80))
  check("落库文案说「已达预算」而不是「已停止」", !!last && last.content.includes("token 预算"), JSON.stringify(last?.content ?? null).slice(0, 160))

  const u = meta(sid).usage
  check("这一轮的 token 记进了 meta.usage", (u?.in ?? 0) + (u?.out ?? 0) >= BUDGET, JSON.stringify(u))
  check("记账没超预算太多（熔断是及时的）", (u?.in ?? 0) + (u?.out ?? 0) < BUDGET * 2, JSON.stringify(u))

  // ============ ② 前置拒绝 ============
  const before2 = meta(sid).usage
  check("场景①之后确实已超限（前置拒绝才有意义）", (before2?.in ?? 0) + (before2?.out ?? 0) >= BUDGET, JSON.stringify(before2))
  const st2 = await send(sid, "再发一条")
  check("已超限的会话仍返回 200（不报接口错）", st2 === 200)
  // /api/chat 是异步的，立刻读会读到半路——等它落定
  await new Promise((r) => setTimeout(r, 6000))
  const u2 = meta(sid).usage
  check("一个 token 都没多花", (u2?.in ?? 0) === (before2?.in ?? 0) && (u2?.out ?? 0) === (before2?.out ?? 0), `${JSON.stringify(before2)} → ${JSON.stringify(u2)}`)
  const msgs2 = await readMsgs(sid)
  check("没有新增助手消息（没跑模型）", msgs2.length === msgs.length, `${msgs.length} → ${msgs2.length}`)

  // ============ ③ 默认 0 = 不限 ============
  gw!.kill()
  await new Promise((s) => setTimeout(s, 800))
  gw = undefined
  writeCfg(undefined)
  if (!(await startGw())) throw new Error("网关没起来（第三轮）")
  const sid3 = await newSession()
  const pre3 = await readMsgs(sid3)
  const wm3 = Math.max(0, ...pre3.map((m) => m.ts))
  await send(sid3, "跑一会儿")
  let stopped = false
  for (let i = 0; i < 60; i++) {
    const m = await readMsgs(sid3)
    const l = [...m].reverse().find((x) => x.role === "assistant")
    if (l && l.ts > wm3 && l.content.trim()) {
      stopped = l.content.includes("token 预算")
      break
    }
    await new Promise((s) => setTimeout(s, 500))
  }
  check("不配置预算时不会被拦（默认 0 = 不限）", !stopped)
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
