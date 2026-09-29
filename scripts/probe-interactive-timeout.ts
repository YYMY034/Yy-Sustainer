/**
 * T93 P2 交互轮总超时的活体探针（不随 run-all-checks 跑）：
 *
 *   npx tsx scripts/probe-interactive-timeout.ts
 *
 * 起一个「永远不答话」的假 provider，让网关的交互轮真的挂住，然后验证：
 *   ① 超时后会话落库的助手消息写的是「已超时停止」而不是「已停止」
 *   ② 不超时的正常回合不受影响（interactiveTimeoutMs=0 时压根不装定时器）
 */
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-to-"))
const PORT = await pickFreePort()
const FAKE_PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  })
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> }
}
const readLastAssistant = (id: string): { content: string } | undefined => {
  const f = JSON.parse(readFileSync(join(HOME, ".yyagent", "sessions", `${id}.json`), "utf8")) as {
    messages: Array<{ role: string; content: string }>
  }
  return [...f.messages].reverse().find((m) => m.role === "assistant")
}

function writeConfig(interactiveTimeoutMs: number): void {
  mkdirSync(join(HOME, ".yyagent"), { recursive: true })
  writeFileSync(
    join(HOME, ".yyagent", "config.json"),
    JSON.stringify(
      {
        providers: { slow: { baseURL: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: "k" } },
        model: "slow/m1",
        interactiveTimeoutMs,
      },
      null,
      2,
    ),
  )
}

let gw: ChildProcess | undefined
function startGateway(): void {
  gw = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
    env: { ...process.env, HOME, USERPROFILE: HOME, YYAGENT_GATEWAY_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  })
}
async function waitUp(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) }); if (r.ok) return true } catch { /* 没起 */ }
    await new Promise((s) => setTimeout(s, 500))
  }
  return false
}

let slow: Server | undefined
try {
  slow = createServer((req, res) => {
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "m1" }] }))
      return
    }
    // 聊天接口：挂住不答（也不结束响应）——这就是「卡住的交互轮」
  })
  await new Promise<void>((r) => slow!.listen(FAKE_PORT, "127.0.0.1", r))

  // ① 超时 3 秒
  writeConfig(3000)
  startGateway()
  if (!(await waitUp())) throw new Error("网关没起来")
  check("网关起在假 provider 上", true)

  const sid = ((await api("POST", "/api/sessions", { cwd: process.cwd() })).body as unknown as { id: string }).id
  const t0 = Date.now()
  const chat = await api("POST", "/api/chat", { sessionId: sid, text: "一个永远不会有回复的问题" })
  check("chat 受理了（异步入队）", chat.status === 200 && chat.body?.started === true, JSON.stringify(chat.body))
  // /api/chat 是异步的，轮询等它落库
  let last: { content: string } | undefined
  for (let i = 0; i < 120; i++) {
    last = readLastAssistant(sid)
    if (last) break
    await new Promise((s) => setTimeout(s, 500))
  }
  const dur = Date.now() - t0
  check("大约在 3 秒上下收尾", dur >= 2500 && dur < 20_000, `${dur}ms`)

  check("落了一条助手消息", !!last)
  check("写的是「已超时」而不是「已停止」", !!last && last.content.includes("已超时"), JSON.stringify(last?.content))
  check("提示可在此基础上继续", !!last && last.content.includes("继续"))

  const again = await api("GET", `/api/sessions/${sid}`)
  check("会话仍可读（busy 已释放）", again.status === 200)

  gw!.kill()
  await new Promise((s) => setTimeout(s, 800))

  // ② interactiveTimeoutMs=0 时不装定时器：同样挂住，但绝不该被超时打断
  writeConfig(0)
  startGateway()
  if (!(await waitUp())) throw new Error("网关没起来（第二轮）")
  const sid2 = ((await api("POST", "/api/sessions", { cwd: process.cwd() })).body as unknown as { id: string }).id
  const t1 = Date.now()
  await api("POST", "/api/chat", { sessionId: sid2, text: "这条会被假 provider 挂住，但不应被超时打断" })
  await new Promise((s) => setTimeout(s, 12_000))
  const dur2 = Date.now() - t1
  const last2 = readLastAssistant(sid2)
  check("interactiveTimeoutMs=0 时不超时（等 12 秒仍没收尾）", dur2 > 10_000 && !last2, `${dur2}ms / 落库=${JSON.stringify(last2?.content)}`)
} catch (e) {
  fail++
  console.log(`FAIL 运行出错 — ${(e as Error).message}`)
} finally {
  try { gw?.kill() } catch { /* 已杀 */ }
  try { slow?.close() } catch { /* 已关 */ }
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
