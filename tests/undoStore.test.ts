/**
 * T93 B2：撤销快照落盘的守卫。
 *
 * 盯的是四类「坏了也不会当场报错」的性质：
 *  ① **绝不快照 `~/.yyagent/` 内部路径**——那里有 `.master.key`，快照它等于把密钥复制一份
 *  ② 单轮预算 / 总预算 / 保留天数真的在起作用（否则磁盘会被悄悄撑满）
 *  ③ 结构版本与半截文件必须读不出来，而不是猜着用
 *  ④ **恢复逻辑只有一处出口**：内存与磁盘两条来源都收敛到 `resolveUndoTurn`，
 *     且磁盘侧复用的是内存侧同一个 `planUndo()`——不另写一套
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  UNDO_VERSION,
  enforceBudget,
  insideYyagent,
  listUndoTurns,
  loadUndoTurn,
  readUndoSnapshot,
  removeUndoTurn,
  resolveUndoTurn,
  saveUndoTurn,
  sweepUndoSnapshots,
  undoCfg,
  undoMissReason,
} from "../src/agent/undoStore.js"
import { MAX_SNAPSHOT_BYTES, type FileEdit } from "../src/agent/fileTrack.js"

// 被测模块的 ROOT 是 `join(homedir(), ".yyagent", "snapshots")`，在**模块加载时**求值。
// 所以测试必须用同一个 homedir()，不能自己 mkdtemp 一个——否则两边指向不同目录
// （表现就是「存成功了却读不出来」）。隔离由跑批器给每个测试文件换 HOME 保证，
// 所以这个测试**必须走 npm test**，不要单独 npx tsx 跑。
const HOME = homedir()
const ROOT = join(HOME, ".yyagent", "snapshots")
const SID = "s-undo"
/** 真实量级的 ts。写 1000/2000 这种小数字会被 enforceBudget 判成「55 年前」当场清掉——
 *  第一版测试就这么错的，表现是「存成功了却读不出来」。 */
const NOW = Date.now()
const t = (n: number): number => NOW + n * 1000

const fe = (path: string, snapshot: string | null, over: Partial<FileEdit> = {}): FileEdit =>
  ({ path, snapshot, kind: "edit", ts: 1, ...over }) as FileEdit

test("默认不落盘（这是本批最重要的默认值）", () => {
  clean()
  // 注意：这里用**不带注入**的调用——验的是「什么都不配时」的真实默认行为
  const ok = saveUndoTurn(SID, t(1), "C:\\work", [fe("C:\\work\\a.txt", "旧内容")])
  assert.equal(ok, false, "undo.persist 缺省为 false，saveUndoTurn 应该直接不写")
  assert.equal(existsSync(ROOT), false, "目录都不该被创建")
  assert.equal(undoCfg().persist, false, "默认必须是关的")
})

test("打开后：存 → 读 → 撤销目标可解析", () => {
  clean()
  
  const edits = [fe("C:\\work\\a.txt", "旧内容A"), fe("C:\\work\\b.txt", "旧内容B")]
  assert.equal(saveUndoTurnON(SID, t(2), "C:\\work", edits), true)

  const turn = loadUndoTurn(SID, t(2))
  assert.ok(turn, "应读得到")
  assert.equal(turn!.v, UNDO_VERSION)
  assert.equal(turn!.files.length, 2)
  assert.equal(readUndoSnapshot(SID, t(2), turn!.files[0]), "旧内容A")

  // 内存没有时走磁盘
  const target = resolveUndoTurn(undefined, SID, t(2))
  assert.ok(target, "磁盘应能解析出撤销目标")
  assert.equal(target!.source, "disk")
  assert.equal(target!.files.length, 2)
  assert.deepEqual(target!.files[0].plan, { op: "restore", content: "旧内容A" })
  assert.equal(target!.files[1].plan.op, "restore")
})

test("**内存优先于磁盘**（内存那份来自活进程，最新）", () => {
  clean()
  
  saveUndoTurnON(SID, t(3), "C:\\work", [fe("C:\\work\\a.txt", "磁盘里的旧内容")])
  const mem = [fe("C:\\work\\a.txt", "内存里的旧内容")]
  const target = resolveUndoTurn(mem, SID, t(3))
  assert.equal(target!.source, "memory")
  assert.deepEqual(target!.files[0].plan, { op: "restore", content: "内存里的旧内容" })
})

test("**绝不快照 ~/.yyagent/ 内部路径**（那里有 .master.key）", () => {
  clean()
  
  const yy = join(HOME, ".yyagent")
  const secret = join(yy, ".master.key")
  const cfgFile = join(yy, "config.json")
  const nested = join(yy, "sessions", "x.json")
  const outside = "C:\\work\\a.txt"
  saveUndoTurnON(SID, t(4), "C:\\work", [
    fe(secret, "KEYDATA"),
    fe(cfgFile, "{}"),
    fe(nested, "{}"),
    fe(outside, "外部文件"),
  ])
  const turn = loadUndoTurn(SID, t(4))!
  const byPath = new Map(turn.files.map((f) => [f.path, f]))
  assert.equal(byPath.get(secret)?.skippedOnDisk, "inside-yyagent", "密钥被落盘了")
  assert.equal(byPath.get(cfgFile)?.skippedOnDisk, "inside-yyagent")
  assert.equal(byPath.get(nested)?.skippedOnDisk, "inside-yyagent")
  assert.equal(byPath.get(outside)?.skippedOnDisk, undefined, "外部文件应该正常落盘")
  // 目录里不该有对应 .snap
  const snaps = readdirSync(join(ROOT, SID, String(t(4)))).filter((f) => f.endsWith(".snap"))
  assert.equal(snaps.length, 1, `只该有一份快照，实际 ${snaps.length} 份`)

  // 撤销时这些路径必须被拒绝，而不是被删除/写坏
  const target = resolveUndoTurn(undefined, SID, t(4))!
  const refused = target.files.filter((f) => f.plan.op === "refuse")
  assert.equal(refused.length, 3, "三条内部路径都该被拒绝")
  assert.ok(refused.every((f) => "reason" in f.plan && f.plan.reason.includes("~/.yyagent/")), "拒绝原因要说清是按设计不落盘")
})

test("insideYyagent 的边界：目录自身、子路径、以及极易误判的兄弟目录", () => {
  assert.equal(insideYyagent(join(HOME, ".yyagent")), true, "目录自身算内部")
  assert.equal(insideYyagent(join(HOME, ".yyagent", "a", "b")), true)
  // `.yyagent-backup` 是**兄弟**目录，不是内部——前缀匹配不能只比开头几个字符
  assert.equal(insideYyagent(join(HOME, ".yyagent-backup", "x")), false, "兄弟目录被误判成内部了")
  assert.equal(insideYyagent("C:\\work\\a.txt"), false)
})

test("新建文件不建 .snap，撤销 = 删除", () => {
  clean()
  
  saveUndoTurnON(SID, t(5), "C:\\work", [fe("C:\\work\\new.txt", null, { kind: "write" })])
  const target = resolveUndoTurn(undefined, SID, t(5))!
  assert.deepEqual(target!.files[0].plan, { op: "delete" })
})

test("单轮预算：超过就只落前几个，其余记 over-turn-budget", () => {
  clean()
  
  const edits = [
    fe("C:\\work\\a.txt", "x".repeat(1000)),
    fe("C:\\work\\b.txt", "x".repeat(1000)),
    fe("C:\\work\\c.txt", "x".repeat(1000)),
    fe("C:\\work\\d.txt", "x".repeat(1000)),
  ]
  saveUndoTurnON(SID, t(6), "C:\\work", edits, { maxTurnBytes: 3000 })
  const turn = loadUndoTurn(SID, t(6))!
  const landed = turn.files.filter((f) => f.file)
  const skipped = turn.files.filter((f) => f.skippedOnDisk === "over-turn-budget")
  assert.equal(landed.length, 3, `应落 3 个（3000 字节预算），实际 ${landed.length}`)
  assert.equal(skipped.length, 1, "第 4 个应被记为超预算")
  // 超预算的那些撤销时必须拒绝，不能动文件
  const target = resolveUndoTurn(undefined, SID, t(6))!
  assert.equal(target.files.filter((f) => f.plan.op === "refuse").length, 1)
})

test("单文件超限不进磁盘（沿用采集侧上限，不设第二个来源）", () => {
  clean()
  
  saveUndoTurnON(SID, t(7), "C:\\work", [fe("C:\\work\\big.txt", "x".repeat(MAX_SNAPSHOT_BYTES + 10))])
  const turn = loadUndoTurn(SID, t(7))!
  assert.equal(turn.files[0].skippedOnDisk, "over-turn-budget")
  assert.equal(turn.files[0].file, undefined)
})

test("总预算：超出按最旧淘汰", () => {
  clean()
  
  const budget = { maxTurnBytes: 100_000, maxTotalBytes: 2500 }
  saveUndoTurnON(SID, t(10), "C:\\work", [fe("C:\\work\\a.txt", "x".repeat(1000))], budget)
  saveUndoTurnON(SID, t(20), "C:\\work", [fe("C:\\work\\a.txt", "x".repeat(1000))], budget)
  saveUndoTurnON(SID, t(30), "C:\\work", [fe("C:\\work\\a.txt", "x".repeat(1000))], budget)
  const kept = listUndoTurns(SID).map((t) => t.ts)
  assert.ok(!kept.includes(t(10)), "最旧的那轮该被淘汰")
  assert.ok(kept.includes(t(30)), "最新的必须留住")
  assert.equal(dirBytes(ROOT) <= 2500 + 2000, true, `总预算没守住：${dirBytes(ROOT)}`)
})

test("保留天数：超期的轮次留不住（save 时就会清掉）", () => {
  clean()
  const old = Date.now() - 3 * 24 * 3600_000
  // 注意：enforceBudget 是 save 内部就跑的，所以「超期」在写入那一瞬就已经被清掉，
  // 不需要等启动扫描——这一点测试要按真实行为写，否则会期待一个不会发生的数字。
  saveUndoTurnON(SID, old, "C:\\work", [fe("C:\\work\\a.txt", "旧")], { keepDays: 1 })
  assert.equal(loadUndoTurn(SID, old), undefined, "超期的轮次应该留不住")
  const fresh = Date.now()
  saveUndoTurnON(SID, fresh, "C:\\work", [fe("C:\\work\\a.txt", "新")], { keepDays: 1 })
  assert.ok(loadUndoTurn(SID, fresh), "没超期的被误删了")
  // 启动扫描是幂等的：没东西可清就返回 0，不该抛
  assert.equal(sweepUndoSnapshots({ ...ON, keepDays: 1 }), 0)
})

test("版本不符 / JSON 坏 → 读不出来，且撤销目标返回 undefined", () => {
  clean()
  
  const dir = join(ROOT, SID, String(t(8)))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "index.json"), JSON.stringify({ v: 999, sessionId: SID, ts: t(8), files: [] }))
  assert.equal(loadUndoTurn(SID, t(8)), undefined)
  assert.equal(resolveUndoTurn(undefined, SID, t(8)), undefined, "坏快照不能猜着用")
  writeFileSync(join(dir, "index.json"), '{"v":1,"sessionId":"s","ts":8000,"files":[')
  assert.equal(loadUndoTurn(SID, t(8)), undefined)
  assert.equal(resolveUndoTurn(undefined, SID, t(8)), undefined)
})

test("快照文件丢了但 index 在 → 拒绝而不是写个空文件", () => {
  clean()
  
  saveUndoTurnON(SID, t(9), "C:\\work", [fe("C:\\work\\a.txt", "内容")])
  rmSync(join(ROOT, SID, String(t(9)), readdirSync(join(ROOT, SID, String(t(9)))).find((f) => f.endsWith(".snap"))!), { force: true })
  const target = resolveUndoTurn(undefined, SID, t(9))!
  assert.equal(target.files[0].plan.op, "refuse", "快照读不出来必须拒绝，不能 restore 一个 undefined")
})

test("撤销后清掉磁盘快照（幂等，不能重复撤）", () => {
  clean()
  
  saveUndoTurnON(SID, t(95), "C:\\work", [fe("C:\\work\\a.txt", "内容")])
  assert.ok(loadUndoTurn(SID, t(95)))
  removeUndoTurn(SID, t(95))
  assert.equal(loadUndoTurn(SID, t(95)), undefined)
  removeUndoTurn(SID, t(95)) // 再删一次不抛
  assert.equal(resolveUndoTurn(undefined, SID, t(95)), undefined)
})

test("原子写：目录里不留 tmp 残留", () => {
  clean()
  
  saveUndoTurnON(SID, t(96), "C:\\work", [fe("C:\\work\\a.txt", "内容")])
  const files = readdirSync(join(ROOT, SID, String(t(96))))
  assert.deepEqual(files.filter((f) => f.includes(".tmp")), [], `有 tmp 残留：${files.join(",")}`)
})

test("undoMissReason 分三种情况，不再混成一句", () => {
  const withMeta = undoMissReason(true)
  assert.ok(withMeta.includes("undo.persist"), "有元数据时要说清怎么打开落盘")
  const noMeta = undoMissReason(false)
  assert.ok(noMeta.includes("没有文件修改记录"), "没有元数据时该说这一轮没改过文件")
  assert.notEqual(withMeta, noMeta)
})

test("listUndoTurns 按 ts 倒序，且跳过非数字目录名", () => {
  clean()
  saveUndoTurnON(SID, t(10), "C:\\work", [fe("C:\\work\\a.txt", "a")])
  saveUndoTurnON(SID, t(30), "C:\\work", [fe("C:\\work\\a.txt", "c")])
  saveUndoTurnON(SID, t(20), "C:\\work", [fe("C:\\work\\a.txt", "b")])
  mkdirSync(join(ROOT, SID, "not-a-number"), { recursive: true })
  assert.deepEqual(listUndoTurns(SID).map((x) => x.ts), [t(30), t(20), t(10)])
})

// ---- 工具 ----
function clean(): void {
  try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* 本来就不存在 */ }
}
/** 打开落盘的注入配置。**用参数注入而不是改 config.json**——loadConfig 有进程内缓存，
 *  测试改文件还得跟缓存搏斗；而网关那边传默认值（不传）就行。 */
const ON = { persist: true } as const
const saveUndoTurnON = (sid: string, ts: number, cwd: string, edits: FileEdit[], over?: Record<string, unknown>): boolean =>
  saveUndoTurn(sid, ts, cwd, edits, { ...ON, ...over })
function dirBytes(dir: string): number {
  let total = 0
  try {
    for (const f of readdirSync(dir)) {
      try {
        const st = statSync(join(dir, f))
        total += st.isDirectory() ? dirBytes(join(dir, f)) : st.size
      } catch { /* 刚被删 */ }
    }
  } catch { /* 不在 */ }
  return total
}

process.on("exit", () => {
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录 */ }
})
