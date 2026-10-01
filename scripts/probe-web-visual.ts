/**
 * T96 视觉验收探针（不随 run-all-checks 跑；改 web/index.html 布局/主题后手动跑，或改完让 check 之前先看一眼）：
 *
 *   npx tsx scripts/probe-web-visual.ts            # 几何断言 + 截图（离线，免费）
 *   npx tsx scripts/probe-web-visual.ts --judge    # 截图再交识图模型判一遍（花一点钱）
 *
 * 为什么要有它：check-*.mjs 都是拿正则 grep index.html——守得住「代码在」，守不住「页面长对了」。
 * 踩坑 #21 的教训在 Web 侧同样成立：要看真渲染，不要看源码。TUI 侧已有 node-pty + xterm 回归，
 * 这里补上 Web 侧的等价物：Electron offscreen 渲染 → 整页截图 + 几何快照 + 页面错误收集。
 *
 * 断言（main / settings 两视图）：无横向溢出、composer 在视口内、#messages 在、
 * 设置页能打开、页面零 JS 错误、截图落盘 logs/visual/web-*.png。
 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { pickFreePort } from "./pick-port.js"
import { BUILTIN_HOOKS } from "../src/agent/config.js"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const HOME = mkdtempSync(join(tmpdir(), "yy-visual-"))
const OUT = join(REPO, "logs", "visual")
const PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`
const JUDGE = process.argv.includes("--judge")

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

interface ShotResult {
  view: string
  file?: string
  error?: string
  geo?: {
    title: string
    scrollW: number
    innerW: number
    innerH: number
    composerBottom: number | null
    composerVisible: boolean
    hasMessages: boolean
    settingsShown: boolean
    isLight: boolean
    pageErrors: string[]
  }
}

let gw: ReturnType<typeof spawn> | undefined
try {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(join(HOME, ".yyagent"), { recursive: true })
  // 提供一个假 provider：只为让 /api/onboard/state 不弹引导罩（baseURL 不会被真调用）
  writeFileSync(join(HOME, ".yyagent", "config.json"), JSON.stringify({
    providers: { eval: { baseURL: "http://127.0.0.1:9/v1", apiKey: "sk-visual" } },
    model: "eval/m1",
    permission: "danger-confirm",
    interactiveTimeoutMs: 0,
    mcpServers: {},
    hooks: BUILTIN_HOOKS.map((h) => ({ ...h, enabled: false })),
  }))

  gw = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
    cwd: REPO,
    env: { ...process.env, HOME, USERPROFILE: HOME, YYAGENT_GATEWAY_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let up = false
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) }); if (r.ok) { up = true; break } } catch { /* 没起 */ }
    await new Promise((s) => setTimeout(s, 500))
  }
  check("网关起来了", up)
  if (!up) throw new Error("gateway failed to start")
  await fetch(`${BASE}/api/onboard/done`, { method: "POST" }).catch(() => { /* 引导罩关不掉也不拦 */ })

  const resultsFile = join(OUT, `results-${process.pid}.json`)
  const electronPath = createRequire(import.meta.url)("electron") as unknown as string
  const child = spawn(electronPath, [
    join(REPO, "scripts", "visual", "electron-shot.cjs"),
    `--base=${BASE}`,
    `--out=${OUT}`,
    `--json=${resultsFile}`,
    "--views=main,settings,main-dark",
  ], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] })
  let shotStderr = ""
  child.stderr?.on("data", (d) => { shotStderr += String(d) })
  child.on("error", () => { /* spawn 失败也要让等待分支退场（electron 缺失等），results 为空即报红 */ })
  let results: ShotResult[] = []
  // electron 挂死也不能把探针挂死：60s 硬顶，到点强杀
  const exited = new Promise<void>((r) => child.once("exit", () => r()))
  const hardStop = new Promise<void>((r) => {
    setTimeout(() => {
      try { child.kill() } catch { /* 已死 */ }
      r()
    }, 60_000)
  })
  for (let i = 0; i < 60 && !existsSync(resultsFile) && child.exitCode === null; i++) {
    await new Promise((s) => setTimeout(s, 1000))
  }
  await Promise.race([exited, hardStop])
  if (existsSync(resultsFile)) results = JSON.parse(readFileSync(resultsFile, "utf8")) as ShotResult[]
  try { rmSync(resultsFile, { force: true }) } catch { /* 临时文件 */ }

  const main = results.find((r) => r.view === "main")
  const settings = results.find((r) => r.view === "settings")
  const dark = results.find((r) => r.view === "main-dark")
  check("三个视图都渲染成功（无 electron 异常）", !main?.error && !settings?.error && !dark?.error, `${main?.error ?? ""}${settings?.error ?? ""}${dark?.error ?? ""}${shotStderr.slice(0, 200)}`)

  if (main?.geo) {
    const g = main.geo
    check("主视图无横向溢出", g.scrollW <= g.innerW, `scrollW=${g.scrollW} innerW=${g.innerW}`)
    check("主视图 composer 在视口内且可见", g.composerVisible === true && g.composerBottom !== null, `bottom=${g.composerBottom} innerH=${g.innerH}`)
    check("主视图 #messages 在", g.hasMessages === true)
    check("主视图零页面 JS 错误", (g.pageErrors?.length ?? 0) === 0, JSON.stringify(g.pageErrors ?? []))
  }
  if (settings?.geo) {
    const g = settings.geo
    check("设置页能打开（#setPage.show）", g.settingsShown === true)
    check("设置页无横向溢出", g.scrollW <= g.innerW, `scrollW=${g.scrollW} innerW=${g.innerW}`)
    check("设置页零页面 JS 错误", (g.pageErrors?.length ?? 0) === 0, JSON.stringify(g.pageErrors ?? []))
  }
  if (dark?.geo) {
    const g = dark.geo
    check("暗色主题真的切过去了（html 无 light 类）", g.isLight === false, `isLight=${g.isLight}`)
    check("暗色视图无横向溢出", g.scrollW <= g.innerW, `scrollW=${g.scrollW} innerW=${g.innerW}`)
    check("暗色视图 composer 仍在视口内", g.composerVisible === true)
    check("暗色视图零页面 JS 错误", (g.pageErrors?.length ?? 0) === 0, JSON.stringify(g.pageErrors ?? []))
  }
  for (const r of [main, settings, dark]) {
    if (r?.file) {
      const sz = statSync(r.file, { throwIfNoEntry: false })?.size ?? 0
      check(`截图落盘且非空（${r.view}）`, existsSync(r.file) && sz > 10_000, `${r.file} ${sz}B`)
    }
  }

  if (JUDGE && main?.file) {
    // 识图判定：把截图交视觉模型，按验收清单给结构化结论。判定失败不拦截——它是参考意见不是门禁
    console.log("\n── 识图判定（参考意见，不作为门禁）──")
    try {
      const { generateText } = await import("ai")
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible")
      const { loadConfig } = await import("../src/agent/config.js")
      const cfg = loadConfig()
      const spec = cfg.visionModel ?? cfg.model
      const slash = spec.indexOf("/")
      const prov = cfg.providers?.[spec.slice(0, slash)]
      if (!prov?.baseURL || !prov.apiKey) throw new Error("没有可用的视觉模型配置")
      const model = createOpenAICompatible({ name: spec.slice(0, slash), baseURL: prov.baseURL, apiKey: prov.apiKey })(spec.slice(slash + 1))
      const b64 = readFileSync(main.file).toString("base64")
      const r = await generateText({
        model,
        system: "你是 UI 验收员。只输出一个 JSON 对象，不要输出其他任何文字。",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "这是本地 AI 助手 Web 界面的截图。请验收并只输出 JSON：{\"pass\": true/false, \"issues\": [\"具体问题\"]}。检查：布局是否破损/重叠、文字是否被截断、配色是否协调、控件是否对齐。轻微的主观审美问题不算 fail。" },
              { type: "image", image: b64 },
            ],
          },
        ],
      })
      const raw = r.text.trim().replace(/^```(json)?|```$/g, "").trim()
      const verdict = JSON.parse(raw) as { pass: boolean; issues?: string[] }
      check("识图判定通过", verdict.pass === true, (verdict.issues ?? []).join(" | ").slice(0, 300))
    } catch (e) {
      console.log(`（识图判定没跑成：${(e as Error).message}——不影响几何门禁）`)
    }
  } else if (JUDGE) {
    console.log("（没有主视图截图可判，跳过识图判定）")
  }
} catch (e) {
  fail++
  console.log(`FAIL 运行出错 — ${(e as Error).stack ?? e}`)
} finally {
  try { gw?.kill() } catch { /* 已杀 */ }
  await new Promise((s) => setTimeout(s, 300))
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
