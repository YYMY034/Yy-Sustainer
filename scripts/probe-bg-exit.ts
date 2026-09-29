/**
 * T95 活体探针（不随 run-all-checks 跑，改 bg 任务/WS 广播后手动跑）：
 *
 *   npx tsx scripts/probe-bg-exit.ts
 *
 * 验证「后台任务完成是事件，不是轮询」：
 *   ① 模型起一个 3 秒后台命令 → 网关在它退出时向 WS 广播 bg-exit（带 sessionId/id/exitCode）
 *   ② bg_read(wait=true) 挂起等退出事件，醒来拿到「已结束(code=0)」+ 日志尾
 *      ——模型侧从此一次调用等到结果，不再反复 bg_read 烧步数
 *   ③ 反向：wait 对「网关重启过的磁盘记录」不装等（进程不在手上），立即如实返回
 */
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import WebSocket from "ws"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-bgexit-"))
const PORT = await pickFreePort()
const FAKE_PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`
const WORK = join(HOME, "work")
const PROMPT = "跑一个后台命令，然后等它结束告诉我结果"
const PROMPT2 = "对一个不存在的后台任务 wait，立刻告诉我结果"

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

const chunk = (delta: unknown, finish?: string, usage?: unknown): string =>
  "data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(usage ? { usage } : {}) }) + "\n\n"
const sse = (res: import("node:http").ServerResponse, lines: string[]): void => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
  for (const l of lines) res.write(l)
  res.write("data: [DONE]\n\n")
  res.end()
}
const usage = { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 }

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
    try { messages = (JSON.parse(raw) as { messages?: typeof messages }).messages ?? [] } catch { /* 按没有 */ }
    const lastUser = [...messages].reverse().find((m) => m.role === "user")
    const prompt = typeof lastUser?.content === "string" ? lastUser.content : ""
    const toolResults = messages.filter((m) => m.role === "tool").length
    const lastTool = [...messages].reverse().find((m) => m.role === "tool")
    const call = (name: string, args: Record<string, unknown>): void => {
      sse(res, [
        chunk({ role: "assistant", content: "" }),
        chunk(JSON.parse(JSON.stringify({ tool_calls: [{ index: 0, id: "c" + toolResults, type: "function", function: { name, arguments: JSON.stringify(args) } }] })), "tool_calls", usage),
      ])
    }
    const echo = (): void => {
      // 收尾：把 bg_read 的结果回显进会话（工具结果本身不落库，不回显没法断言）
      const done = `bg_read 结果回显：${String(lastTool?.content ?? "(无)").slice(0, 400)}`
      sse(res, [chunk({ role: "assistant", content: "" }), chunk({ content: done }, "stop", usage)])
    }
    if (prompt === PROMPT2) {
      // 反向剧本：对不存在的任务 wait——必须立即返回「未找到」，不能挂到超时
      if (toolResults === 0) call("bg_read", { task_id: "bg-999", wait: true, waitTimeoutMs: 30000 })
      else echo()
      return
    }
    if (prompt !== PROMPT) {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: `[fake provider] 没有剧本：${prompt.slice(0, 60)}` }, finish_reason: "stop" }], usage }))
      return
    }
    if (toolResults === 0) {
      // 第一步：起后台任务（3 秒，给 bg_read(wait) 留出真正等的时间）
      call("bash", { command: "Start-Sleep -Seconds 3", background: true })
      return
    }
    if (toolResults === 1) {
      // 第二步：立刻 bg_read(wait)——此刻任务铁定还在跑，必须挂起等退出事件
      call("bg_read", { task_id: "bg-1", wait: true, waitTimeoutMs: 30000 })
      return
    }
    echo()
  })
}

let gw: ChildProcess | undefined
let fake: Server | undefined
try {
  mkdirSync(WORK, { recursive: true })
  fake = createServer(fakeProvider)
  await new Promise<void>((r) => fake!.listen(FAKE_PORT, "127.0.0.1", r))

  mkdirSync(join(HOME, ".yyagent"), { recursive: true })
  writeFileSync(join(HOME, ".yyagent", "config.json"), JSON.stringify({
    providers: { eval: { baseURL: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: "sk-probe" } },
    model: "eval/m1",
    permission: "danger-confirm",
    interactiveTimeoutMs: 0,
    maxSteps: 8,
    mcpServers: {},
    // 内置钩子在 loadConfig 会自动补回；探针不测钩子，显式关掉省一堆「判定缺失」噪音
    hooks: [{ id: "builtin-safety", name: "安全钩子", builtin: true, enabled: false, prompt: "x" }],
  }))

  gw = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
    env: { ...process.env, HOME, USERPROFILE: HOME, YYAGENT_GATEWAY_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) }); if (r.ok) break } catch { /* 没起 */ }
    await new Promise((s) => setTimeout(s, 500))
  }

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  let bgExit: { sessionId?: string; id?: string; exitCode?: number | null } | undefined
  const statuses: string[] = []
  ws.on("message", (data) => {
    try {
      const m = JSON.parse(String(data)) as { type: string; sessionId?: string; id?: string; exitCode?: number | null; text?: string }
      if (m.type === "bg-exit") bgExit = m
      if (m.type === "status" && typeof m.text === "string") statuses.push(m.text)
    } catch { /* 非 JSON 忽略 */ }
  })
  await new Promise<void>((r) => ws.on("open", r))

  const sid = ((await (await fetch(`${BASE}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: WORK }),
  })).json()) as { id: string }).id
  await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid, text: PROMPT }),
  })

  const pre = (await (await fetch(`${BASE}/api/sessions/${sid}`)).json()) as { messages: Array<{ ts: number }> }
  const watermark = Math.max(0, ...pre.messages.map((m) => m.ts))
  let finalText = ""
  for (let i = 0; i < 60; i++) {
    const f = (await (await fetch(`${BASE}/api/sessions/${sid}`)).json()) as { messages: Array<{ role: string; content: string; ts: number }> }
    const last = [...f.messages].reverse().find((m) => m.role === "assistant" && m.ts > watermark)
    if (last && last.content.trim()) { finalText = last.content; break }
    await new Promise((s) => setTimeout(s, 500))
  }

  // 给 WS 广播一点余量（事件可能在轮询到最终文本之前就到了）
  for (let i = 0; i < 10 && !bgExit; i++) await new Promise((s) => setTimeout(s, 300))

  check("bg-exit 广播到达", !!bgExit, JSON.stringify(bgExit ?? null))
  check("bg-exit 带 sessionId 且对上会话", bgExit?.sessionId === sid, `expect ${sid} got ${bgExit?.sessionId}`)
  check("bg-exit 的 id/exitCode 正确", bgExit?.id === "bg-1" && bgExit?.exitCode === 0, JSON.stringify(bgExit ?? null))
  check("bg_read(wait) 等到了结束态而不是「运行中」", finalText.includes("已结束(code=0)"), finalText.slice(0, 200))
  check("bg_read(wait) 带回了日志输出", finalText.includes("bg_read 结果回显"), finalText.slice(0, 200))
  // T98：等待期间状态行必须可感知（进入 wait 立即推一条，不等 5s 心跳）
  check("等待原因上了状态流（bg_read wait）", statuses.some((s) => s.includes("等待后台任务 bg-1")), JSON.stringify(statuses.slice(0, 6)))

  // T99：/api/bg 面板数据源——任务在列且终态如实；日志尾可读；假 id 404
  const bgList = (await (await fetch(`${BASE}/api/bg`)).json()) as { tasks: Array<{ id: string; done?: boolean; exitCode: number | null }> }
  const rec = bgList.tasks.find((t) => t.id === "bg-1")
  check("/api/bg 列出 bg-1 且 done=true", !!rec && rec.done === true && rec.exitCode === 0, JSON.stringify(rec ?? null))
  const logTail = (await (await fetch(`${BASE}/api/bg/log?id=bg-1`)).json()) as { file?: string; text?: string; error?: string }
  check("/api/bg/log 返回日志尾", typeof logTail.text === "string" && typeof logTail.file === "string" && logTail.file.includes("bg-1.log"), JSON.stringify(logTail).slice(0, 120))
  const bogus = await fetch(`${BASE}/api/bg/log?id=bg-999`)
  check("/api/bg/log 假 id 返回 404", bogus.status === 404, `status=${bogus.status}`)

  // ③ 反向：对不存在的任务 wait 立即返回（不挂 30 秒超时）
  const t0 = Date.now()
  const sid2 = ((await (await fetch(`${BASE}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: WORK }),
  })).json()) as { id: string }).id
  await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid2, text: PROMPT2 }),
  })
  let revText = ""
  for (let i = 0; i < 30; i++) {
    const f = (await (await fetch(`${BASE}/api/sessions/${sid2}`)).json()) as { messages: Array<{ role: string; content: string; ts: number }> }
    const last = [...f.messages].reverse().find((m) => m.role === "assistant" && m.content.trim())
    if (last) { revText = last.content; break }
    await new Promise((s) => setTimeout(s, 400))
  }
  const revMs = Date.now() - t0
  check("反向：wait 不存在的任务立即返回「未找到」", revText.includes("未找到任务 bg-999"), `${(revMs / 1000).toFixed(1)}s | ${revText.slice(0, 120)}`)
  check("反向：没有挂到超时（10 秒内结束）", revMs < 10_000, `${revMs}ms`)
  ws.close()
} catch (e) {
  fail++
  console.log(`FAIL 运行出错 — ${(e as Error).stack ?? e}`)
} finally {
  try { gw?.kill() } catch { /* 已杀 */ }
  try { fake?.close() } catch { /* 已关 */ }
  await new Promise((s) => setTimeout(s, 300))
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
