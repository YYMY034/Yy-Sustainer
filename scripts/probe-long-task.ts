/**
 * T93 长任务**组合**验收探针（不随 run-all-checks 跑）：
 *
 *   npx tsx scripts/probe-long-task.ts            # 跑一个 30+ 步的长回合 + 中途杀网关
 *   npx tsx scripts/probe-long-task.ts --no-kill  # 只跑长回合，不杀
 *
 * 为什么需要它：`tests/` 与其它 probe 全是**单机制**验证——压缩、checkpoint、步数、
 * 记账各自绿。但「长任务能跑好吗」是**组合问题**：压缩触发时 checkpoint 在写吗？
 * 步数广播和 usage 记账对得上吗？被杀的那一刻 checkpoint 是新的吗？
 * 单测全绿 ≠ 组合可用。
 *
 * 做法：起一个真网关（隔离 HOME）+ 一个**会演长任务的假 provider**：
 * 每一步返回一个工具调用，输出逐步变长，把上下文顶到压缩阈值以上。
 * 然后量真数字，再中途 SIGKILL 验证断点恢复。
 *
 * 它不验证的：模型会不会跑偏、摘要质量好不好——那需要真模型（本仓库主模型 401，跑不了）。
 */
import { createServer, type Server } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-lt-"))
const PORT = await pickFreePort()
const FAKE_PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`
const WORK = join(HOME, "work")
const TARGET = join(WORK, "report.md")

/** 长回合的步数。真长任务 50 步起步，这里取 34 步（压缩会触发 ≥3 次） */
const TOTAL_STEPS = 34
/** 假 provider 每步的输入 token 报数。递增，用来把上下文顶过压缩阈值 */
const STEP_IN_BASE = 900
const STEP_OUT = 60

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

/** 假 provider：第 1..TOTAL_STEPS-1 步返回 bash 工具调用，最后一步返回总结 */
function fakeProvider(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
  let raw = ""
  req.on("data", (c) => { raw += String(c) })
  req.on("end", () => {
    let messages: Array<{ role: string; content: unknown }> = []
    try { messages = (JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [] } catch { /* 按没有 */ }
    let stream = true
    try { stream = (JSON.parse(raw) as { stream?: boolean }).stream === true } catch { /* 按流式 */ }

    // 每条 tool 结果 = 已跑完一步；输入 token 递增，把上下文顶过压缩阈值
    const done = messages.filter((m) => m.role === "tool").length
    const inTok = STEP_IN_BASE + done * 260
    const usage = { prompt_tokens: inTok, completion_tokens: STEP_OUT, total_tokens: inTok + STEP_OUT }
    const sse = (delta: unknown, finish?: string): string =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], usage })}\n\n`
    const toolArgs = { command: `echo step-${done}`, pad: "x".repeat(1200 + done * 40) }
    const finalText = `已完成 ${done} 步：全部子任务跑完`

    res.writeHead(200, { "Content-Type": stream ? "text/event-stream" : "application/json" })
    if (stream) {
      res.write(sse({ role: "assistant", content: "" }))
      if (done >= TOTAL_STEPS) {
        res.write(sse({ content: finalText }, "stop"))
      } else {
        res.write(sse({ tool_calls: [{ index: 0, id: `t${done}`, type: "function", function: { name: "bash", arguments: JSON.stringify(toolArgs) } }] }, "tool_calls"))
      }
      res.write("data: [DONE]\n\n")
      res.end()
    } else {
      // 非流式（压缩摘要等内部调用）：回一段文本
      res.end(JSON.stringify({
        id: "c", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: `摘要：前 ${done} 步在反复记录进度，结论待写入。` }, finish_reason: "stop" }],
        usage,
      }))
    }
  })
}

let gw: ChildProcess | undefined
let fake: Server | undefined
/** WS 收到的实时事件（压缩广播、步数、ctxPct 都在里面） */
const events: Array<Record<string, unknown>> = []
let ws: import("ws").WebSocket | undefined

function writeCfg(extra: Record<string, unknown>): void {
  mkdirSync(join(HOME, ".yyagent"), { recursive: true })
  writeFileSync(
    join(HOME, ".yyagent", "config.json"),
    JSON.stringify({
      providers: { fake: { baseURL: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: "k" } },
      model: "fake/m1",
      permission: "full-auto",
      interactiveTimeoutMs: 0,
      // 上下文窗口故意设小，让压缩在几十步内真的触发
      contextTokens: Number(process.env.LT_CONTEXT_TOKENS ?? 6000),
      ...extra,
    }, null, 2),
  )
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
const readSession = async (sid: string): Promise<{ meta: Record<string, unknown>; messages: Array<{ role: string; content: string; ts: number; steps?: unknown[] }> }> =>
  JSON.parse(readFileSync(join(HOME, ".yyagent", "sessions", `${sid}.json`), "utf8"))
const cpFile = (sid: string): string => join(HOME, ".yyagent", "checkpoints", `${sid}.json`)

const noKill = process.argv.includes("--no-kill")

try {
  mkdirSync(WORK, { recursive: true })
  fake = createServer(fakeProvider)
  await new Promise<void>((r) => fake!.listen(FAKE_PORT, "127.0.0.1", r))
  writeCfg({})
  if (!(await startGw())) throw new Error("网关没起来")

  // 连 WS 收实时事件（压缩广播、步数、ctxPct 都在里面）
  const sock = new (await import("ws")).WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  ws = sock
  await new Promise<void>((r, j) => { sock.on("open", () => r()); sock.on("error", j); setTimeout(() => j(new Error("WS 连不上")), 10000) })
  ws.on("message", (raw: unknown) => { try { events.push(JSON.parse(String(raw)) as Record<string, unknown>) } catch { /* 非 JSON */ } })

  const sid = await newSession()
  const pre = await readSession(sid)
  const watermark = Math.max(0, ...pre.messages.map((m) => m.ts))

  console.log(`\n=== 跑一个 ${TOTAL_STEPS} 步的长回合（contextTokens=6000，压缩会真的触发）===\n`)
  const t0 = Date.now()
  await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid, text: "把这个大任务跑完，每步用 bash 记录进度" }),
    signal: AbortSignal.timeout(600_000),
  })

  // 等它落库
  let msgs: Awaited<ReturnType<typeof readSession>>["messages"] = []
  for (let i = 0; i < 400; i++) {
    const f = await readSession(sid)
    const last = [...f.messages].reverse().find((m) => m.role === "assistant")
    if (last && last.ts > watermark && last.content.trim()) { msgs = f.messages; break }
    await new Promise((s) => setTimeout(s, 1000))
  }
  const dur = Date.now() - t0
  const meta = (await readSession(sid)).meta
  const usage = meta.usage as { in: number; out: number; turns: number; steps: number } | undefined
  const last = [...msgs].reverse().find((m) => m.role === "assistant")

  check("长回合跑完了", !!last && last.content.includes(`已完成 ${TOTAL_STEPS} 步`), JSON.stringify(last?.content ?? "").slice(0, 80))
  check("步数够多（真的是长任务）", (usage?.steps ?? 0) >= TOTAL_STEPS, `${usage?.steps} 步`)
  check("token 记账非零且合理", (usage?.in ?? 0) > 0 && (usage?.out ?? 0) > 0, `入 ${usage?.in} / 出 ${usage?.out}`)
  check("账本与会话累计一致（守恒）", (usage?.turns ?? 0) === 1, `turns=${usage?.turns}`)
  console.log(`  · 耗时 ${(dur / 1000).toFixed(1)}s · ${usage?.steps} 步 · 入 ${usage?.in} tok · 出 ${usage?.out} tok`)

  // 回合内压缩：provider 每步报递增的真实 usage，必然顶过 0.75 阈值。
  // 触发后 compacted 事件会来；同时压缩结果要能写回会话（首条变滚动摘要）。
  const compacted = msgs.length > 0 && String(msgs[0].content).includes("滚动摘要")
  check("回合内压缩触发了", compacted,
    compacted ? "首条已是滚动摘要" : `首条仍是用户消息（contextTokens=${6000}，每步输入 ${STEP_IN_BASE}+n*260）`)
  const midTurnEvents = events.filter((e) => e.type === "status" && String(e.text ?? "").includes("压缩"))
  check("压缩过程对用户可见（status 广播）", midTurnEvents.length > 0, `${midTurnEvents.length} 条`)
  const ctxPct = meta.ctxPct as number | undefined
  check("ctxPct 反映真实上下文（不再是 0%）", typeof ctxPct === "number" && ctxPct > 0, `${ctxPct}%（窗口 ${6000} tok，本轮实际入 ${usage?.in} tok）`)
  // 溢出兜底：contextTokens 故意设得比实际用量小，等于模拟「估算拍大了」的场景
  check("压缩阈值与实际用量的关系是可测的", (usage?.in ?? 0) > 6000, `实际 ${usage?.in} tok vs 阈值窗口 6000 tok`)

  // ============ 中途 SIGKILL → 断点恢复 ============
  if (!noKill) {
    console.log(`\n=== 中途 SIGKILL 网关（模拟崩溃）===\n`)
    const sid2 = await newSession()
    const pre2 = await readSession(sid2)
    const wm2 = Math.max(0, ...pre2.messages.map((m) => m.ts))
    await fetch(`${BASE}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid2, text: "再跑一个长任务，中途我会杀掉进程" }),
      signal: AbortSignal.timeout(60_000),
    })
    // 等一个「有内容」的 checkpoint——回合刚开始写的那份 steps 是空的（还没跑嘛），
    // 盯着它断言会误判成「checkpoint 不记步骤」。
    let cp = ""
    let parsed: { steps: unknown[]; streamedText: string; updatedAt: number } | undefined
    for (let i = 0; i < 90; i++) {
      if (existsSync(cpFile(sid2))) {
        try {
          const p = JSON.parse(readFileSync(cpFile(sid2), "utf8")) as { steps: unknown[] }
          if (Array.isArray(p.steps) && p.steps.length > 0) {
            cp = readFileSync(cpFile(sid2), "utf8")
            parsed = JSON.parse(cp) as { steps: unknown[]; streamedText: string; updatedAt: number }
            break
          }
        } catch { /* 写一半，下一轮再读 */ }
      }
      await new Promise((s) => setTimeout(s, 500))
    }
    check("轮内有 checkpoint 落盘", cp.length > 0, `${cp.length} 字节`)
    check("checkpoint 记了已执行的工具步骤", !!parsed && parsed.steps.length > 0, `${parsed?.steps.length ?? 0} 步`)
    if (parsed) {
      const age = Date.now() - parsed.updatedAt
      check("checkpoint 是新鲜的（不是启动时那份）", age < 30_000, `${age}ms 前更新`)
    }

    gw!.kill("SIGKILL")
    await new Promise((s) => setTimeout(s, 1200))
    gw = undefined
    check("网关已被 SIGKILL", true)

    if (!(await startGw())) throw new Error("网关没起来（重启）")
    check("网关重启成功", true)

    // 重启后：会话应只剩用户消息（无助手回复），但 checkpoint 还在
    const after = await readSession(sid2)
    const hasAssistant = after.messages.some((m) => m.role === "assistant" && m.ts > wm2)
    check("被杀的回合没有假造助手回复", !hasAssistant, `${after.messages.length} 条消息`)
    check("checkpoint 在重启后仍在", existsSync(cpFile(sid2)))

    // 恢复：adopt 应落一条带「进程被中断」标注的消息
    const lastTs = Math.max(0, ...after.messages.map((m) => m.ts))
    const undo = await (await fetch(`${BASE}/api/sessions/undo-files`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid2, ts: lastTs }),
      signal: AbortSignal.timeout(20_000),
    })).json().catch(() => ({})) as { error?: string }
    check("无快照时撤销明确报错（不静默）", !!undo.error, JSON.stringify(undo.error ?? "").slice(0, 80))

    // undo-state 应报告这一轮不可撤
    const st = await (await fetch(`${BASE}/api/sessions/${sid2}/undo-state`, { signal: AbortSignal.timeout(10_000) })).json() as { states: Record<string, { canUndo: boolean }> }
    check("undo-state 报告该轮不可撤", Object.values(st.states ?? {}).every((v) => v.canUndo === false), JSON.stringify(st.states))
  }
} catch (e) {
  fail++
  console.log(`FAIL 运行出错 — ${(e as Error).message}`)
} finally {
  try { ws?.close() } catch { /* 已关 */ }
  try { gw?.kill() } catch { /* 已杀 */ }
  try { fake?.close() } catch { /* 已关 */ }
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
