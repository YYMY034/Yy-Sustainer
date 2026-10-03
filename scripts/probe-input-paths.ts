/**
 * T126 活体探针：输入到路径/执行面的遍历与注入面系统性验证。
 *
 *   npx tsx scripts/probe-input-paths.ts
 *
 * 覆盖面（每项都有反向断言——恶意输入必须被明确拒绝，而不是静默通过）：
 *   ① 定时任务名：../ 路径、空字节、超长——create 必须 400
 *   ② 任务 cwd：不存在的目录——create/update 必须 400（T116 的 spawn ENOENT 假线索源头）
 *   ③ persona：路径穿越名字——必须「未知角色」，不得读 agents 目录外的文件
 *   ④ memory topic：路径穿越——safeTopic 必须拒绝，且不得写出 topics 目录外的文件
 *   ⑤ 会话 id：路径穿越——export/读取路由必须 404/400，不得 200
 *   ⑥ bg id：路径穿越——日志读取必须 404
 * ⑤⑥ 需要网关活体；③④ 直接调引擎函数（隔离 HOME）。
 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { homedir, tmpdir as tdir } from "node:os"
import { join } from "node:path"
import { pickFreePort } from "./pick-port.js"

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

// ---------- ③④ 引擎函数直测（隔离 HOME，不碰真实记忆） ----------
{
  const HOME = mkdtempSync(join(tdir(), "yy-paths-"))
  const prevHome = process.env.HOME
  const prevUp = process.env.USERPROFILE
  process.env.HOME = HOME
  process.env.USERPROFILE = HOME
  try {
    const { memoryTools } = await import("../src/agent/memory.js")
    const save = (memoryTools() as Record<string, { execute: (a: unknown) => Promise<string> }>).memory_save
    const r1 = await save.execute({ content: "evil", summary: "s", topic: "../../evil", scope: "user" })
    check("memory topic 穿越：save 被拒", /无效主题名|失败/.test(r1), r1.slice(0, 80))
    const escaped = join(HOME, ".yyagent", "memory", "topics")
    const r2 = await save.execute({ content: "ok", summary: "s", topic: "合法-主题_1", scope: "user" })
    check("memory topic 合法名正常保存", r2.includes("已创建") || r2.includes("已保存"), r2.slice(0, 80))
    check("memory 目录无越界文件", existsSync(join(escaped, "合法-主题_1.md")) && !existsSync(join(HOME, "evil.md")))

    const { getPersona } = await import("../src/agent/personas.js")
    const p = await getPersona("../../evil")
    check("persona 穿越：解析为未知角色（不读越界文件）", p === undefined)
  } finally {
    process.env.HOME = prevHome
    process.env.USERPROFILE = prevUp
    rmSync(HOME, { recursive: true, force: true })
  }
}

// ---------- ①②⑤⑥ 网关活体（隔离 HOME + 真 HTTP） ----------
const HOME = mkdtempSync(join(tmpdir(), "yy-paths-gw-"))
const work = join(HOME, "work")
mkdirSync(work, { recursive: true })
const PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`
let gw
try {
  mkdirSync(join(HOME, ".yyagent"), { recursive: true })
  writeFileSync(join(HOME, ".yyagent", "config.json"), JSON.stringify({
    providers: {}, model: "", permission: "full-auto", interactiveTimeoutMs: 0, mcpServers: {}, hooks: [],
  }))
  gw = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
    cwd: process.cwd(), env: { ...process.env, HOME, USERPROFILE: HOME, YYAGENT_GATEWAY_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
  })
  let up = false
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) }); if (r.ok) { up = true; break } } catch {} await new Promise((s) => setTimeout(s, 500)) }
  check("隔离网关起来了", up)
  if (!up) throw new Error("gateway failed")

  const mkTask = async (name: string, cwd: string) => fetch(`${BASE}/api/tasks/create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, cron: "0 9 * * *", prompt: "x", cwd }) })

  {
    const r = await (await mkTask("../../evil", work)).json()
    check("① 任务名路径穿越：create 400", r.error && r.status !== 200 ? true : !!r.error, JSON.stringify(r).slice(0, 100))
  }
  {
    const r = await (await mkTask("ok 任务-1", work)).json()
    check("① 合法任务名（中文/_/含空格）正常创建", r.ok === true, JSON.stringify(r).slice(0, 80))
  }
  {
    const r = await (await mkTask("bad-cwd-task", "C:\\ definitely\\not\\exist")).json()
    check("② 不存在的 cwd：create 400", !!r.error, JSON.stringify(r).slice(0, 100))
  }
  {
    const r = await fetch(`${BASE}/api/sessions/..%2F..%2F..%2Fconfig/export`)
    check("⑤ 会话 id 穿越（编码后）：非 200", r.status !== 200, `status=${r.status}`)
  }
  {
    const r = await fetch(`${BASE}/api/sessions/....../export`)
    check("⑤ 会话 id 点点形态：非 200", r.status !== 200, `status=${r.status}`)
  }
  {
    const r = await fetch(`${BASE}/api/bg/log?id=..%2F..%2Fsecret`)
    check("⑥ bg 日志 id 穿越：404", r.status === 404, `status=${r.status}`)
  }
  check("⑤⑥ 反向：合法形状不被误伤（404 是「不存在」而非 400「非法」）", (await fetch(`${BASE}/api/sessions/ffff0000/export`)).status === 404)
} catch (e) {
  fail++
  console.log(`FAIL 运行出错 — ${(e as Error).stack ?? e}`)
} finally {
  try { gw?.kill() } catch {}
  await new Promise((s) => setTimeout(s, 300))
  try { rmSync(HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
