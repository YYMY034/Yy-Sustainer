/**
 * T94：行为评测跑批器。
 *
 *   npx tsx scripts/eval/runner.ts --fake                 # 假 provider 管线自检（离线、免费）
 *   npx tsx scripts/eval/runner.ts                        # 真实模型跑全部离线场景（读 config.model）
 *   npx tsx scripts/eval/runner.ts --model bai/qwen3.8-flash
 *   npx tsx scripts/eval/runner.ts --only write-file,minimal-edit --json
 *   npx tsx scripts/eval/runner.ts --online               # 连 online 场景一起跑
 *
 * 每个场景一个隔离沙箱：临时 HOME（USERPROFILE 指过去）+ 临时工作区 + 独立网关子进程
 * （~/.yyagent 定位是模块级常量，进程内换不了——tests 的坑 106，子进程是唯一隔离法）。
 * 场景从 POST /api/chat 进，轮询 /api/sessions/:id 拿最终 assistant 消息，
 * 按「文本 + 工具调用名 + 工作区文件」三维打分。
 *
 * 设计取舍：走**真网关**而不是直调 runAgentStream——评测的是用户实际走的那条链路
 * （权限门/钩子/压缩/落库全在里面），直调引擎会漏掉一整类「接线没接上」的退化。
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { pickFreePort } from "../pick-port.js"
import { BUILTIN_HOOKS } from "../../src/agent/config.js"
import { EVAL_SCENARIOS, FAKE_SCENARIOS, type EvalScenario } from "./scenarios.js"
import { startFakeProvider } from "./fake-provider.js"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

// ---------- 打分（纯函数，供 check 直接单测） ----------

export interface TurnObservation {
  text: string
  /** 本回合调用过的工具名（去重） */
  tools: string[]
  /** 工作区文件快照：posix 相对路径 → 内容 */
  files: Map<string, string>
}

export interface ScenarioVerdict {
  id: string
  pass: boolean
  failures: string[]
}

const cut = (s: string, n = 120): string => (s.length > n ? s.slice(0, n) + "…" : s)

export function scoreScenario(sc: EvalScenario, obs: TurnObservation): ScenarioVerdict {
  const failures: string[] = []
  for (const e of sc.expect) {
    let ok = true
    let why = ""
    switch (e.kind) {
      case "text-contains":
        ok = obs.text.includes(e.value)
        why = `文本里没有「${e.value}」（实际：${cut(obs.text) || "<空>"})`
        break
      case "text-not-contains":
        ok = !obs.text.includes(e.value)
        why = `文本不该出现「${e.value}」却出现了（上下文：${cut(obs.text)}）`
        break
      case "text-matches":
        ok = new RegExp(e.pattern, e.flags ?? "").test(obs.text)
        why = `文本不匹配 /${e.pattern}/${e.flags ?? ""}（实际：${cut(obs.text) || "<空>"}）`
        break
      case "text-not-matches":
        ok = !new RegExp(e.pattern, e.flags ?? "").test(obs.text)
        why = `文本不该匹配 /${e.pattern}/${e.flags ?? ""} 却匹配了（实际：${cut(obs.text)}）`
        break
      case "tool-called":
        ok = obs.tools.includes(e.tool)
        why = `本回合没调用过 ${e.tool}（实际调用：${obs.tools.join(", ") || "<无>"}）`
        break
      case "tool-not-called":
        ok = !obs.tools.includes(e.tool)
        why = `本回合不该调用 ${e.tool} 却调用了（实际调用：${obs.tools.join(", ")}）`
        break
      case "file-exists":
        ok = obs.files.has(e.path)
        why = `工作区里没有文件 ${e.path}（实际有：${[...obs.files.keys()].join(", ") || "<无>"}）`
        break
      case "file-contains": {
        const c = obs.files.get(e.path)
        ok = c !== undefined && c.includes(e.value)
        why = c === undefined ? `文件 ${e.path} 不存在，无法断言内容` : `文件 ${e.path} 里没有「${e.value}」（实际：${cut(c)}）`
        break
      }
      case "file-not-contains": {
        const c = obs.files.get(e.path)
        ok = c === undefined || !c.includes(e.value)
        why = `文件 ${e.path} 里不该有「${e.value}」（实际：${cut(c ?? "")}）`
        break
      }
    }
    if (!ok) failures.push(why)
  }
  return { id: sc.id, pass: failures.length === 0, failures }
}

// ---------- 沙箱执行 ----------

type SessionMsg = { role: string; content: string; ts: number; steps?: Array<{ name: string }> }

async function waitGateway(base: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return true
    } catch { /* 没起 */ }
    await new Promise((s) => setTimeout(s, 500))
  }
  return false
}

function walkFiles(root: string, dir = root, out: Map<string, string> = new Map(), depth = 0): Map<string, string> {
  if (depth > 4) return out
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch { /* 目录没了 */ }
  for (const name of entries) {
    if (name === "node_modules" || name === ".agent-outputs" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p, { throwIfNoEntry: false })
    if (!st) continue
    if (st.isDirectory()) walkFiles(root, p, out, depth + 1)
    else if (st.isFile() && st.size < 262_144) {
      const rel = p.slice(root.length + 1).split("\\").join("/")
      try { out.set(rel, readFileSync(p, "utf8")) } catch { /* 二进制等读不了就当没有 */ }
    }
  }
  return out
}

export interface RunOptions {
  /** provider 名（真实模式必填）；fake 模式固定 eval */
  provider: string
  baseURL: string
  apiKey: string
  modelId: string
}

async function runScenario(sc: EvalScenario, opts: RunOptions): Promise<{ verdict: ScenarioVerdict; ms: number; textPreview: string }> {
  const t0 = Date.now()
  const home = mkdtempSync(join(tmpdir(), "yy-eval-"))
  const work = join(home, "work")
  let gw: ChildProcess | undefined
  try {
    mkdirSync(work, { recursive: true })
    for (const f of sc.seed ?? []) {
      const p = join(work, ...f.path.split("/"))
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, f.content)
    }
    mkdirSync(join(home, ".yyagent"), { recursive: true })
    writeFileSync(
      join(home, ".yyagent", "config.json"),
      JSON.stringify({
        providers: { [opts.provider]: { baseURL: opts.baseURL, apiKey: opts.apiKey } },
        model: `${opts.provider}/${opts.modelId}`,
        permission: "danger-confirm",
        maxSteps: 12,
        // T115：交互超时不能是 0——网关会话永远有 broker，模型发起确认/提问后无人应答，
        // 0 = 无限等人。也不能太小（它是**整轮**计时，reasoning 模型第一步思考就要 15s+，
        // 15s 会把正常工作的轮次拦腰砍断）：120s = 让模型正常干活，真发起提问且无人应答时
        // 到点按默认项（拒绝）应答，危险命令场景因此能走完拒绝路径
        interactiveTimeoutMs: 120_000,
        mcpServers: {},
        // 评测量的是基础行为，不是钩子开销——loadConfig 会把内置钩子补回来，这里显式全关
        hooks: BUILTIN_HOOKS.map((h) => ({ ...h, enabled: false })),
      }),
    )

    const port = await pickFreePort()
    const base = `http://127.0.0.1:${port}`
    gw = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
      cwd: REPO,
      env: { ...process.env, HOME: home, USERPROFILE: home, YYAGENT_GATEWAY_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (!(await waitGateway(base))) {
      return { verdict: { id: sc.id, pass: false, failures: ["网关 30 秒内没起来"] }, ms: Date.now() - t0, textPreview: "" }
    }

    const sid = ((await (await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: work }),
    })).json()) as { id: string }).id

    const pre = (await (await fetch(`${base}/api/sessions/${sid}`)).json()) as { messages: SessionMsg[] }
    const watermark = Math.max(0, ...pre.messages.map((m) => m.ts))

    await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid, text: sc.prompt }),
    })

    const timeout = sc.timeoutMs ?? 180_000
    let last: SessionMsg | undefined
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const cur = (await (await fetch(`${base}/api/sessions/${sid}`)).json()) as { messages: SessionMsg[] }
      last = [...cur.messages].reverse().find((m) => m.role === "assistant" && m.ts > watermark)
      if (last && last.content.trim()) break
      await new Promise((s) => setTimeout(s, 400))
    }

    const text = last?.content ?? ""
    const tools = [...new Set((last?.steps ?? []).map((s) => s.name))]
    const files = walkFiles(work)
    const obs: TurnObservation = { text, tools, files }
    if (!text.trim()) {
      obs.text = ""
      return {
        verdict: { id: sc.id, pass: false, failures: [`超时（${timeout}ms）或回合没有产出文本`] },
        ms: Date.now() - t0,
        textPreview: "",
      }
    }
    return { verdict: scoreScenario(sc, obs), ms: Date.now() - t0, textPreview: cut(text, 300) }
  } finally {
    try { gw?.kill() } catch { /* 已死 */ }
    // 给子进程一点退场时间再删目录，Windows 上目录被占用时 rm 会炸
    await new Promise((s) => setTimeout(s, 300))
    try { rmSync(home, { recursive: true, force: true }) } catch { /* 留给系统临时目录 */ }
  }
}

// ---------- CLI ----------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  // 支持 --key=value 和 --key value 两种写法（值不是 -- 开头才算值）
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const eq = a.indexOf("=")
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1)
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { out[a.slice(2)] = argv[i + 1]; i++ }
    else out[a.slice(2)] = true
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const fake = args["fake"] === true
  const online = args["online"] === true
  const only = typeof args["only"] === "string" ? String(args["only"]).split(",").map((s) => s.trim()) : null
  const jsonOut = args["json"] === true
  const gate = typeof args["gate"] === "string" ? Number(args["gate"]) : 1

  let scenarios: EvalScenario[]
  let runOpts: RunOptions
  let modeLabel: string

  if (fake) {
    scenarios = FAKE_SCENARIOS
    const { port } = await startFakeProvider(FAKE_SCENARIOS)
    runOpts = { provider: "eval", baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "sk-eval", modelId: "fake-1" }
    modeLabel = "fake（管线自检，与真实模型行为无关）"
    // 服务器开着不碍事：结尾 process.exit 会连句柄一起带走
  } else {
    scenarios = EVAL_SCENARIOS
    if (!online) scenarios = scenarios.filter((s) => !s.online)
    // 真实模式：key 只在内存里转手，写进沙箱的 config.json（临时目录，跑完即删），不打印
    const { loadConfig } = await import("../../src/agent/config.js")
    const cfg = loadConfig()
    const spec = typeof args["model"] === "string" ? String(args["model"]) : cfg.model
    const slash = spec.indexOf("/")
    if (slash <= 0) {
      console.error(`--model 要是 provider/modelId 形式（实际：${spec}）`)
      process.exit(2)
    }
    const providerName = spec.slice(0, slash)
    const provider = cfg.providers?.[providerName]
    if (!provider?.baseURL || !provider.apiKey) {
      console.error(`config 里没有 provider「${providerName}」的 baseURL/apiKey`)
      process.exit(2)
    }
    runOpts = { provider: providerName, baseURL: provider.baseURL, apiKey: provider.apiKey, modelId: spec.slice(slash + 1) }
    modeLabel = `real ${spec}`
  }

  if (only) scenarios = scenarios.filter((s) => only.includes(s.id))
  if (!scenarios.length) {
    console.error("没有可跑的场景（检查 --only / --online）")
    process.exit(2)
  }

  const results: Array<{ verdict: ScenarioVerdict; ms: number; title: string; textPreview: string }> = []
  for (const sc of scenarios) {
    if (!jsonOut) process.stdout.write(`… ${sc.id} ${sc.title}\n`)
    const r = await runScenario(sc, runOpts)
    results.push({ ...r, title: sc.title })
  }

  if (jsonOut) {
    console.log(JSON.stringify(results.map((r) => ({ id: r.verdict.id, title: r.title, pass: r.verdict.pass, failures: r.verdict.failures, ms: r.ms, text: r.textPreview })), null, 2))
  } else {
    console.log("")
    for (const r of results) {
      console.log(`${r.verdict.pass ? "✔" : "✘"} ${r.verdict.id} ${r.title}（${(r.ms / 1000).toFixed(1)}s）`)
      for (const f of r.verdict.failures) console.log(`    · ${f}`)
    }
    const passN = results.filter((r) => r.verdict.pass).length
    console.log(`\n合计：${passN}/${results.length} 通过 | 模式 ${modeLabel}`)
  }

  const passN = results.filter((r) => r.verdict.pass).length
  const rate = results.length ? passN / results.length : 0
  process.exit(rate >= gate ? 0 : 1)
}

// 被 check 脚本 import 时只取纯函数，不自动跑（Windows 路径大小写不敏感比较）
const isMain = (() => {
  try {
    return !!process.argv[1] && join(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
  } catch {
    return false
  }
})()
if (isMain) {
  main().catch((e) => {
    console.error(`runner 出错：${(e as Error).stack ?? e}`)
    process.exit(1)
  })
}
