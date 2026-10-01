/**
 * T92 会话存储单测
 *
 * 最有价值的一条是最后那个跨进程用例：**三个真实子进程同时建会话，一条都不能丢**。
 * 这正是 T92 加锁要解决的问题——加锁前 index 的「读-改-写」会互相覆盖，
 * 15 次并发创建通常只剩下 8~12 条，而且丢哪几条完全随机、事后无从追查。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  archiveStaleSessions,
  createSession,
  deleteSession,
  listSessions,
  loadSession,
  persist,
  repairIndex,
  toCoreMessages,
  truncateFrom,
} from "../src/session/store.js"

const SESSIONS = join(homedir(), ".yyagent", "sessions")
const INDEX = join(SESSIONS, "index.json")

/** 每个用例从干净状态开始（沙箱 HOME 由跑批器提供，这里只清会话目录） */
function reset(): void {
  rmSync(SESSIONS, { recursive: true, force: true })
}

function runWorker(n: number, tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", "tsx", "tests/helpers/create-worker.mjs", String(n), tag], {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    })
    let err = ""
    p.stderr?.on("data", (d) => {
      err += String(d)
    })
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker(${tag}) 退出码 ${code}: ${err.slice(0, 300)}`))))
  })
}

test("createSession 落盘 + 写进 index", () => {
  reset()
  const meta = createSession("C:\\proj", "model-x", "标题A")
  assert.ok(meta.id)
  assert.equal(meta.title, "标题A")
  assert.ok(existsSync(join(SESSIONS, `${meta.id}.json`)))
  const list = listSessions()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, meta.id)
})

test("persist 更新消息与 meta，index 里同步", () => {
  reset()
  const meta = createSession("C:\\proj")
  meta.title = "改过名"
  persist(meta, [{ role: "user", content: "你好", ts: 1 }])
  const file = loadSession(meta.id)
  assert.equal(file?.messages.length, 1)
  assert.equal(file?.meta.title, "改过名")
  assert.equal(listSessions().find((s) => s.id === meta.id)?.title, "改过名")
})

test("deleteSession 同时清 index 与会话文件", () => {
  reset()
  const meta = createSession("C:\\proj")
  deleteSession(meta.id)
  assert.equal(listSessions().length, 0)
  assert.equal(existsSync(join(SESSIONS, `${meta.id}.json`)), false)
  assert.equal(loadSession(meta.id), undefined)
})

test("loadSession 对坏 JSON 返回 undefined 而不是把调用方带走", () => {
  reset()
  const meta = createSession("C:\\proj")
  writeFileSync(join(SESSIONS, `${meta.id}.json`), "{ 这不是 JSON")
  assert.equal(loadSession(meta.id), undefined)
})

test("loadSession 对结构异常的 JSON 也返回 undefined", () => {
  reset()
  const meta = createSession("C:\\proj")
  writeFileSync(join(SESSIONS, `${meta.id}.json`), JSON.stringify({ meta, messages: "不是数组" }))
  assert.equal(loadSession(meta.id), undefined)
})

test("index 坏掉时 listSessions 退化为空列表（不抛）", () => {
  reset()
  createSession("C:\\proj")
  writeFileSync(INDEX, "{{{")
  assert.deepEqual(listSessions(), [])
})

test("写盘不留 .tmp 残留", () => {
  reset()
  for (let i = 0; i < 5; i++) createSession(`C:\\p${i}`)
  const leftovers = readdirSync(SESSIONS).filter((f) => f.endsWith(".tmp"))
  assert.deepEqual(leftovers, [], "原子写的临时文件必须被 rename 走或清掉")
})

test("index.json 始终是合法 JSON（原子写的意义）", () => {
  reset()
  for (let i = 0; i < 20; i++) createSession(`C:\\p${i}`)
  const parsed = JSON.parse(readFileSync(INDEX, "utf8"))
  assert.ok(Array.isArray(parsed))
  assert.equal(parsed.length, 20)
})

test("toCoreMessages 过滤 system 与空内容", () => {
  const out = toCoreMessages([
    { role: "system", content: "模型切换提示", ts: 1 },
    { role: "user", content: "   ", ts: 2 },
    { role: "user", content: "真的问题", ts: 3 },
    { role: "assistant", content: "回答", ts: 4 },
  ])
  assert.deepEqual(out.map((m) => m.content), ["真的问题", "回答"])
})

test("toCoreMessages 剥 assistant 的思考块（T102：历史思考只烧 token 不带信息）", () => {
  const out = toCoreMessages([
    // 闭合思考块 → 剥掉，正文保留
    { role: "assistant", content: "<thinking>先想想</thinking>\n\n结论是 A", ts: 1 },
    // 未闭合（停止兜底落库的半截）→ 整段剥掉
    { role: "assistant", content: "<thinking>被打断的思考", ts: 2 },
    // 纯思考回合 → 剥完为空，整条丢弃（空 assistant 消息上游 API 拒收）
    { role: "assistant", content: "<thinking>只有思考</thinking>", ts: 3 },
    // 用户消息里的 <thinking> 是贴的代码/示例 → 原样保留（剥了就是篡改用户输入）
    { role: "user", content: "这个标签啥意思：<thinking>hi</thinking>", ts: 4 },
    // 没有思考块的正常消息不动
    { role: "assistant", content: "普通回答", ts: 5 },
  ])
  assert.deepEqual(out.map((m) => m.content), ["结论是 A", "这个标签啥意思：<thinking>hi</thinking>", "普通回答"])
  assert.deepEqual(out.map((m) => m.ts), [1, 4, 5])
})

test("truncateFrom 按 ts 截断，找不到返回 undefined", () => {
  const msgs = [
    { role: "user" as const, content: "a", ts: 1 },
    { role: "assistant" as const, content: "b", ts: 2 },
    { role: "user" as const, content: "c", ts: 3 },
  ]
  assert.deepEqual(truncateFrom(msgs, 3)?.map((m) => m.content), ["a", "b"])
  assert.equal(truncateFrom(msgs, 999), undefined)
})

test("archiveStaleSessions：超期会话移入 archive/ 并剔出 index，不删除（T111）", () => {
  reset()
  const a = createSession("C:\\p", undefined, "A")
  const b = createSession("C:\\p", undefined, "B")
  // 把 A 的 updatedAt 拨到 30 天前
  const fa = loadSession(a.id)!
  persist({ ...fa.meta, updatedAt: Date.now() - 30 * 86_400_000 }, fa.messages)

  const r = archiveStaleSessions(7)
  assert.equal(r.archived, 1)
  assert.deepEqual(r.ids, [a.id])
  assert.equal(loadSession(a.id), undefined, "主目录里应该已经移走")
  const archFile = join(SESSIONS, "archive", `${a.id}.json`)
  assert.ok(existsSync(archFile), "归档文件应存在（移动不是删除）")
  const arch = JSON.parse(readFileSync(archFile, "utf8"))
  assert.ok(Array.isArray(arch.messages), "归档文件内容完整")
  assert.ok(loadSession(b.id), "未过期会话不受影响")

  // days<=0 是显式关闭，一个都不动
  const r0 = archiveStaleSessions(0)
  assert.equal(r0.archived, 0)
})

test("repairIndex：剔除 index 里有、磁盘上没有的条目", () => {
  reset()
  const a = createSession("C:\\p", undefined, "A")
  const b = createSession("C:\\p", undefined, "B")
  // 模拟「会话文件被外部删掉」——index 里还留着，点进去就是 404
  rmSync(join(SESSIONS, `${b.id}.json`), { force: true })
  const r = repairIndex()
  assert.equal(r.dropped, 1)
  assert.equal(r.changed, true)
  const list = listSessions()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, a.id)
})

test("repairIndex：补回磁盘上有、index 里没有的会话（persist 第二步失败的场景）", () => {
  reset()
  const a = createSession("C:\\p", undefined, "A")
  const b = createSession("C:\\p", undefined, "B")
  // 把 index 退回「只有 a」的状态：b 的文件在，但列表里没有 → 用户根本看不到这个会话
  writeFileSync(INDEX, JSON.stringify([a]))
  const r = repairIndex()
  assert.equal(r.recovered, 1)
  assert.equal(r.changed, true)
  const list = listSessions()
  assert.equal(list.length, 2)
  assert.ok(list.some((s) => s.id === b.id), "补回来的会话必须出现在列表里")
})

test("repairIndex：两侧本来就一致时不写盘（幂等）", () => {
  reset()
  createSession("C:\\p")
  createSession("C:\\p")
  const before = readFileSync(INDEX, "utf8")
  const r = repairIndex()
  assert.equal(r.changed, false)
  assert.equal(r.dropped, 0)
  assert.equal(r.recovered, 0)
  assert.equal(r.total, 2)
  assert.equal(readFileSync(INDEX, "utf8"), before, "没偏差就不该动文件")
})

test("repairIndex：坏文件只计数、不删（用户数据不擅自处理）", () => {
  reset()
  createSession("C:\\p")
  writeFileSync(join(SESSIONS, "broken.json"), "{ 这不是 JSON")
  const r = repairIndex()
  assert.equal(r.unreadable, 1)
  assert.equal(r.recovered, 0, "读不出来的文件不能当成有效会话补进列表")
  assert.equal(existsSync(join(SESSIONS, "broken.json")), true, "坏文件必须保留，交给人判断")
})

test("repairIndex：非会话文件（带点的名字）不参与对齐", () => {
  reset()
  createSession("C:\\p")
  // 会话 id 是 8 位十六进制、不含点；带点的 .json 是备份/临时产物，不该被当成会话
  writeFileSync(join(SESSIONS, "abc.def.json"), "{}")
  writeFileSync(join(SESSIONS, "index.json.1"), "[]")
  const r = repairIndex()
  assert.equal(r.unreadable, 0)
  assert.equal(r.recovered, 0)
  assert.equal(r.changed, false)
  assert.equal(existsSync(join(SESSIONS, "abc.def.json")), true, "不该顺手删掉不认识的文件")
})

test("repairIndex：修完 index 仍是合法 JSON 且按 updatedAt 倒序", () => {
  reset()
  const a = createSession("C:\\p", undefined, "老会话")
  const b = createSession("C:\\p", undefined, "新会话")
  a.updatedAt = 1000
  b.updatedAt = 2000
  persist(a, [{ role: "user", content: "x", ts: 1 }])
  persist(b, [{ role: "user", content: "y", ts: 2 }])
  writeFileSync(INDEX, "[]") // 整个列表清空 → 两个都要补回
  const r = repairIndex()
  assert.equal(r.recovered, 2)
  const parsed = JSON.parse(readFileSync(INDEX, "utf8"))
  assert.ok(Array.isArray(parsed))
  assert.equal(parsed[0].id, b.id, "最近更新的排前面（与 persist 的 unshift 语义一致）")
})

test("跨进程并发建会话一条都不丢（T92 锁的核心用例）", async () => {
  reset()
  await Promise.all([runWorker(5, "A"), runWorker(5, "B"), runWorker(5, "C")])
  const list = listSessions()
  assert.equal(list.length, 15, `三个进程各建 5 个，index 应恰好 15 条，实际 ${list.length}`)
  assert.equal(new Set(list.map((s) => s.id)).size, 15, "不该出现重复 id")
  for (const m of list) {
    assert.ok(existsSync(join(SESSIONS, `${m.id}.json`)), `index 里的 ${m.id} 必须有对应会话文件`)
  }
  assert.equal(existsSync(join(SESSIONS, "index.json.lock")), false, "锁文件不该残留")
  assert.deepEqual(
    readdirSync(SESSIONS).filter((f) => f.endsWith(".tmp")),
    [],
    "并发写不该留下临时文件",
  )
})
