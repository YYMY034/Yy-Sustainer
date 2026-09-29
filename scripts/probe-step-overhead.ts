/**
 * 每步固定开销拆解探针（不随 run-all-checks 跑）：
 *
 *   npx tsx scripts/probe-step-overhead.ts            # 默认 cwd = 本仓库（与 24k 实测同环境）
 *   npx tsx scripts/probe-step-overhead.ts --cwd <p>  # 换工作区
 *
 * 为什么需要它：白皮书 10.27 用真模型量出「每步固定开销 ≈ 24k token」（与任务大小无关），
 * 并指出这是长任务成本的最大杠杆——但 24k 是**总数**，不知道构成就无从优化。
 * 这个探针把一次真实请求的 wire payload 原样抓下来，按 gpt-tokenizer（与压缩判定
 * 同一把尺子）逐块量：基础层 / 环境扫描 / 评分反馈 / todo / 技能 / 注入 / 工具定义
 * / 消息，并给出每个工具的细分（描述 vs 参数 schema）。
 *
 * 做法：隔离 HOME + 真网关 + 假 provider。假 provider 只做一件事——把收到的第一个
 * 请求体落盘成 JSON，然后回一句短文本让回合结束（1 步，不触发工具）。
 */
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-ovh-"))
const PORT = await pickFreePort()
const FAKE_PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`
const WORK = process.argv.includes("--cwd") ? process.argv[process.argv.indexOf("--cwd") + 1] : process.cwd()
const CAPTURE = join(HOME, "first-request.json")

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}
const note = (s: string): void => console.log(`  · ${s}`)

/** 假 provider：抓第一个请求体落盘；之后一律回短文本（1 步结束，不跑工具） */
let fakeHits = 0
function fakeProvider(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
  let raw = ""
  req.on("data", (c) => { raw += String(c) })
  req.on("end", () => {
    fakeHits++
    console.error(`[fake] hit #${fakeHits} ${req.method} ${req.url} ${raw.length}B`)
    let stream = true
    try { stream = (JSON.parse(raw) as { stream?: boolean }).stream === true } catch { /* 按流式 */ }
    try {
      if (!readFileSync(CAPTURE, "utf8").length) writeFileSync(CAPTURE, raw)
    } catch (e) { console.error(`[fake] capture write failed: ${(e as Error).message}`) }
    const usage = { prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005 }
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

try {
  mkdirSync(join(HOME, ".yyagent"), { recursive: true })
  writeFileSync(
    join(HOME, ".yyagent", "config.json"),
    JSON.stringify({
      providers: { fake: { baseURL: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: "k" } },
      model: "fake/m1",
      permission: "full-auto",
      interactiveTimeoutMs: 0,
      maxSteps: 200,
      contextTokens: 131_072,
    }, null, 2),
  )
  writeFileSync(CAPTURE, "")

  fake = createServer(fakeProvider)
  await new Promise<void>((r) => fake!.listen(FAKE_PORT, "127.0.0.1", r))
  gw = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
    env: { ...process.env, HOME, USERPROFILE: HOME, YYAGENT_GATEWAY_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) }); if (r.ok) break } catch { /* 没起 */ }
    await new Promise((s) => setTimeout(s, 500))
  }

  const sid = ((await (await fetch(`${BASE}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: WORK }),
  })).json()) as { id: string }).id

  const chatRes = await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid, text: "在吗" }),
    signal: AbortSignal.timeout(60_000),
  })
  check("chat 受理", chatRes.ok, `HTTP ${chatRes.status}`)

  // /api/chat 是异步的：轮询会话文件，等助手回复真的落库（回合结束）再量
  const sessFile = join(HOME, ".yyagent", "sessions", `${sid}.json`)
  let done = false
  for (let i = 0; i < 120; i++) {
    try {
      const s = JSON.parse(readFileSync(sessFile, "utf8")) as { messages: Array<{ role: string }> }
      if (s.messages.some((m) => m.role === "assistant")) { done = true; break }
    } catch { /* 还没落 */ }
    await new Promise((s) => setTimeout(s, 500))
  }
  check("回合跑完（助手回复已落库）", done)

  // ---- 逐块测量 ----
  const { countTokens } = await import("gpt-tokenizer")
  const raw = readFileSync(CAPTURE, "utf8")
  check("抓到了第一个请求体", raw.length > 0, `${raw.length} 字节`)
  const body = JSON.parse(raw) as {
    messages?: Array<{ role: string; content: unknown }>
    tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>
    model?: string
  }

  // system 段：OpenAI 兼容格式是 role=system 的消息；两种形态都认
  const sysMsg = (body.messages ?? []).find((m) => m.role === "system")
  const system = typeof sysMsg?.content === "string" ? sysMsg.content : ""
  check("system 段拿到了", system.length > 1000, `${system.length} 字符`)

  // 按注入点标记切分（与 gateway.ts 的构造一一对应）
  const MARKERS: Array<[string, string]> = [
    ["环境扫描 envScan", "【工作环境扫描】"],
    ["评分反馈 feedback", "【回答评分机制】"],
    ["todo 计划注入", "【当前任务计划】"],
    ["技能清单 skills", "## Skills（工作流文档）"],
  ]
  const cuts: Array<{ name: string; at: number }> = []
  for (const [name, marker] of MARKERS) {
    const at = system.indexOf(marker)
    if (at >= 0) cuts.push({ name, at })
  }
  cuts.sort((a, b) => a.at - b.at)
  // 基础层 = 第一个标记之前的部分（composeSystem 里基础层永远在最前）
  const base = cuts.length ? system.slice(0, cuts[0].at) : system
  const parts: Array<{ name: string; chars: number; tokens: number }> = [
    { name: "基础层 SYSTEM_PROMPT", chars: base.length, tokens: countTokens(base) },
  ]
  for (let i = 0; i < cuts.length; i++) {
    const seg = system.slice(cuts[i].at, i + 1 < cuts.length ? cuts[i + 1].at : undefined)
    parts.push({ name: cuts[i].name, chars: seg.length, tokens: countTokens(seg) })
  }

  // 工具定义：逐工具细分 描述 / 参数 schema
  const tools = body.tools ?? []
  check("请求带了工具定义", tools.length > 0, `${tools.length} 个`)
  const perTool = tools.map((t) => {
    const fn = t.function ?? (t as unknown as { function: { name: string } }).function
    const desc = fn.description ?? ""
    const params = JSON.stringify(fn.parameters ?? {})
    return { name: fn.name, descTokens: countTokens(desc), paramTokens: countTokens(params), total: countTokens(desc) + countTokens(params) }
  }).sort((a, b) => b.total - a.total)
  const toolsTotal = perTool.reduce((s, t) => s + t.total, 0)

  // 消息段（本轮用户消息，基本可忽略——固定开销的对照）
  const nonSys = (body.messages ?? []).filter((m) => m.role !== "system")
  const msgsTokens = nonSys.reduce((s, m) => s + countTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content)), 0)

  const sysTotal = parts.reduce((s, p) => s + p.tokens, 0)
  const wireTotal = sysTotal + toolsTotal + msgsTokens

  // ---- 报告 ----
  console.log(`\n=== 每步固定开销拆解（cwd=${WORK}）===\n`)
  console.log("系统提示词构成：")
  for (const p of parts.sort((a, b) => b.tokens - a.tokens)) {
    console.log(`  ${p.name.padEnd(24)} ${String(p.tokens).padStart(6)} tok  (${p.chars} 字符)`)
  }
  console.log(`  ${"小计".padEnd(24)} ${String(sysTotal).padStart(6)} tok`)
  console.log(`\n工具定义（共 ${tools.length} 个，合计 ${toolsTotal} tok）：`)
  for (const t of perTool) {
    console.log(`  ${t.name.padEnd(22)} ${String(t.total).padStart(5)} tok  (描述 ${t.descTokens} / 参数 ${t.paramTokens})`)
  }
  console.log(`\n消息段（用户消息，${nonSys.length} 条）：${msgsTokens} tok`)
  console.log(`\n★ 每步固定开销合计 ≈ ${wireTotal} tok（系统 ${sysTotal} + 工具 ${toolsTotal} + 消息 ${msgsTokens}）`)
  console.log(`★ wire 字节 ${raw.length}；工具定义占固定开销 ${(toolsTotal / wireTotal * 100).toFixed(1)}%`)

  // ---- 断言（探针自检：量到的数必须落在预期区间） ----
  // 区间随优化推进下调过两次：初版 18k-32k（优化前实测 ≈24k，白皮书 10.27）；
  // 10.29/10.30 两轮优化后实测 ≈17k（agnes 分词器 17,027 / deepseek 16,582），
  // 下限随之下调——**别再把区间钉在产线已经走开的旧数字上**（本次就踩了：
  // 优化后第一次跑，17,027 低于 18k 下限，探针自己红了一个小时的「假失败」）。
  check("固定开销落在预期区间（优化后 ≈17k，区间 15k-32k）", wireTotal >= 15_000 && wireTotal <= 32_000, `${wireTotal} tok`)
  check("基础层是最大单块", parts.every((p) => p.name === "基础层 SYSTEM_PROMPT" || p.tokens < countTokens(base)), "其余注入均小于基础层")
  const biggestTool = perTool[0]
  check("量到了最大的工具（用于定位优化对象）", !!biggestTool && biggestTool.total > 200, `${biggestTool?.name} ${biggestTool?.total} tok`)
  note("下一步：按这个拆解决定先砍哪块（基础层分层 / 工具 schema 精简 / 注入瘦身）")
} finally {
  gw?.kill()
  fake?.close()
  rmSync(HOME, { recursive: true, force: true })
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
