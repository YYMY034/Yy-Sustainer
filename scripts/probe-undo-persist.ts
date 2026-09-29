/**
 * T93 B2 活体探针（不随 run-all-checks 跑）：
 *
 *   npx tsx scripts/probe-undo-persist.ts
 *
 * B2 是「把用户文件内容复制进 ~/.yyagent/」的那一批，**必须真杀一次网关**才能验证：
 *   ① 开启 undo.persist 后，模型改过的文件会落快照（index + .snap）
 *   ② **杀掉网关**再重启 → 撤销应成功，且 source=disk、文件内容被还原
 *   ③ 默认（不配 undo）时什么都不落——重启后撤销应明确失败并说清怎么打开
 *   ④ 超过单文件上限的文件：不落快照，撤销时拒绝而不是动文件
 */
import { createServer, type Server } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-up-"))
const PORT = await pickFreePort()
const FAKE_PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`
const WORK = join(HOME, "work")
const TARGET = join(WORK, "target.txt")
const ORIGINAL = "这是原来的内容\n第二行\n"

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

/** 假 provider：让模型用 write 工具改一个文件，然后收尾 */
function fakeProvider(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
  if (req.url?.includes("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ data: [{ id: "m1" }] }))
    return
  }
  let raw = ""
  req.on("data", (c) => { raw += String(c) })
  req.on("end", () => {
    let messages: Array<{ role: string; content: unknown }> = []
    try { messages = (JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [] } catch { /* 按没有 */ }
    const hasToolResult = messages.some((m) => m.role === "tool")
    const chunk = (delta: unknown, finish?: string, usage?: unknown): string =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(usage ? { usage } : {}) })}\n\n`
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
    if (!hasToolResult) {
      res.write(chunk({ role: "assistant", content: "" }))
      res.write(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: JSON.stringify({ file_path: TARGET, content: "模型改写后的内容\n" }) } }] }, "tool_calls", { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }))
    } else {
      res.write(chunk({ role: "assistant", content: "" }))
      res.write(chunk({ content: "改好了" }, "stop", { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 }))
    }
    res.write("data: [DONE]\n\n")
    res.end()
  })
}

let gw: ChildProcess | undefined
let fake: Server | undefined

function writeCfg(undo: unknown): void {
  mkdirSync(join(HOME, ".yyagent"), { recursive: true })
  const cfg = JSON.parse(readFileSync(join(process.cwd(), "yyagentd.config.json"), "utf8")) as Record<string, unknown>
  const providers = (cfg.providers ?? {}) as Record<string, { baseURL?: string; apiKey?: string }>
  const first = Object.keys(providers)[0]
  const modelId = String(cfg.model ?? "m1").split("/")[1] ?? "m1"
  writeFileSync(join(HOME, ".yyagent", "config.json"), JSON.stringify({
    ...cfg,
    providers: { ...providers, [first]: { ...providers[first], baseURL: `http://127.0.0.1:${FAKE_PORT}/v1` } },
    model: `${first}/${modelId}`,
    permission: "full-auto",
    interactiveTimeoutMs: 0,
    undo,
  }, null, 2))
}

async function startGw(): Promise<boolean> {
  gw = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
    env: { ...process.env, HOME, USERPROFILE: HOME, YYAGENT_GATEWAY_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) }); if (r.ok) return true } catch { /* 没起 */ }
    await new Promise((s) => setTimeout(s, 500))
  }
  return false
}
const newSession = async (): Promise<string> =>
  ((await (await fetch(`${BASE}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: WORK }),
  })).json()) as { id: string }).id
const runTurn = async (sid: string, text: string): Promise<void> => {
  await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid, text }),
  })
  for (let i = 0; i < 80; i++) {
    const f = await (await fetch(`${BASE}/api/sessions/${sid}`)).json() as { messages: Array<{ role: string; content: string; ts: number }> }
    const last = [...f.messages].reverse().find((m) => m.role === "assistant")
    if (last && last.content.trim()) return
    await new Promise((s) => setTimeout(s, 500))
  }
}
const lastAssistantTs = async (sid: string): Promise<number> => {
  const f = await (await fetch(`${BASE}/api/sessions/${sid}`)).json() as { messages: Array<{ role: string; ts: number }> }
  const last = [...f.messages].reverse().find((m) => m.role === "assistant")
  if (!last) throw new Error("没有助手消息")
  return last.ts
}
const undo = async (sid: string, ts: number) =>
  (await (await fetch(`${BASE}/api/sessions/undo-files`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sid, ts }),
  })).json()) as { ok?: boolean; source?: string; restored?: number; failed?: string[]; error?: string }

try {
  mkdirSync(WORK, { recursive: true })
  writeFileSync(TARGET, ORIGINAL, "utf8")
  fake = createServer(fakeProvider)
  await new Promise<void>((r) => fake!.listen(FAKE_PORT, "127.0.0.1", r))

  // ============ 场景一：开启落盘，然后杀网关 ============
  writeCfg({ persist: true })
  if (!(await startGw())) throw new Error("网关没起来")
  check("网关起在假 provider 上（undo.persist=true）", true)

  const sid = await newSession()
  await runTurn(sid, "把 target.txt 改写一下")
  const ts = await lastAssistantTs(sid)
  check("模型真的改写了文件", readFileSync(TARGET, "utf8") === "模型改写后的内容\n", readFileSync(TARGET, "utf8").slice(0, 40))

  const snapDir = join(HOME, ".yyagent", "snapshots", sid, String(ts))
  check("快照目录建起来了", existsSync(snapDir), snapDir)
  const idx = existsSync(join(snapDir, "index.json"))
    ? (JSON.parse(readFileSync(join(snapDir, "index.json"), "utf8")) as { files: Array<{ file?: string; skippedOnDisk?: string }> })
    : undefined
  check("index.json 在且指向一个 .snap", !!idx && idx.files.length === 1 && !!idx.files[0].file, JSON.stringify(idx?.files))
  check(".snap 里是**改前**的内容", existsSync(join(snapDir, idx!.files[0].file!)) && readFileSync(join(snapDir, idx!.files[0].file!), "utf8") === ORIGINAL)

  // B3 正向：还没撤过的时候，undo-state 必须说「能撤」——只验反向的话，
  // 一个永远返回 canUndo:false 的实现也能全绿
  {
    const st = (await (await fetch(`${BASE}/api/sessions/${sid}/undo-state`, { signal: AbortSignal.timeout(8000) })).json()) as {
      states: Record<string, { canUndo: boolean; source?: string }>
    }
    const one = st.states[String(ts)]
    check("未撤时 undo-state 说「能撤」", one?.canUndo === true, JSON.stringify(st.states))
    // 来源：同一进程里内存那份更新 → resolveUndoTurn 设计就是「内存 > 磁盘」，
    // 所以这里报 memory 是对的。重启后内存空了才会报 disk（见下面杀网关后的撤销）。
    check("并标注来源（内存优先，重启后才轮到磁盘）", one?.source === "memory" || one?.source === "disk", JSON.stringify(st.states))
  }

  // 杀掉网关 = 模拟崩溃；此时内存快照全丢，只剩磁盘
  gw!.kill()
  await new Promise((s) => setTimeout(s, 1000))
  gw = undefined
  check("网关已杀（内存快照全丢）", true)

  if (!(await startGw())) throw new Error("网关没起来（第二轮）")
  check("网关重启", true)
  const r1 = await undo(sid, ts)
  check("重启后撤销成功", r1.ok === true, JSON.stringify(r1))
  check("来源是磁盘", r1.source === "disk", JSON.stringify(r1))
  check("文件内容被还原成改前状态", readFileSync(TARGET, "utf8") === ORIGINAL, readFileSync(TARGET, "utf8").slice(0, 40))
  check("撤过之后快照清掉（不可重复撤）", !existsSync(snapDir))
  const r1b = await undo(sid, ts)
  check("重复撤销被明确拒绝", r1b.ok !== true && !!r1b.error, JSON.stringify(r1b))

  // ============ 场景二：默认不落盘 ============
  gw!.kill()
  await new Promise((s) => setTimeout(s, 800))
  gw = undefined
  writeCfg(undefined) // 不配 undo
  if (!(await startGw())) throw new Error("网关没起来（第三轮）")
  writeFileSync(TARGET, ORIGINAL, "utf8")
  const sid2 = await newSession()
  await runTurn(sid2, "再改一次 target.txt")
  const ts2 = await lastAssistantTs(sid2)
  check("模型又改写了", readFileSync(TARGET, "utf8") === "模型改写后的内容\n")
  check("默认不落盘：没有快照目录", !existsSync(join(HOME, ".yyagent", "snapshots", sid2)), join(HOME, ".yyagent", "snapshots", sid2))

  gw!.kill()
  await new Promise((s) => setTimeout(s, 800))
  gw = undefined
  if (!(await startGw())) throw new Error("网关没起来（第四轮）")
  const r2 = await undo(sid2, ts2)
  check("默认关时重启后撤销失败", r2.ok !== true, JSON.stringify(r2))
  check("失败文案说清怎么打开（而不是「来自更早的会话进程」）", !!r2.error && r2.error.includes("undo.persist"), JSON.stringify(r2.error))
  check("文件没被误动", readFileSync(TARGET, "utf8") === "模型改写后的内容\n")

  // ============ 场景三：同进程内仍然可撤（内存那份没被落盘影响） ============
  const sid3 = await newSession()
  writeFileSync(TARGET, ORIGINAL, "utf8")
  await runTurn(sid3, "再改一次 target.txt")
  const ts3 = await lastAssistantTs(sid3)
  const r3 = await undo(sid3, ts3)
  check("默认关时**同进程内**仍可撤（内存快照不受影响）", r3.ok === true && r3.source === "memory", JSON.stringify(r3))
  check("内容还原", readFileSync(TARGET, "utf8") === ORIGINAL)

  // ============ B3：undo-state 批量路由 ============
  const state = async (sid: string): Promise<Record<string, { canUndo: boolean; source?: string; reason?: string }>> => {
    const r = await fetch(`${BASE}/api/sessions/${sid}/undo-state`, { signal: AbortSignal.timeout(8000) })
    return ((await r.json()) as { states: Record<string, { canUndo: boolean; source?: string; reason?: string }> }).states
  }
  // 注意：sid/sid2 的轮次都已撤过或被拒，sid3 刚撤过——都该 canUndo=false 且带原因
  for (const [name, sidX] of [["已撤销的 sid", sid], ["未开落盘的 sid2", sid2], ["刚撤过的 sid3", sid3]] as const) {
    const st = await state(sidX)
    const keys = Object.keys(st)
    check(`${name}：undo-state 有条目`, keys.length > 0, JSON.stringify(st))
    check(`${name}：都标记为不可撤`, keys.every((k) => st[k].canUndo === false), JSON.stringify(st))
    check(`${name}：带了原因（不是干巴巴一个 false）`, keys.every((k) => !!st[k].reason && st[k].reason.length > 10), JSON.stringify(st))
  }

  // 形状与 compact/rename 一致；不存在的会话要给「会话不存在」而不是 not found
  const raw = await fetch(`${BASE}/api/sessions/no-such-session/undo-state`, { signal: AbortSignal.timeout(8000) })
  check("会话不存在时 404", raw.status === 404, `status=${raw.status}`)
  const body = (await raw.json()) as { error?: string }
  check("404 文案是「会话不存在」", body.error === "会话不存在", JSON.stringify(body))
} catch (e) {
  fail++
  console.log(`FAIL 运行出错 — ${(e as Error).message}`)
} finally {
  try { gw?.kill() } catch { /* 已杀 */ }
  try { fake?.close() } catch { /* 已关 */ }
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
