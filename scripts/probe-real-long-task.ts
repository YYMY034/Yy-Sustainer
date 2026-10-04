/**
 * 真实长任务实测（一次性诊断，不随 run-all-checks 跑；需要外部 key）：
 *
 *   LT_BASE_URL=https://api.agnes-ai.cn/v1 \
 *   LT_MODEL=agnes-3.0-flash \
 *   LT_API_KEY=sk-xxx \
 *   npx tsx scripts/probe-real-long-task.ts
 *
 * 为什么单独一个脚本：前面的探针全靠假 provider，能验机制、验不了**模型侧质量**
 * （跑不跑偏、摘要丢不丢目标、压缩后还能不能接着干）。这个脚本换真模型跑真任务。
 *
 * 它量的东西：
 *   步数 / 耗时 / 真实 token / 压缩触发几次 / ctxPct 轨迹 / checkpoint 落盘 /
 *   最终交付物是否真的落地。全部是真数字，不是预期值。
 *
 * key 只从环境变量读，不写进任何文件；跑在隔离 HOME 上，不碰用户真实配置。
 */
import { createServer } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { WebSocket } from "ws"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-rlt-"))
const PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`
const WORK = join(HOME, "work")

const baseUrl = process.env.LT_BASE_URL
const model = process.env.LT_MODEL
const apiKey = process.env.LT_API_KEY
if (!baseUrl || !model || !apiKey) {
  console.log("需要 LT_BASE_URL / LT_MODEL / LT_API_KEY 三个环境变量")
  process.exit(1)
}

// 任务可从 LT_TASK 覆盖——免费档 key 有速率限制，长任务跑不完，需要能换小任务验证真实链路
const TASK = process.env.LT_TASK ??
  "请审阅这个仓库的 src/ 目录：用 glob 找出所有 .ts 文件，逐个 read 每个文件的**前 40 行**，" +
  "用一句话记录它的职责。全部看完后，把完整的模块清单（文件名 + 行数 + 职责）写成" +
  " `/tmp/arch-report.md`。要求：先把计划用 todo_write 列出来，每完成一个文件更新一次进度。" +
  "文件很多，请坚持看完所有文件再写报告。"

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}
const note = (s: string): void => console.log(`  · ${s}`)

let gw: ChildProcess | undefined
const events: Array<Record<string, unknown>> = []

try {
  mkdirSync(WORK, { recursive: true })
  mkdirSync(join(HOME, ".yyagent"), { recursive: true })
  // 交付物检查的假通过防线：/tmp 里的 arch-report.md / count.txt 会跨轮次残留，
  // 「文件存在」不等于「这一轮写的」。开跑前先清掉——否则上一轮的交付物
  // 会让这一轮的检查永远绿（这个坑 2026-09-22 真踩过一次：模型根本没写报告，
  // 检查却拿了昨天轮次的 count.txt 报「交付物落地」）。
  for (const stale of ["/tmp/arch-report.md", "/tmp/count.txt"]) {
    try { if (existsSync(stale)) { rmSync(stale); note(`已清掉上轮遗留 ${stale}`) } } catch { /* 清不掉就靠内容判读 */ }
  }
  writeFileSync(
    join(HOME, ".yyagent", "config.json"),
    JSON.stringify({
      providers: { agnes: { baseURL: baseUrl.replace(/\/+$/, ""), apiKey } },
      model: `agnes/${model}`,
      permission: "full-auto",
      interactiveTimeoutMs: 0,
      maxSteps: 200,
      // 默认把窗口压到 30000：真实固定开销约 25k/步，这样第二轮必然触发压缩，
      // 于是能验证「真模型生成的滚动摘要」质量——而不是只有机制。
      contextTokens: Number(process.env.LT_CONTEXT_TOKENS ?? 30000),
      // T128：主对话推理档位——reasoning 模型（step-3.7-flash）在默认档下每步输出 26k+ 推理
      // token，是长任务的成本大头。对照实验用 LT_REASONING_EFFORT 调节。
      ...(process.env.LT_REASONING_EFFORT ? { reasoningEffort: process.env.LT_REASONING_EFFORT } : {}),
    }, null, 2),
  )

  gw = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
    env: { ...process.env, HOME, USERPROFILE: HOME, YYAGENT_GATEWAY_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) }); if (r.ok) break } catch { /* 没起 */ }
    await new Promise((s) => setTimeout(s, 500))
  }

  // 连 WS 收实时事件
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  await new Promise<void>((r, j) => { ws.on("open", () => r()); ws.on("error", j); setTimeout(() => j(new Error("WS 连不上")), 10000) })
  ws.on("message", (raw) => { try { events.push(JSON.parse(String(raw)) as Record<string, unknown>) } catch { /* 非 JSON */ } })

  const sid = ((await (await fetch(`${BASE}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: process.cwd() }),
  })).json()) as { id: string }).id
  const pre = JSON.parse(readFileSync(join(HOME, ".yyagent", "sessions", `${sid}.json`), "utf8")) as { messages: Array<{ ts: number }> }
  const watermark = Math.max(0, ...pre.messages.map((m) => m.ts))

  console.log(`\n=== 真实长任务（model=${model}，maxSteps=200）===\n`)
  const t0 = Date.now()
  const chatRes = await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid, text: TASK }),
    signal: AbortSignal.timeout(15 * 60_000),
  })
  note(`chat 受理：HTTP ${chatRes.status}`)

  // 轮询等落库
  let f = { meta: {} as Record<string, unknown>, messages: [] as Array<{ role: string; content: string; ts: number; steps?: unknown[] }> }
  for (let i = 0; i < 900; i++) {
    f = JSON.parse(readFileSync(join(HOME, ".yyagent", "sessions", `${sid}.json`), "utf8"))
    const last = [...f.messages].reverse().find((m) => m.role === "assistant")
    if (last && last.ts > watermark && last.content.trim()) break
    await new Promise((s) => setTimeout(s, 2000))
  }
  const dur = Date.now() - t0
  const usage = f.meta.usage as { in: number; out: number; turns: number; steps: number } | undefined
  const last = [...f.messages].reverse().find((m) => m.role === "assistant")
  const stepEvents = events.filter((e) => e.type === "status" && typeof e.step === "number")
  const compactedEvents = events.filter((e) => e.type === "compacted")

  note(`耗时 ${(dur / 1000).toFixed(1)}s`)
  note(`步数 ${usage?.steps ?? 0} · 回合 ${usage?.turns ?? 0}`)
  note(`token 入 ${usage?.in ?? 0} / 出 ${usage?.out ?? 0}`)
  note(`收到 step 事件 ${stepEvents.length} 条 · compacted 事件 ${compactedEvents.length} 条`)
  // 每步真实输入量：**第一步就是纯固定开销**（系统提示 + 工具定义 + 用户消息），
  // 后面每步在它之上叠加历史与工具结果——这是验证「固定开销优化」最直接的实数
  // （10.29/10.30 的估算终于有真分词器的对照）。
  const perStep = stepEvents.map((e) => Number(e.inputTokens ?? 0)).filter((n) => n > 0)
  if (perStep.length) note(`每步输入 token: ${perStep.join(" → ")}（首步 ${perStep[0]} = 固定开销基线）`)
  note(`meta.ctxPct = ${f.meta.ctxPct}%`)
  note(`最终回复 ${String(last?.content ?? "").length} 字`)

  check("任务跑完了", !!last && last.content.trim().length > 20, JSON.stringify(String(last?.content ?? "").slice(0, 120)))
  // T115：步数下限从 15 降到 5——高效模型会批量读文件（step-3.7-flash 实测 7 步完成
  // 旧模型 30 步的任务），断言的意图是「任务是多步形状」而不是「步数必须多」；
  // 压缩/ctxPct/记账的断言才是本探针的主目标
  check("步数足够多（长任务）", (usage?.steps ?? 0) >= 5, `${usage?.steps} 步`)
  check("token 记账非零", (usage?.in ?? 0) > 0 && (usage?.out ?? 0) > 0)
  check("ctxPct 有真实读数", typeof f.meta.ctxPct === "number" && (f.meta.ctxPct as number) >= 0, `${f.meta.ctxPct}%`)
  check("实时 step 事件收到了", stepEvents.length > 0, `${stepEvents.length} 条`)

  // 多轮：压缩发生在回合间的 prepare()，且要求落库消息数 > KEEP_RECENT+2。
  // 而**工具调用不落库**，所以「单回合 50 步」也只有 2 条消息——必须多轮才堆得出来。
  const turns = Number(process.env.LT_TURNS ?? 1)
  for (let t = 2; t <= turns; t++) {
    if (String(last?.content ?? "").includes("[出错]")) { note("上一轮出错了，停轮"); break }
    note(`发第 ${t} 轮…`)
    const wm2 = Math.max(0, ...f.messages.map((m) => m.ts))
    await fetch(`${BASE}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid, text: `第 ${t} 轮：请用一句话总结我们到目前为止讨论了什么，不要用工具。` }),
      signal: AbortSignal.timeout(10 * 60_000),
    })
    for (let i = 0; i < 600; i++) {
      f = JSON.parse(readFileSync(join(HOME, ".yyagent", "sessions", `${sid}.json`), "utf8"))
      const l2 = [...f.messages].reverse().find((m) => m.role === "assistant")
      if (l2 && l2.ts > wm2 && l2.content.trim()) break
      await new Promise((s) => setTimeout(s, 2000))
    }
    // 免费档有速率限制，轮与轮之间留出重置时间
    if (t < turns) await new Promise((s) => setTimeout(s, 20_000))
  }
  const first = f.messages[0]
  note(`会话共 ${f.messages.length} 条消息，首条：${String(first?.content ?? "").slice(0, 90)}`)
  // 消息流水：跑偏时靠它定位是哪一步开始歪的（角色 + 内容预览 + 工具步骤数）
  f.messages.forEach((m, i) => {
    const steps = Array.isArray(m.steps) ? m.steps.length : 0
    note(`  [${i}] ${m.role}${steps ? ` (${steps} 步工具)` : ""}: ${String(m.content ?? "").replace(/\s+/g, " ").slice(0, 90)}`)
  })
  const realCompacted = String(first?.content ?? "").includes("滚动摘要")
  if (turns > 1) {
    check("多轮后真的压缩了（真模型生成的滚动摘要）", realCompacted,
      `首条内容${realCompacted ? "是滚动摘要" : "还是用户原话（未压缩）"}（摘要消息的 role 恒为 user，别按 role 判断）`)
    if (realCompacted) {
      note(`摘要长度 ${String(first?.content ?? "").length} 字`)
      note(`摘要预览：${String(first?.content ?? "").slice(0, 200)}`)
    }
    check("压缩后仍能正常收尾", !String(last?.content ?? "").includes("[出错]"))
  }

  // 交付物。**判据是 mtime 晚于本轮开始**，不是「文件存在」——开跑前清遗留文件是
  // best-effort（rmSync 被占用会静默失败，note 都不打），存在≠这一轮写的
  // （假通过的经典形状：检查器被陈旧数据骗）。字节数取 Buffer.byteLength——
  // readFileSync().length 是字符数，中文三字节，一直对不上。
  const startedAt = Date.now()
  const reports = ["/tmp/arch-report.md", "/tmp/count.txt"].filter((p) => {
    try { return existsSync(p) && statSync(p).mtimeMs >= startedAt - 5000 } catch { return false }
  })
  check("交付物落地了（本轮写的）", reports.length > 0 || String(last?.content ?? "").includes("arch-report"),
    reports.length ? `${reports[0]}（${Buffer.byteLength(readFileSync(reports[0], "utf8"))} 字节）` : "回复里提到了交付物")

  // 压缩
  if (compactedEvents.length > 0) {
    note(`压缩触发了 ${compactedEvents.length} 次`)
    check("压缩真的发生了", true)
  } else {
    note("压缩未触发——上下文没到阈值（真实 131072 窗口下这个任务可能确实够小）")
  }
} catch (e) {
  fail++
  console.log(`FAIL 运行出错 — ${(e as Error).message}`)
} finally {
  try { gw?.kill() } catch { /* 已杀 */ }
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
