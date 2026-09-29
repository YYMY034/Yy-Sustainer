/**
 * T93 B1：后台任务元数据落盘的守卫。
 *
 * 盯的重点是那个**由本次改动放大**的 bug：`bgSeq` 原本是进程内计数器，重启归零。
 * 在不落盘时它无害（Map 也空了）；一旦落盘，重启后的 `bg-1` 会覆盖旧 `bg-1` 的记录，
 * 而 `bg-1.log` 还在 7 天保留期内 → 模型读到的是**错配的日志**。
 * 所以 `nextBgId()` 必须从磁盘已有的最大序号起步，这条有专门的回归断言。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  BG_MAX_RECORDS,
  BG_TASKS_VERSION,
  bgLogPath,
  getBgTask,
  isValidBgId,
  listBgTasks,
  loadBgTasks,
  nextBgId,
  saveBgTask,
  sweepBgRecords,
} from "../src/agent/bgStore.js"

const DIR = join(homedir(), ".yyagent", "bg")
const TASKS = join(DIR, "tasks.json")

function clean(): void {
  try { rmSync(DIR, { recursive: true, force: true }) } catch { /* 本来就不存在 */ }
}
const rec = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  pid: 1234,
  command: `echo ${id}`,
  logFile: join(DIR, `${id}.log`),
  cwd: "C:\\work",
  startedAt: 1000,
  ...over,
})

test("空目录下第一个 id 是 bg-1", () => {
  clean()
  assert.equal(nextBgId(), "bg-1")
})

test("**id 撞车回归**：磁盘上有 bg-1 且日志还在时，下一个必须是 bg-2", () => {
  clean()
  mkdirSync(DIR, { recursive: true })
  saveBgTask(rec("bg-1"))
  writeFileSync(join(DIR, "bg-1.log"), "旧任务的输出\n")
  // 进程内计数器在这里是 0，旧代码会再发一个 bg-1 → 覆盖记录、日志错配
  assert.equal(nextBgId(), "bg-2", "重启后又发了一个 bg-1——它会覆盖旧记录并读到错配的日志")
})

test("序号取磁盘最大值，不是记录条数", () => {
  clean()
  saveBgTask(rec("bg-1", { startedAt: 1 }))
  saveBgTask(rec("bg-7", { startedAt: 7 }))
  saveBgTask(rec("bg-3", { startedAt: 3 }))
  assert.equal(nextBgId(), "bg-8")
})

test("非 bg-<数字> 形状的 id 不参与取max（不会被脏数据卡住）", () => {
  clean()
  saveBgTask(rec("bg-2"))
  saveBgTask({ ...rec("weird-id"), id: "weird-id" })
  saveBgTask({ ...rec("bg-"), id: "bg-" })
  assert.equal(nextBgId(), "bg-3")
})

test("存 → 读 → 更新（同 id 不产生重复记录）", () => {
  clean()
  saveBgTask(rec("bg-1", { startedAt: 5 }))
  saveBgTask(rec("bg-1", { startedAt: 5, endedAt: 9, exitCode: 0 }))
  const all = loadBgTasks()
  assert.equal(all.length, 1)
  assert.equal(all[0].exitCode, 0)
  assert.equal(all[0].v, BG_TASKS_VERSION)
  assert.equal(getBgTask("bg-1")?.endedAt, 9)
})

test("listBgTasks 按 startedAt 倒序（新的在前）", () => {
  clean()
  saveBgTask(rec("bg-1", { startedAt: 1 }))
  saveBgTask(rec("bg-2", { startedAt: 50 }))
  saveBgTask(rec("bg-3", { startedAt: 20 }))
  assert.deepEqual(listBgTasks().map((r) => r.id), ["bg-2", "bg-3", "bg-1"])
})

test("记录数压回上限内，且留的是最新的", () => {
  clean()
  for (let i = 1; i <= BG_MAX_RECORDS + 20; i++) saveBgTask(rec(`bg-${i}`, { startedAt: i }))
  const all = loadBgTasks()
  assert.equal(all.length, BG_MAX_RECORDS, `应裁到 ${BG_MAX_RECORDS} 条，实际 ${all.length}`)
  assert.equal(all[all.length - 1].id, `bg-${BG_MAX_RECORDS + 20}`, "最新的必须留住")
  assert.equal(all[0].id, "bg-21", "最旧的 20 条应被裁掉")
})

test("文件不存在 / JSON 坏 / 版本不符 → 空数组，不抛", () => {
  clean()
  assert.deepEqual(loadBgTasks(), [])
  mkdirSync(DIR, { recursive: true })
  writeFileSync(TASKS, '{"v":1,"id":"bg-1"') // 半截
  assert.deepEqual(loadBgTasks(), [])
  writeFileSync(TASKS, JSON.stringify([{ v: 999, id: "bg-1", startedAt: 1 }]))
  assert.deepEqual(loadBgTasks(), [], "版本不符必须读不出来，不能猜着用")
  writeFileSync(TASKS, '{"not":"an array"}')
  assert.deepEqual(loadBgTasks(), [])
})

test("sweepBgRecords 只清「日志已没了」的记录", () => {
  clean()
  mkdirSync(DIR, { recursive: true })
  saveBgTask(rec("bg-1"))
  saveBgTask(rec("bg-2"))
  writeFileSync(join(DIR, "bg-2.log"), "还在\n")
  const removed = sweepBgRecords()
  assert.equal(removed, 1)
  assert.deepEqual(loadBgTasks().map((r) => r.id), ["bg-2"])
  // 幂等
  assert.equal(sweepBgRecords(), 0)
})

test("写盘是原子写：目录里不留 tmp 残留", () => {
  clean()
  saveBgTask(rec("bg-1"))
  assert.deepEqual(readdirSync(DIR), ["tasks.json"], `只该有目标文件，实际：${readdirSync(DIR).join(", ")}`)
})

test("bgLogPath 只认合法 id，不合法返回 undefined（否则是任意文件读取）", () => {
  const p = bgLogPath("bg-9")
  assert.ok(p && p.startsWith(DIR), String(p))
  assert.ok(p.endsWith("bg-9.log"), String(p))
  // `bg_read` 的 task_id 是**模型给的输入**，直接拼路径 = 开一个任意文件读取
  for (const bad of ["../../etc/passwd", "..\\..\\win.ini", "/etc/passwd", "bg-", "bg-abc", "bg-1.log", "", "bg-99999999999"]) {
    assert.equal(bgLogPath(bad), undefined, `${bad} 不该被拼成路径`)
    assert.equal(getBgTask(bad), undefined, `${bad} 不该查到记录`)
  }
  assert.equal(isValidBgId("bg-1"), true)
  assert.equal(isValidBgId("bg-123456789"), true)
})
