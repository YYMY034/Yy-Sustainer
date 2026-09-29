/**
 * T97 活体探针（不随 run-all-checks 跑，改 delegate/loop 状态链后手动跑）：
 *
 *   npx tsx scripts/probe-delegate-progress.ts
 *
 * 验证「子代理进度对用户可见」：
 *   ① 主代理派发 delegate 后，WS status 流里必须出现 `[子代理 coder] 第 N/M 步` ——
 *      原来子代理跑的时候主对话只看到 delegate 工具转圈，里面在干嘛没人知道
 *   ② 步数上限写的是配置值（subagentMaxSteps=5），不是硬编码
 *   ③ 反向：主回合自己的状态（思考中）原样还在，没有被子代理前缀污染
 */
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import WebSocket from "ws"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-dlg-"))
const PORT = await pickFreePort()
const FAKE_PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`
const WORK = join(HOME, "work")
const CAP = 5
const SUB_MARK = "写一份很长的报告"
const PROMPT = "派个子代理干活"

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
const jsonTool = (name: string, args: Record<string, unknown>): string =>
  JSON.stringify({
    id: "c",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [{ id: "t", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
    usage,
  })
const jsonText = (content: string): string =>
  JSON.stringify({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage })

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
    let stream = false
    try {
      const body = JSON.parse(raw) as { messages?: typeof messages; stream?: boolean }
      messages = body.messages ?? []
      stream = body.stream === true
    } catch { /* 按没有 */ }
    const lastUser = [...messages].reverse().find((m) => m.role === "user")
    const prompt = typeof lastUser?.content === "string" ? lastUser.content : ""
    const toolResults = messages.filter((m) => m.role === "tool").length

    // 子代理：generateText 非流式。前两步各跑一次 bash（让 onStep 至少触发两次），然后收尾
    if (prompt === SUB_MARK) {
      if (stream) { res.writeHead(400); res.end() ; return }
      if (toolResults < 2) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(jsonTool("bash", { command: "echo sub-step" })) }
      else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(jsonText("子任务完成：报告写完了")) }
      return
    }
    // 主代理：streamText 流式。第一步派 delegate，拿到结果后回显收尾
    if (toolResults === 0) {
      sse(res, [
        chunk({ role: "assistant", content: "" }),
        chunk(JSON.parse(JSON.stringify({ tool_calls: [{ index: 0, id: "m1", type: "function", function: { name: "delegate", arguments: JSON.stringify({ persona: "coder", task: SUB_MARK }) } }] })), "tool_calls", usage),
      ])
      return
    }
    const lastTool = [...messages].reverse().find((m) => m.role === "tool")
    const done = `子任务结果回显：${String(lastTool?.content ?? "(无)").slice(0, 200)}`
    sse(res, [chunk({ role: "assistant", content: "" }), chunk({ content: done }, "stop", usage)])
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
    maxSteps: 6,
    subagentMaxSteps: CAP,
    mcpServers: {},
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
  const statuses: string[] = []
  ws.on("message", (data) => {
    try {
      const m = JSON.parse(String(data)) as { type: string; text?: string }
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
  await new Promise((s) => setTimeout(s, 500))
  ws.close()

  const subStatuses = statuses.filter((s) => s.startsWith("[子代理 coder]"))
  check("子代理进度上了主状态流", subStatuses.length >= 2, JSON.stringify(statuses.slice(0, 8)))
  check("进度带步数上限且用的是配置值", subStatuses.some((s) => s.includes("第 1/5 步")), subStatuses.slice(0, 3).join(" | "))
  check("进度带当前工具名", subStatuses.some((s) => s.includes("bash")), subStatuses.slice(0, 3).join(" | "))
  check("主回合自身状态未被污染（思考中 原样在）", statuses.includes("思考中"), JSON.stringify(statuses.slice(0, 3)))
  check("回合正常收尾（结果回显回到主对话）", finalText.includes("子任务结果回显") && finalText.includes("子任务完成"), finalText.slice(0, 160))
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
