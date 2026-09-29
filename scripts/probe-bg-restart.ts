/**
 * T93 B1 活体探针（不随 run-all-checks 跑）：
 *
 *   npx tsx scripts/probe-bg-restart.ts
 *
 * 这是本批唯一有价值的验证方式——「重启后还能不能读到重启前启动的后台任务」
 * 没法用单元测覆盖，必须真的杀一次网关。步骤：
 *   ① 隔离 HOME 起真网关 + 假 provider（让模型发起一个 background bash）
 *   ② 等回合结束，断言 ~/.yyagent/bg/tasks.json 里有一条记录
 *   ③ **杀掉网关**（模拟崩溃/重启）
 *   ④ 在探针进程里以同一个 HOME 导入 bgReadTool：
 *      - 不带参 → 应列出重启前那条，且状态是「未知」而不是冒充已结束
 *      - 带 task_id → 应读到日志内容
 *      - 带路径穿越的 id → 必须「未找到」
 */
import { createServer, type Server } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-bg-"))
const PORT = await pickFreePort()
const FAKE_PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

const BG_DIR = join(HOME, ".yyagent", "bg")
const TASKS = join(BG_DIR, "tasks.json")

let gw: ChildProcess | undefined
let fake: Server | undefined
try {
  fake = createServer((req, res) => {
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "m1" }] }))
      return
    }
    let raw = ""
    req.on("data", (c) => { raw += String(c) })
    req.on("end", () => {
      let messages: Array<{ role: string; content: unknown }> = []
      try { messages = (JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [] } catch { /* 按没有处理 */ }
      const hasToolResult = messages.some((m) => m.role === "tool")
      // 「慢」那个用 Start-Sleep 拖住，好在杀网关时它仍在运行——用来验「状态未知」那条分支。
      // startBackground 会把命令包进 PowerShell 执行，所以这里直接写 PowerShell 语句即可。
      const slow = messages.some((m) => typeof m.content === "string" && m.content.includes("慢"))
      const command = slow ? "Start-Sleep -Seconds 120; echo late-output" : "echo hello-from-bg"
      const chunk = (delta: unknown, finish?: string, usage?: unknown): string =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(usage ? { usage } : {}) })}\n\n`
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
      if (!hasToolResult) {
        // 第一步：让模型起一个后台任务（命令会真的跑，输出进 bg-N.log）
        res.write(chunk({ role: "assistant", content: "" }))
        res.write(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command, background: true }) } }] }, "tool_calls", { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }))
      } else {
        res.write(chunk({ role: "assistant", content: "" }))
        res.write(chunk({ content: "后台任务已起" }, "stop", { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 }))
      }
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })
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
  }, null, 2))

  gw = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
    env: { ...process.env, HOME, USERPROFILE: HOME, YYAGENT_GATEWAY_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) }); if (r.ok) break } catch { /* 没起 */ }
    await new Promise((s) => setTimeout(s, 500))
  }
  check("网关起在假 provider 上", true)

  const newSession = async (): Promise<string> =>
    ((await (await fetch(`${BASE}/api/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: process.cwd() }),
    })).json()) as { id: string }).id
  const runTurn = async (sid: string, text: string): Promise<void> => {
    await fetch(`${BASE}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid, text }),
    })
    for (let i = 0; i < 80; i++) {
      const f = await (await fetch(`${BASE}/api/sessions/${sid}`)).json() as { messages: Array<{ role: string; content: string }> }
      const last = [...f.messages].reverse().find((m) => m.role === "assistant")
      if (last && last.content.trim()) return
      await new Promise((s) => setTimeout(s, 500))
    }
  }

  // 会话一：快命令 —— 杀网关时它已结束，记录里应有真实退出码
  await runTurn(await newSession(), "在后台跑一下 echo hello-from-bg")
  // 会话二：慢命令 —— 杀网关时它还在跑，记录里**不该**有 endedAt
  await runTurn(await newSession(), "在后台跑一个慢命令，然后别管它")

  check("tasks.json 落盘了", existsSync(TASKS), TASKS)
  const recs = existsSync(TASKS) ? (JSON.parse(readFileSync(TASKS, "utf8")) as Array<Record<string, unknown>>) : []
  check("里面有两条记录（一快一慢）", recs.length === 2, JSON.stringify(recs.map((r) => `${r.id}:${String(r.command).slice(0, 20)}`)))
  const fast = recs.find((r) => String(r.command) === "echo hello-from-bg")
  const slowRec = recs.find((r) => String(r.command).includes("Start-Sleep"))
  check("快任务记了真实退出码", fast?.endedAt !== undefined && fast?.exitCode === 0, JSON.stringify({ endedAt: fast?.endedAt, exitCode: fast?.exitCode }))
  check("慢任务**没有**结束标记（杀网关时它还在跑）", slowRec !== undefined && slowRec?.endedAt === undefined, JSON.stringify({ endedAt: slowRec?.endedAt }))
  const logPath = join(BG_DIR, "bg-1.log")
  check("快任务的日志真的写出来了", existsSync(logPath) && readFileSync(logPath, "utf8").includes("hello-from-bg"), logPath)
  check("目录里不留 tmp 残留", existsSync(BG_DIR) && readdirSafe(BG_DIR).every((f) => !f.includes(".tmp")), readdirSafe(BG_DIR).join(","))

  // ③ 杀掉网关 = 模拟崩溃
  gw!.kill()
  await new Promise((s) => setTimeout(s, 1000))
  gw = undefined
  check("网关已杀（进入「重启前」状态）", true)

  // ④ 在探针进程里以同一个 HOME 读——这正是重启后的第一个请求
  process.env.HOME = HOME
  process.env.USERPROFILE = HOME
  const mod = (await import("../src/agent/bgStore.js")) as typeof import("../src/agent/bgStore.js")
  const { bgReadTool } = (await import("../src/agent/tools.js")) as typeof import("../src/agent/tools.js")

  const listOut = String(await (bgReadTool.execute as (a: unknown) => Promise<string>)({}))
  check("重启后 bg_read() 能列出重启前的两个任务", listOut.includes("bg-1") && listOut.includes("bg-2"), listOut.slice(0, 220))
  // 已结束的那条报**真实**退出码；还在跑的那条必须说「未知」而不是冒充已结束
  check("已结束的报真实退出码", /bg-1 已结束\(code=0\)/.test(listOut), listOut.slice(0, 220))
  check("还在跑的说「状态未知」", listOut.includes("bg-2 状态未知（网关重启过"), listOut.slice(0, 220))
  check("命令原文还在（模型拿得到上下文）", listOut.includes("echo hello-from-bg") && listOut.includes("Start-Sleep"), listOut.slice(0, 220))

  const readOut = String(await (bgReadTool.execute as (a: unknown) => Promise<string>)({ task_id: "bg-1" }))
  check("重启后能读到已结束任务的日志", readOut.includes("hello-from-bg"), readOut.slice(0, 120))
  const readSlow = String(await (bgReadTool.execute as (a: unknown) => Promise<string>)({ task_id: "bg-2" }))
  check("还在跑的那条也说「状态未知」且不冒充输出", readSlow.includes("状态未知") && readSlow.includes("(无输出)"), readSlow.slice(0, 120))

  const evil = String(await (bgReadTool.execute as (a: unknown) => Promise<string>)({ task_id: "../../../Windows/win.ini" }))
  check("路径穿越的 task_id 读不到东西", evil.includes("未找到任务"), evil.slice(0, 120))

  // id 不回填的话，新起的任务会又是 bg-1 并覆盖上面的记录
  check("重启后 nextBgId 是 bg-3（接着磁盘最大序号，不撞车）", mod.nextBgId() === "bg-3", mod.nextBgId())
} catch (e) {
  fail++
  console.log(`FAIL 运行出错 — ${(e as Error).message}`)
} finally {
  try { gw?.kill() } catch { /* 已杀 */ }
  try { fake?.close() } catch { /* 已关 */ }
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
