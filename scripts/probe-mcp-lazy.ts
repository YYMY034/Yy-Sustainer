/**
 * MCP 按需加载活体探针（不随 run-all-checks 跑）：
 *
 *   npx tsx scripts/probe-mcp-lazy.ts
 *
 * 为什么需要它：白皮书 10.29 量出每步固定开销 22k token 里 4.3k 是 35 个 MCP 浏览器
 * 工具的 schema，而默认配置给每个会话都种了这两个服务器——纯文件/编码任务每一步都在
 * 白付。静态守卫能盯「代码接对了」，但这个优化的**行为契约**只有活体能验：
 *
 *   ① 无意在的回合（「在吗」）→ 请求里 0 个 mcp_ 工具，envScan 明说未启用
 *   ② 有意在的回合（「用浏览器打开网页」）→ 35 个 mcp_ 工具到位
 *   ③ 三态手动开关：on 强制加载 / off 强制不加载 / null 回自动——各自压过意图规则
 *   ④ 量出真实省下的 token（同一会话、同样历史，只差这一批工具）
 *
 * 做法：隔离 HOME + 真网关 + 假 provider。假 provider 把每个请求体都留下，
 * 但一律回一句短文本让回合一步结束（要量的就是请求面，不是模型行为）。
 */
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-mcplazy-"))
const PORT = await pickFreePort()
const FAKE_PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`
const WORK = join(HOME, "work")

/** 抓到的所有请求体（按到达序） */
const bodies: Array<{ tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }>; system: string }> = []

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}
const note = (s: string): void => console.log(`  · ${s}`)

function fakeProvider(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
  let raw = ""
  req.on("data", (c) => { raw += String(c) })
  req.on("end", () => {
    let stream = true
    let parsed: { stream?: boolean; messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> } = {}
    try { parsed = JSON.parse(raw) } catch { /* 按流式 */ }
    stream = parsed.stream === true
    const sysMsg = (parsed.messages ?? []).find((m) => m.role === "system")
    bodies.push({
      tools: parsed.tools ?? [],
      messages: parsed.messages ?? [],
      system: typeof sysMsg?.content === "string" ? sysMsg.content : "",
    })
    const usage = { prompt_tokens: 1000, completion_tokens: 3, total_tokens: 1003 }
    const sse = (delta: unknown, finish?: string): string =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], usage })}\n\n`
    res.writeHead(200, { "Content-Type": stream ? "text/event-stream" : "application/json" })
    if (stream) {
      res.write(sse({ role: "assistant", content: "" }))
      res.write(sse({ content: "好。" }, "stop"))
      res.write("data: [DONE]\n\n")
      res.end()
    } else {
      res.end(JSON.stringify({
        id: "c", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "摘要。" }, finish_reason: "stop" }],
        usage,
      }))
    }
  })
}

let gw: ChildProcess | undefined
let fake: Server | undefined

/** 最近一个请求体 */
const last = () => bodies[bodies.length - 1]
const mcpCount = () => last().tools.filter((t) => t.function.name.startsWith("mcp_")).length

/** 发一条消息并等这一轮的助手回复落库（/api/chat 是异步的） */
async function chat(sid: string, text: string): Promise<boolean> {
  const before = bodies.length
  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid, text }),
    signal: AbortSignal.timeout(180_000), // 首个有意在的回合要现拉 MCP（npx 冷启动），给足
  })
  if (!r.ok) return false
  const sessFile = join(HOME, ".yyagent", "sessions", `${sid}.json`)
  for (let i = 0; i < 240; i++) {
    if (bodies.length > before) return true // 请求已到 provider，回合已在跑
    await new Promise((s) => setTimeout(s, 500))
  }
  void sessFile
  return false
}

try {
  mkdirSync(WORK, { recursive: true })
  mkdirSync(join(HOME, ".yyagent"), { recursive: true })
  writeFileSync(
    join(HOME, ".yyagent", "config.json"),
    JSON.stringify({
      providers: { fake: { baseURL: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: "k" } },
      model: "fake/m1",
      permission: "full-auto",
      interactiveTimeoutMs: 0,
      maxSteps: 50,
      contextTokens: 131_072,
    }, null, 2),
  )

  fake = createServer(fakeProvider)
  await new Promise<void>((r) => fake!.listen(FAKE_PORT, "127.0.0.1", r))
  gw = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
    env: { ...process.env, HOME, USERPROFILE: HOME, YYAGENT_GATEWAY_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) }); if (r.ok) break } catch { /* 没起 */ }
    await new Promise((s) => setTimeout(s, 500))
  }
  const sid = ((await (await fetch(`${BASE}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: WORK }),
  })).json()) as { id: string }).id

  console.log(`\n=== MCP 按需加载（sid=${sid}）===\n`)

  // ① 无意在的回合：0 个 mcp_ 工具，envScan 明说未启用
  check("无意在的回合发出去了", await chat(sid, "在吗"))
  const noIntent = last()
  check("无意在 → 0 个 MCP 工具", noIntent.tools.filter((t) => t.function.name.startsWith("mcp_")).length === 0,
    `共 ${noIntent.tools.length} 个工具`)
  check("envScan 明说「本轮未启用」", noIntent.system.includes("本轮未启用"))
  check("内置工具一个没少（read/bash/edit 都在）",
    ["read", "bash", "edit", "write", "glob", "grep"].every((n) => noIntent.tools.some((t) => t.function.name === n)),
    `${noIntent.tools.length} 个内置工具`)
  const toolsTokOff = await (async () => {
    const { countTokens } = await import("gpt-tokenizer")
    return countTokens(JSON.stringify(noIntent.tools))
  })()

  // ② 有意在的回合：35 个 mcp_ 工具到位（默认种子 = edge + tabbit）
  check("有意在的回合发出去了", await chat(sid, "用浏览器打开 https://example.com 截图"))
  const withIntent = last()
  const n = withIntent.tools.filter((t) => t.function.name.startsWith("mcp_")).length
  check("有意在 → MCP 工具到位", n >= 30, `${n} 个 mcp_ 工具`)
  check("有意在 → envScan 不再说未启用", !withIntent.system.includes("本轮未启用"))
  const toolsTokOn = await (async () => {
    const { countTokens } = await import("gpt-tokenizer")
    return countTokens(JSON.stringify(withIntent.tools))
  })()
  note(`工具定义 token：无意在 ${toolsTokOff} → 有意在 ${toolsTokOn}（差 ${toolsTokOn - toolsTokOff} tok/步）`)

  // ③ 三态手动开关（各自压过意图规则）
  const setMcp = async (on: boolean | null): Promise<boolean | null> => {
    const r = await (await fetch(`${BASE}/api/sessions/${sid}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }),
    })).json() as { on: boolean | null }
    return r.on
  }
  check("手动开（on=true）写入生效", (await setMcp(true)) === true)
  check("无意在 + 手动开 → MCP 工具强制加载", await chat(sid, "在吗") && mcpCount() >= 30, `${mcpCount()} 个`)
  check("手动关（on=false）写入生效", (await setMcp(false)) === false)
  check("有意在 + 手动关 → 也不加载", await chat(sid, "用浏览器打开网页") && mcpCount() === 0, `${mcpCount()} 个`)
  check("回自动（on=null）生效", (await setMcp(null)) === null)
  check("回自动 + 无意在 → 不加载", await chat(sid, "在吗") && mcpCount() === 0, `${mcpCount()} 个`)

  // ④ GET 三态回读（前端按钮初始化用）
  const st = await (await fetch(`${BASE}/api/sessions/${sid}/mcp`)).json() as { on: boolean | null }
  check("GET 回读三态（null=自动）", st.on === null, JSON.stringify(st))

  // ⑤ 汇总：本次探针共抓到几次请求，工具面变化符合预期
  note(`共 ${bodies.length} 次请求；手动开关三轮的 mcp_ 数：${bodies.slice(-4, -1).map((b) => b.tools.filter((t) => t.function.name.startsWith("mcp_")).length).join(" / ")}`)
  check("省 token 的量级对（≥3k tok/步）", toolsTokOn - toolsTokOff >= 3000, `${toolsTokOn - toolsTokOff} tok`)
} finally {
  gw?.kill()
  fake?.close()
  rmSync(HOME, { recursive: true, force: true })
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
