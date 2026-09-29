/**
 * svg 围栏协议真模型首秀（不随 run-all-checks 跑；需 LT_BASE_URL/LT_MODEL/LT_API_KEY）。
 *
 *   LT_BASE_URL=https://api.agnes-ai.cn/v1 LT_MODEL=agnes-3.0-flash LT_API_KEY=sk-xxx \
 *   npx tsx scripts/probe-svg-fence.ts
 *
 * 为什么需要：svg 围栏（白皮书 10.33）上线后只被单元测试验过——模型从没在真实任务里
 * 吐过一次 ```svg 围栏。这个探针让真模型画一张三层架构图，把整条链路走一遍：
 *   ① 模型真的用了围栏（协议被理解，不是提示词自嗨）
 *   ② 围栏里的 SVG 过 sanitizeSvg（不被剥空）
 *   ③ 纪律生效：viewBox 在、无 script 与 on 事件属性、外链（硬约束没白写）
 *   ④ renderSvgBlock 非 null（净化→渲染整条通）
 * 任何一条不过，协议就还在「看起来能跑」状态。
 */
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"

const baseUrl = process.env.LT_BASE_URL
const model = process.env.LT_MODEL
const apiKey = process.env.LT_API_KEY
if (!baseUrl || !model || !apiKey) {
  console.log("需要 LT_BASE_URL / LT_MODEL / LT_API_KEY 三个环境变量")
  process.exit(1)
}

const HOME = mkdtempSync(join(tmpdir(), "yy-svg-"))
const PORT = 8814
const BASE = `http://127.0.0.1:${PORT}`
const WORK = join(HOME, "work")

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}
const note = (s: string): void => console.log(`  · ${s}`)

/** 从 web/index.html 抽 sanitizeSvg（与 tests/webSvgFence.test.ts 同一手法）在 node 里跑 */
function loadSanitizer(): (src: string) => string | null {
  const web = readFileSync(new URL("../web/index.html", import.meta.url), "utf8")
  const start = web.indexOf("function sanitizeSvg(src)")
  if (start < 0) throw new Error("web/index.html 里找不到 sanitizeSvg")
  const end = web.indexOf("\n}\n", web.indexOf("return s", start))
  if (end < 0) throw new Error("找不到 sanitizeSvg 结尾")
  return new Function(web.slice(start, end + 2) + "; return sanitizeSvg")() as (src: string) => string | null
}
const sanitize = loadSanitizer()

const TASK = "请画一张三层架构示意图（接入层 / 服务层 / 存储层，层间标注主要调用关系）。" +
  "要求：用 ```svg 围栏手写 SVG 原文，必须带 viewBox=\"0 0 680 300\"，含至少 6 个矩形节点和标注文字；" +
  "不得使用 script、事件属性、style 元素或外链。画之前在回复里用一句话说明图的内容。"

let gw: ChildProcess | undefined

try {
  mkdirSync(WORK, { recursive: true })
  mkdirSync(join(HOME, ".yyagent"), { recursive: true })
  writeFileSync(
    join(HOME, ".yyagent", "config.json"),
    JSON.stringify({
      providers: { agnes: { baseURL: baseUrl.replace(/\/+$/, ""), apiKey } },
      model: `agnes/${model}`,
      permission: "full-auto",
      interactiveTimeoutMs: 0,
      maxSteps: 10,
      contextTokens: 131_072,
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
  const sid = ((await (await fetch(`${BASE}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: WORK }),
  })).json()) as { id: string }).id

  const chat = await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid, text: TASK }),
    signal: AbortSignal.timeout(5 * 60_000),
  })
  check("chat 受理", chat.ok, `HTTP ${chat.status}`)

  // 轮询等落库
  let content = ""
  const sessFile = join(HOME, ".yyagent", "sessions", `${sid}.json`)
  for (let i = 0; i < 120; i++) {
    try {
      const s = JSON.parse(readFileSync(sessFile, "utf8")) as { messages: Array<{ role: string; content: string }> }
      const last = [...s.messages].reverse().find((m) => m.role === "assistant")
      if (last && last.content.trim()) { content = last.content; break }
    } catch { /* 没落 */ }
    await new Promise((r) => setTimeout(r, 2000))
  }

  // ① 围栏被用上
  const fence = content.match(/```svg\s*\n([\s\S]*?)```/i)
  check("模型用了 ```svg 围栏（协议被理解）", !!fence, fence ? `围栏 ${fence[1].length} 字符` : "回复里没有 svg 围栏——协议没被用上")
  const svgSrc = fence?.[1] ?? ""

  // ② 净化通过（不剥空）
  const cleaned = svgSrc ? sanitize(svgSrc) : null
  check("SVG 过 sanitizeSvg（没被剥空）", !!cleaned, cleaned ? `净化后 ${cleaned.length} 字符` : "净化返回 null——会降级成代码块")

  // ③ 纪律：viewBox 在、无 script 与 on 事件属性、外链（指模型原文）
  check("带 viewBox（协议纪律）", /viewBox\s*=/.test(svgSrc))
  const dirty = /<script|\son[a-z]+\s*=|href\s*=\s*"https?:/i.test(svgSrc)
  check("无 script/事件属性/外链（硬约束遵守）", !dirty, dirty ? "模型原文里就有违禁内容——提示词硬约束没吃住" : "干净")

  // ④ 渲染产物非 null（整条链路）
  const html = cleaned ? `<div class="svgbox">${cleaned}</div>` : null
  check("renderSvgBlock 产物非 null（净化→渲染通）", !!html)

  // ⑦ 主题适配：真模型首秀暴露的短板——写死浅色填充在深色模式下亮成一团。
  //    提示词已教「颜色用页面 CSS 变量」，这里验证模型真的学了。
  const varCount = (svgSrc.match(/var\(--/g) ?? []).length
  check("主题适配：用了页面 CSS 变量（不写死色值）", varCount >= 3, `${varCount} 处 var(--…)`)

  // 诊断信息：不管过没过，把图的形状量出来
  if (cleaned) {
    const nodes = (cleaned.match(/<rect\b/gi) ?? []).length
    const texts = (cleaned.match(/<text\b/gi) ?? []).length
    note(`图规模：${nodes} 个 rect / ${texts} 个 text`)
    note(`围栏首 120 字符：${svgSrc.slice(0, 120).replace(/\s+/g, " ")}`)
    // 样本落盘：模型画的图留一份，肉眼检查布局质量（探针删 HOME，但图本身值得看）
    try { writeFileSync(join(tmpdir(), "yy-svg-fence-sample.svg"), svgSrc); note(`样本已存：${join(tmpdir(), "yy-svg-fence-sample.svg")}`) } catch { /* 存不下不影响结论 */ }
  } else {
    note(`围栏首 200 字符：${svgSrc.slice(0, 200).replace(/\s+/g, " ")}`)
  }
} catch (e) {
  fail++
  console.log(`FAIL 运行出错 — ${(e as Error).message}`)
} finally {
  try { gw?.kill() } catch { /* 已杀 */ }
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
