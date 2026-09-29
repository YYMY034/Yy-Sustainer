/**
 * T93 P1 断点恢复的**活体**探针（需要自己起网关，不随 run-all-checks 跑，改到相关区域时手动跑）：
 *
 *   npx tsx scripts/probe-checkpoint-resume.ts
 *
 * 它做的是「真的把进程中断掉会怎样」：在隔离 HOME 里起一个真网关，把会话改写成
 * 「只剩一条用户消息」的中断态，再手工造一个 checkpoint，然后逐个验证恢复动作的**真实行为**
 * ——不是看代码写没写，而是看接口返回什么、会话文件变成什么。
 *
 * 六个场景：
 *   ① 刚发起就被杀（无产出）  → adopt 落一条说人话的消息
 *   ② 跑到一半被杀（有产出）  → adopt 保住正文 + 工具步骤 + 模型 spec
 *   ③ 双完成护栏             → 已有助手回复时不再追加重复回复
 *   ④ discard 的真路径        → 截回这一轮之前
 *   ⑤ 已完成轮次上的 discard  → 被护栏拦住（否则删掉真实历史）
 *   ⑥ 带图 retry / 未知 action / 路径穿越
 *
 * ③⑤⑥ 是**反向断言**：它们验的是「该拒绝的时候真的拒绝」。只测 happy path 的探针
 * 不知道自己的护栏是坏了还是压根没接。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-cp-"))
const PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) {
    pass++
    console.log(`ok   ${label}${extra ? " — " + extra : ""}`)
  } else {
    fail++
    console.log(`FAIL ${label}${extra ? " — " + extra : ""}`)
  }
}

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  })
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> }
}
const sessionFile = (id: string): string => join(HOME, ".yyagent", "sessions", `${id}.json`)
type SessionShape = { meta: Record<string, unknown>; messages: Array<{ role: string; content: string; ts: number; steps?: unknown[]; model?: string }> }
const readSession = (id: string): SessionShape => JSON.parse(readFileSync(sessionFile(id), "utf8")) as SessionShape

/** 把会话改写成「只剩一条用户消息」——就是进程刚发起那一轮就被杀掉的样子 */
function forceInterruptedState(id: string): number {
  const parsed = JSON.parse(readFileSync(sessionFile(id), "utf8")) as { meta: Record<string, unknown> }
  const userTs = Date.now()
  writeFileSync(
    sessionFile(id),
    JSON.stringify({ meta: { ...parsed.meta, updatedAt: Date.now() }, messages: [{ role: "user", content: "帮我跑一遍测试", ts: userTs }] }, null, 2),
  )
  return userTs
}
function writeCp(sid: string, cp: Record<string, unknown>): void {
  const dir = join(HOME, ".yyagent", "checkpoints")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sid}.json`), JSON.stringify(cp, null, 2))
}
const cpBase = (sid: string, userTs: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  sessionId: sid,
  title: "测试会话",
  cwd: process.cwd(),
  userTs,
  userText: "帮我跑一遍测试",
  images: 0,
  startedAt: Date.now() - 60_000,
  updatedAt: Date.now() - 10_000,
  streamedText: "已经跑完了 7 个测试，正在收尾",
  steps: [{ name: "bash", argsSummary: "npm test", output: "7 passed" }],
  model: "test/model",
  ...over,
})

const child = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
  env: { ...process.env, HOME, USERPROFILE: HOME, YYAGENT_GATEWAY_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
})
let log = ""
child.stdout.on("data", (d) => { log += String(d) })
child.stderr.on("data", (d) => { log += String(d) })

try {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) break
    } catch { /* 还没起 */ }
    if (i === 59) throw new Error("网关没起来：\n" + log.slice(-2000))
    await new Promise((s) => setTimeout(s, 500))
  }
  check("隔离 HOME 下网关启动", true)

  const sid = (await api("POST", "/api/sessions", { cwd: process.cwd() })).body as unknown as { id: string }
  check("建会话", !!sid.id)

  // ① 刚发起就被杀：没有正文也没有步骤
  const ts1 = forceInterruptedState(sid.id)
  writeCp(sid.id, cpBase(sid.id, ts1, { streamedText: "", steps: [] }))
  const list = await api("GET", "/api/sessions/checkpoints")
  const listed = (list.body?.checkpoints ?? []) as Array<{ summary: string }>
  check("GET 列出 checkpoint（未被 /api/sessions/{id} 遮蔽）", list.status === 200 && listed.length === 1,
    JSON.stringify(listed[0]?.summary))

  const a1 = await api("POST", "/api/sessions/checkpoints/resume", { sessionId: sid.id, action: "adopt" })
  const s1 = readSession(sid.id)
  const am1 = s1.messages.filter((m) => m.role === "assistant").pop()
  check("adopt（无产出）落一条非空助手消息", a1.status === 200 && !!am1 && am1.content.trim().length > 0)
  check("无产出时把原因说清", !!am1 && am1.content.includes("进程被中断"), JSON.stringify(am1?.content))
  check("用户消息仍在（历史没被冲掉）", s1.messages.filter((m) => m.role === "user").length === 1)

  // ② 跑到一半被杀：有正文 + 有工具步骤
  const ts2 = forceInterruptedState(sid.id)
  writeCp(sid.id, cpBase(sid.id, ts2))
  const a2 = await api("POST", "/api/sessions/checkpoints/resume", { sessionId: sid.id, action: "adopt" })
  const s2 = readSession(sid.id)
  const am2 = s2.messages.filter((m) => m.role === "assistant").pop()
  check("adopt（有产出）落库", a2.status === 200 && !!am2)
  check("已流出的正文没丢", !!am2 && am2.content.includes("已经跑完了 7 个测试"), JSON.stringify(am2?.content.slice(0, 60)))
  check("工具步骤一起带过来", !!am2 && Array.isArray(am2.steps) && am2.steps.length === 1)
  check("标注了「进程被中断」", !!am2 && am2.content.includes("进程被中断"))
  check("模型 spec 也带过来", !!am2 && am2.model === "test/model")

  // ③ 双完成护栏
  writeCp(sid.id, cpBase(sid.id, ts2))
  const a3 = await api("POST", "/api/sessions/checkpoints/resume", { sessionId: sid.id, action: "adopt" })
  const s3 = readSession(sid.id)
  check("已有更新的助手回复 → 判为 already-done", a3.body?.action === "already-done", JSON.stringify(a3.body))
  check("没有追加重复回复", s3.messages.length === s2.messages.length, `${s2.messages.length} → ${s3.messages.length}`)

  // ④ discard 的真路径（换新会话：③之后这个会话上已经有助手回复，护栏会正确拦住）
  const sid2 = (await api("POST", "/api/sessions", { cwd: process.cwd() })).body as unknown as { id: string }
  const ts4 = forceInterruptedState(sid2.id)
  writeCp(sid2.id, cpBase(sid2.id, ts4))
  const before = readSession(sid2.id)
  check("场景④前置：会话只有一条用户消息", before.messages.length === 1 && before.messages[0].role === "user")
  const a4 = await api("POST", "/api/sessions/checkpoints/resume", { sessionId: sid2.id, action: "discard" })
  const s4 = readSession(sid2.id)
  check("discard 截掉那一轮", a4.body?.removed === 1, JSON.stringify(a4.body))
  check("会话消息数减少", s4.messages.length === before.messages.length - 1, `${before.messages.length} → ${s4.messages.length}`)
  check("checkpoint 也清掉", !existsSync(join(HOME, ".yyagent", "checkpoints", `${sid2.id}.json`)))

  // ⑤ 已完成轮次上的 discard 必须被拦住（否则会连带删掉真实完成的历史）
  const doneTs = readSession(sid.id).messages.filter((m) => m.role === "user").pop()?.ts ?? ts2
  writeCp(sid.id, cpBase(sid.id, doneTs))
  const a5 = await api("POST", "/api/sessions/checkpoints/resume", { sessionId: sid.id, action: "discard" })
  const s5 = readSession(sid.id)
  check("已完成轮次上的 discard 被护栏拦住", a5.body?.action === "already-done", JSON.stringify(a5.body))
  check("且历史一条都没少", s5.messages.length === s3.messages.length, `${s3.messages.length} → ${s5.messages.length}`)
  check("护栏文案指向撤回功能", String(a5.body?.text).includes("撤回"))

  // ⑥ 反向断言（先把会话重置成「中断态」——上面⑤之后它已经有完成的助手回复，
  //    不重置的话双完成护栏会先一步把 checkpoint 清掉，测到的就不是本场景了）
  const ts6 = forceInterruptedState(sid.id)
  writeCp(sid.id, cpBase(sid.id, ts6, { images: 2 }))
  const a6 = await api("POST", "/api/sessions/checkpoints/resume", { sessionId: sid.id, action: "retry" })
  check("带图的轮次 retry 被拒绝且原因说清", a6.status === 409 && String(a6.body?.error).includes("图片"), JSON.stringify(a6.body))
  writeCp(sid.id, cpBase(sid.id, ts6))
  const a7 = await api("POST", "/api/sessions/checkpoints/resume", { sessionId: sid.id, action: "bogus" })
  check("未知 action 报 400", a7.status === 400, JSON.stringify(a7.body))
  const a8 = await api("POST", "/api/sessions/checkpoints/resume", { sessionId: "../../evil", action: "adopt" })
  check("路径穿越 sessionId 不炸也不写盘", (a8.status === 404 || a8.status === 400) && !existsSync(join(HOME, ".yyagent", "sessions", "evil.json")), `status=${a8.status}`)
} catch (e) {
  fail++
  console.log(`FAIL 运行出错 — ${(e as Error).message}\n${log.slice(-1500)}`)
} finally {
  child.kill()
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录删不掉就算了 */ }
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
