/**
 * T93 L2：TypeSafe key 连通性预检。
 *
 *   npx tsx scripts/check-typesafe-key.ts                # 用 config.typesafe.apiKey
 *   TYPESAFE_API_KEY=ts-xxx npx tsx scripts/check-typesafe-key.ts
 *   npx tsx scripts/check-typesafe-key.ts --local       # 打本地假服务端（自检用）
 *
 * 为什么单独一个脚本：`ab-hook-judge.ts` 要跑 31 条样本，而「我的 key 到底通不通」
 * 只需要**一次最小请求**。分开放的好处是——拿 key 的人第一次跑就能得到明确答案，
 * 不用先读懂标注集和门槛。
 *
 * 它回答四个问题：连得上吗、key 对吗、限额多少、一次调用花多少 token。
 */
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pickFreePort } from "./pick-port.js"

// 先设 HOME 再动态 import（活体探针的教训）
const HOME = mkdtempSync(join(tmpdir(), "yy-tsk-"))
process.env.HOME = HOME
process.env.USERPROFILE = HOME

const { writeFileSync } = await import("node:fs")
const { loadConfig, resetConfigCache } = await import("../src/agent/config.js")

const local = process.argv.includes("--local")
const PORT = await pickFreePort()
const BASE = local ? `http://127.0.0.1:${PORT}/v1` : undefined

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

let server: Server | undefined
try {
  if (local) {
    server = createServer((req, res) => {
      let raw = ""
      req.on("data", (c) => { raw += String(c) })
      req.on("end", () => {
        let body: Record<string, unknown> = {}
        try { body = JSON.parse(raw) as Record<string, unknown> } catch { /* 保持空 */ }
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: { ping: { type: "noul", noul: 0.02 } },
            usage: { input_tokens: 128, output_tokens: 8 },
          }),
        )
        console.log(`  [假服务端] 收到 ${req.method} ${req.url}，auth=${req.headers.authorization}`)
      })
    })
    await new Promise<void>((r) => server!.listen(PORT, "127.0.0.1", r))
    mkdirSync(join(HOME, ".yyagent"), { recursive: true })
    writeFileSync(
      join(HOME, ".yyagent", "config.json"),
      JSON.stringify({ providers: {}, model: "x/y", typesafe: { apiKey: "local-test-key", baseUrl: BASE } }, null, 2),
    )
    resetConfigCache()
  }

  const t = loadConfig().typesafe ?? {}
  const apiKey = process.env.TYPESAFE_API_KEY || t.apiKey
  const baseUrl = (BASE ?? t.baseUrl ?? "https://api.typesafe.ai/v1").replace(/\/+$/, "")
  const model = t.model ?? "jev-latest"

  console.log(`端点：${baseUrl}/systemone`)
  console.log(`模型：${model}`)
  console.log(`key ：${apiKey ? apiKey.slice(0, 6) + "…" + apiKey.slice(-4) : "（未配置）"}`)
  console.log("")

  if (!apiKey) {
    check("配了 apiKey", false, "config.typesafe.apiKey 或环境变量 TYPESAFE_API_KEY 至少配一个")
    console.log("\n拿 key：https://console.typesafe.ai/keys")
    process.exit(1)
  }

  const t0 = Date.now()
  let res: Response
  try {
    res = await fetch(`${baseUrl}/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        state: "connectivity check",
        model,
        questions: { ping: { type: "noul", instructions: "Is this a connectivity check?" } },
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    check("连得上端点", false, `${(e as Error).message}（本机网络/代理问题；官方端点在国内可能需要代理）`)
    process.exit(1)
  }
  const ms = Date.now() - t0
  check("连得上端点", true, `${ms}ms`)

  if (res.status === 401) {
    check("key 有效", false, "401 —— key 错或已失效，去 https://console.typesafe.ai/keys 重新生成")
    process.exit(1)
  }
  if (res.status === 429) {
    check("未被限流", false, `429 限流，retry-after=${res.headers.get("retry-after") ?? "?"}；限额 250k tok/s · 1200 req/min`)
    process.exit(1)
  }
  if (res.status === 529) {
    check("服务端未过载", false, "529 官方过载，稍后重试")
    process.exit(1)
  }
  if (!res.ok) {
    check("请求被接受", false, `HTTP ${res.status}：${(await res.text()).slice(0, 200)}`)
    process.exit(1)
  }

  const body = (await res.json()) as { model?: string; answers?: Record<string, { noul?: number }>; usage?: { input_tokens?: number; output_tokens?: number } }
  check("key 有效", true)
  check("返回了结构化答案", typeof body.answers?.ping?.noul === "number", `noul=${body.answers?.ping?.noul}`)
  const inTok = body.usage?.input_tokens ?? 0
  const outTok = body.usage?.output_tokens ?? 0
  check("拿到了用量", inTok > 0, `输入 ${inTok} tok · 输出 ${outTok} tok（输出免费）`)
  console.log(`\n按 $0.042/Mtok 算，这一次请求约花 $${((inTok * 0.042) / 1e6).toFixed(6)}`)
  console.log(`本机延迟 ${ms}ms（官方口径 70–500ms${ms > 800 ? "，明显偏高说明链路绕远" : ""}）`)
  console.log("\n✅ 预检通过。下一步：")
  console.log("  npx tsx scripts/ab-hook-judge.ts --candidate typesafe   # 31 条中文样本的真实一致率")
} catch (e) {
  fail++
  console.log(`FAIL 运行出错 — ${(e as Error).message}`)
} finally {
  try { server?.close() } catch { /* 已关 */ }
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

process.exit(fail ? 1 : 0)
