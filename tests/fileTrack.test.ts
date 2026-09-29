/**
 * T93 B0-a：文件快照采集与撤销决策的守卫。
 *
 * 起因：`trackFileChange` 原来一句 `readFileSync(path, "utf8")` 一把梭，没有任何上限。
 * 撞上两个问题：
 *   ① 模型 edit 一个几百 MB 的文件 → 整个进程被撑爆（read 工具有 MAX_READ_BYTES，这里没有）
 *   ② 二进制文件经 utf8 读入再写回 = **损坏**，撤销反而毁文件
 * 修完之后多出一个更要命的坑：**没采到快照的文件在撤销端不能被当成「本轮新建」删掉**——
 * 那些文件原本就存在。所以撤销决策抽成了纯函数 `planUndo`，由这里的断言盯着。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MAX_SNAPSHOT_BYTES,
  beginFileTracking,
  planUndo,
  skipReason,
  takeFileEdits,
  trackFileChange,
  type FileEdit,
} from "../src/agent/fileTrack.js"

const SID = "s-b0"
const dir = mkdtempSync(join(tmpdir(), "yy-ft-"))
const p = (name: string): string => join(dir, name)

/** 跑一轮采集，返回这一轮的记录 */
function collect(files: Array<{ name: string; kind: "write" | "edit" }>): FileEdit[] {
  beginFileTracking(SID)
  for (const f of files) trackFileChange(SID, p(f.name), f.kind)
  return takeFileEdits(SID)
}

test("普通文本文件：采到原全文", () => {
  writeFileSync(p("a.txt"), "第一行\n第二行\n", "utf8")
  const [e] = collect([{ name: "a.txt", kind: "edit" }])
  assert.equal(e.snapshot, "第一行\n第二行\n")
  assert.equal(e.skipped, undefined)
  assert.deepEqual(planUndo(e), { op: "restore", content: "第一行\n第二行\n" })
})

test("write 一个不存在的文件：snapshot=null 且不标 skipped（撤销 = 删除新建）", () => {
  const [e] = collect([{ name: "brand-new.txt", kind: "write" }])
  assert.equal(e.snapshot, null)
  assert.equal(e.skipped, undefined, "新建文件不是 skipped——语义完全不同")
  assert.deepEqual(planUndo(e), { op: "delete" })
})

test("超过上限的文件：不采快照，标 too-large", () => {
  writeFileSync(p("big.bin"), Buffer.alloc(MAX_SNAPSHOT_BYTES + 1, 0x61))
  const [e] = collect([{ name: "big.bin", kind: "edit" }])
  assert.equal(e.snapshot, null)
  assert.equal(e.skipped, "too-large")
})

test("二进制文件（含 NUL）：不采快照，标 binary", () => {
  // PNG 头，含 NUL——原来会被 utf8 读入再写回，等于毁文件
  writeFileSync(p("img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]))
  const [e] = collect([{ name: "img.png", kind: "edit" }])
  assert.equal(e.snapshot, null)
  assert.equal(e.skipped, "binary")
})

test("UTF-16 文件也按二进制挡掉（ASCII 区全是 NUL，utf8 往返必坏）", () => {
  writeFileSync(p("u16.txt"), Buffer.from("hello\u0000", "utf16le"))
  const [e] = collect([{ name: "u16.txt", kind: "edit" }])
  assert.equal(e.skipped, "binary")
})

test("目录：标 unreadable（读了也没法原样写回）", () => {
  mkdirSync(p("adir"), { recursive: true })
  const [e] = collect([{ name: "adir", kind: "edit" }])
  assert.equal(e.skipped, "unreadable")
})

test("同一文件同轮多次修改只留第一次快照（第一次才是「撤销后应回到」的状态）", () => {
  writeFileSync(p("multi.txt"), "原始\n", "utf8")
  const list = collect([
    { name: "multi.txt", kind: "edit" },
    { name: "multi.txt", kind: "edit" },
    { name: "multi.txt", kind: "write" },
  ])
  assert.equal(list.length, 1)
  assert.equal(list[0].snapshot, "原始\n")
})

test("**数据毁灭守卫**：skipped 的文件撤销时一个字节都不动", () => {
  for (const skipped of ["too-large", "binary", "unreadable"] as const) {
    const e: FileEdit = { path: p("victim"), snapshot: null, kind: "edit", ts: 1, skipped }
    const act = planUndo(e)
    assert.equal(act.op, "refuse", `${skipped} 被撤成了 ${act.op}——那文件原本就存在，删了就是数据丢失`)
    assert.ok("reason" in act && act.reason.length > 0, "拒绝必须给原因，否则用户不知道该怎么办")
  }
})

test("反向：没有 skipped 且 snapshot=null 才可以删（那就是本轮新建的）", () => {
  const e: FileEdit = { path: p("new"), snapshot: null, kind: "write", ts: 1 }
  assert.deepEqual(planUndo(e), { op: "delete" })
})

test("skipReason 三种原因都说人话", () => {
  assert.ok(skipReason("too-large").includes("KB"))
  assert.ok(skipReason("binary").includes("二进制"))
  assert.ok(skipReason("unreadable").length > 0)
})

test("未开始追踪的会话不记录（不抛）", () => {
  assert.doesNotThrow(() => trackFileChange("no-such-session", p("x.txt"), "write"))
  assert.deepEqual(takeFileEdits("no-such-session"), [])
})

test("beginFileTracking 会重置上一轮（跨轮不串味）", () => {
  writeFileSync(p("r.txt"), "x", "utf8")
  beginFileTracking("s-reset")
  trackFileChange("s-reset", p("r.txt"), "edit")
  beginFileTracking("s-reset")
  assert.deepEqual(takeFileEdits("s-reset"), [])
})

process.on("exit", () => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录 */ }
})
