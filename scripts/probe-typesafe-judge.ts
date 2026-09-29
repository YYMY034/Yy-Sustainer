/**
 * T93 L2 活体探针（不随 run-all-checks 跑）：
 *
 *   npx tsx scripts/probe-typesafe-judge.ts
 *
 * **用一个本地假 TypeSafe 服务端把整条契约验完**——不需要真 key、不需要出网。
 * 这正是这个项目一贯的手法：真的起一个 HTTP 服务端，真的发请求，真的看响应。
 *
 * 验七件事：
 *   ① 请求形状：POST {baseUrl}/systemone，body 含 state/model/questions
 *   ② 鉴权头：Authorization: Bearer <key>
 *   ③ questions 每个钩子一条 noul，问句英文 + rule 字段带中文判据原文
 *   ④ noul → verdict 映射：≥阈值判 FAIL，<阈值判 PASS
 *   ⑤ 阈值可配（threshold=0.9 时 0.85 不再算风险）
 *   ⑥ 429 退避一次后成功（官方文档要求的行为）
 *   ⑦ **fail-open 全路径**：没 key / 401 / 422 / 5xx / 529 两次 / 非 JSON / 缺答案 / 类型不对 / 连不上
 *      —— 全部返回空数组（= 判不出），一个都不抛
 *
 * ⑦是反向断言：只测「能判出」的话，一个把异常吞掉静静返回空的后端也能全绿。
 */
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// type-only import 编译期擦除，不影响「先设 HOME 再加载模块」的顺序
import type { HookConfig } from "../src/agent/config.js"
import type { JudgeInput } from "../src/agent/hookJudge.js"
import { pickFreePort } from "./pick-port.js"

// 先设 HOME 再动态 import（活体探针的教训：被测模块加载时就用 homedir() 定路径）
const HOME = mkdtempSync(join(tmpdir(), "yy-tsj-"))
process.env.HOME = HOME
process.env.USERPROFILE = HOME

const { writeFileSync } = await import("node:fs")
const { loadConfig, resetConfigCache } = await import("../src/agent/config.js")
const { TypesafeHookJudge } = await import("../src/agent/hookJudge.js")

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

const PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}/v1`

const HOOKS: HookConfig[] = [
  {
    id: "builtin-safety",
    name: "安全钩子",
    enabled: true,
    strict: true,
    prompt: "检查本次工具执行/输出是否存在安全风险：删除或覆盖重要文件、泄露密钥或隐私。存在风险回复 FAIL；否则 PASS。",
  },
  { id: "builtin-format", name: "输出格式钩子", enabled: true, prompt: "检查输出是否中文、结构清晰。不符合回复 FAIL；否则 PASS。" },
]

const INPUT: JudgeInput = {
  tool: "bash",
  sample: "> cat .env\nAPI_KEY=sk-ant-api03-REALKEY",
  hooks: HOOKS,
}

/** 假服务端的行为模式 */
let mode: "ok" | "401" | "422" | "500" | "529-always" | "529-once" | "not-json" | "no-answers" | "bad-type" = "ok"
/** 收到的最后一个请求，供断言形状 */
let lastReq: { url?: string; method?: string; auth?: string; body?: Record<string, unknown> } = {}
let hits = 0

function fakeTypesafe(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
  let raw = ""
  req.on("data", (c) => { raw += String(c) })
  req.on("end", () => {
    hits++
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(raw) as Record<string, unknown> } catch { /* 保持空 */ }
    lastReq = { url: req.url, method: req.method, auth: req.headers.authorization, body }
    const json = (code: number, payload: unknown): void => {
      res.writeHead(code, { "Content-Type": "application/json" })
      res.end(JSON.stringify(payload))
    }
    switch (mode) {
      case "401":
        return json(401, { error: "invalid api key" })
      case "422":
        return json(422, { error: "missing required field: questions" })
      case "500":
        return json(500, { error: "internal" })
      case "529-always":
        return json(529, { error: "overloaded" })
      case "529-once":
        return hits === 1 ? json(529, { error: "overloaded" }) : json(200, okPayload())
      case "not-json":
        res.writeHead(200, { "Content-Type": "text/html" })
        return res.end("<html>not json</html>")
      case "no-answers":
        return json(200, { model: "jev-1.13.0" })
      case "bad-type":
        return json(200, { answers: { "builtin-safety": { type: "choice", choice: "x" } } })
      default:
        return json(200, okPayload())
    }
  })
}

/** 正常响应：安全钩子判有风险（0.95），格式钩子判无风险（0.10） */
function okPayload(): unknown {
  return {
    model: "jev-1.13.0",
    answers: {
      "builtin-safety": { type: "noul", noul: 0.95 },
      "builtin-format": { type: "noul", noul: 0.1 },
    },
    usage: { input_tokens: 392, output_tokens: 20 },
  }
}

function writeCfg(typesafe: Record<string, unknown> | undefined): void {
  mkdirSync(join(HOME, ".yyagent"), { recursive: true })
  writeFileSync(
    join(HOME, ".yyagent", "config.json"),
    JSON.stringify({ providers: {}, model: "x/y", ...(typesafe ? { typesafe } : {}) }, null, 2),
  )
  // loadConfig 有进程内缓存——换配置前先把缓存清了，否则读到的还是上一份
  resetConfigCache()
}

let server: Server | undefined
try {
  server = createServer(fakeTypesafe)
  await new Promise<void>((r) => server!.listen(PORT, "127.0.0.1", r))
  const judge = new TypesafeHookJudge()

  // ============ ①②③ 请求形状 / 鉴权头 / questions ============
  writeCfg({ apiKey: "test-key-123", baseUrl: BASE })
  mode = "ok"
  hits = 0
  const verdicts = await judge.judge(INPUT)
  check("请求打到 {baseUrl}/systemone", lastReq.url === "/v1/systemone", String(lastReq.url))
  check("方法是 POST", lastReq.method === "POST")
  check("鉴权头是 Bearer <key>", lastReq.auth === "Bearer test-key-123", String(lastReq.auth))
  const q = lastReq.body?.questions as Record<string, { type?: string; instructions?: { question?: string; rule?: string } }>
  check("每个钩子一条 noul 问题", !!q && Object.keys(q).length === 2 && q["builtin-safety"]?.type === "noul", JSON.stringify(Object.keys(q ?? {})))
  check("问句是英文（Jev 主语言）", q?.["builtin-safety"]?.instructions?.question?.startsWith("Does the tool") === true, String(q?.["builtin-safety"]?.instructions?.question))
  check("规则原文走 rule 字段、保持中文", (q?.["builtin-safety"]?.instructions?.rule ?? "").includes("安全风险"), String(q?.["builtin-safety"]?.instructions?.rule).slice(0, 60))
  const state = lastReq.body?.state as { tool?: string; output?: string }
  check("state 带工具名与输出采样", state?.tool === "bash" && (state?.output ?? "").includes("API_KEY"), JSON.stringify(state).slice(0, 80))
  check("model 默认 jev-latest", lastReq.body?.model === "jev-latest", String(lastReq.body?.model))

  // ============ ④ noul → verdict 映射 ============
  check("noul 0.95 ≥ 0.5 → 判 FAIL 且带原因", verdicts.length === 2 && verdicts[0].hookId === "builtin-safety" && verdicts[0].pass === false && !!verdicts[0].reason, JSON.stringify(verdicts))
  check("noul 0.10 < 0.5 → 判 PASS", verdicts[1].hookId === "builtin-format" && verdicts[1].pass === true, JSON.stringify(verdicts[1]))

  // ============ ⑤ 阈值可配 ============
  writeCfg({ apiKey: "k", baseUrl: BASE, threshold: 0.9 })
  const strict = await judge.judge(INPUT)
  check("threshold=0.9 时 0.95 仍判 FAIL", strict[0].pass === false)
  writeCfg({ apiKey: "k", baseUrl: BASE, threshold: 0.99 })
  const loose = await judge.judge(INPUT)
  check("threshold=0.99 时 0.95 判 PASS（阈值真的生效）", loose[0].pass === true, JSON.stringify(loose[0]))

  // ============ ⑥ 429 退避一次 ============
  writeCfg({ apiKey: "k", baseUrl: BASE })
  mode = "529-once"
  hits = 0
  const t0 = Date.now()
  const afterBackoff = await judge.judge(INPUT)
  check("529 后退避一次再试就成功", afterBackoff.length === 2 && hits === 2, `hits=${hits}`)
  check("退避真的等了（不是立刻重试）", Date.now() - t0 >= 900, `${Date.now() - t0}ms`)

  // ============ ⑦ fail-open 全路径 ============
  mode = "401"
  check("401 → 空判定（不抛）", (await judge.judge(INPUT)).length === 0)
  mode = "422"
  check("422 → 空判定", (await judge.judge(INPUT)).length === 0)
  mode = "500"
  check("5xx → 空判定", (await judge.judge(INPUT)).length === 0)
  mode = "529-always"
  hits = 0
  const t1 = Date.now()
  check("529 两次都失败 → 空判定", (await judge.judge(INPUT)).length === 0)
  check("且只重试一次（不无限重试）", hits === 2, `hits=${hits}`)
  check("两次之间等了退避", Date.now() - t1 >= 900, `${Date.now() - t1}ms`)
  mode = "not-json"
  check("非 JSON 响应 → 空判定", (await judge.judge(INPUT)).length === 0)
  mode = "no-answers"
  check("缺 answers 字段 → 空判定", (await judge.judge(INPUT)).length === 0)
  mode = "bad-type"
  check("答案类型不是 noul → 该钩子判不出（不进结果）", (await judge.judge(INPUT)).length === 0)
  mode = "ok"
  writeCfg(undefined)
  check("没配 typesafe → 空判定", (await judge.judge(INPUT)).length === 0)
  writeCfg({ apiKey: "k", baseUrl: "http://127.0.0.1:1/v1", timeoutMs: 1500 })
  check("连不上 → 空判定（不抛）", (await judge.judge(INPUT)).length === 0)

  // ============ 只判部分钩子：缺答案的那个不进结果 ============
  writeCfg({ apiKey: "k", baseUrl: BASE })
  mode = "ok"
  const partial = await judge.judge({ ...INPUT, hooks: [HOOKS[0]] })
  check("只问一条钩子 → 只回一条", partial.length === 1 && partial[0].hookId === "builtin-safety", JSON.stringify(partial))
} catch (e) {
  fail++
  console.log(`FAIL 运行出错 — ${(e as Error).message}`)
} finally {
  try { server?.close() } catch { /* 已关 */ }
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
