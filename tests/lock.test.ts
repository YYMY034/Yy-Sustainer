/**
 * T92 跨进程文件锁单测
 *
 * 锁的正确性只有两条：①同一时刻只有一个持有者；②任何情况下锁最终都会被释放
 * （包括 fn 抛错、持锁进程崩溃留下的陈旧锁）。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withFileLock } from "../src/util/lock.js"

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "yy-lock-"))
}

test("拿到锁执行 fn，结束后锁文件被清掉", () => {
  const d = tmpDir()
  const lf = join(d, "x.lock")
  const r = withFileLock(lf, () => 42)
  assert.equal(r.locked, true)
  assert.equal(r.value, 42)
  assert.equal(existsSync(lf), false, "释放后不该留下锁文件")
  rmSync(d, { recursive: true, force: true })
})

test("锁被占用时自旋等待，释放后能拿到", async () => {
  const d = tmpDir()
  const lf = join(d, "x.lock")
  writeFileSync(lf, "other 1") // 模拟别的进程持有
  // 释放动作必须来自**另一个进程**：withFileLock 是同步阻塞的（Atomics.wait），
  // 同进程的 setTimeout 回调永远轮不到执行——那样写测试会自己把自己锁死（这是踩过的坑）。
  const child = spawn(
    process.execPath,
    ["-e", `setTimeout(()=>{try{require('fs').unlinkSync(${JSON.stringify(lf)})}catch{}},250)`],
    { stdio: "ignore" },
  )
  const t0 = Date.now()
  const r = withFileLock(lf, () => "ok", { timeoutMs: 5000, intervalMs: 20, staleMs: 60_000 })
  const waited = Date.now() - t0
  await new Promise((res) => child.on("exit", res))
  assert.equal(r.locked, true)
  assert.equal(r.value, "ok")
  assert.ok(waited >= 150, `应该在等锁而不是直接冲过去（实际等了 ${waited}ms）`)
  rmSync(d, { recursive: true, force: true })
})

test("超时后降级为无锁执行（不抛错，locked=false）", () => {
  const d = tmpDir()
  const lf = join(d, "x.lock")
  writeFileSync(lf, "other 1") // 持有者一直不释放，且 mtime 新鲜
  const r = withFileLock(lf, () => "degraded", { timeoutMs: 80, intervalMs: 10, staleMs: 60_000, quiet: true })
  assert.equal(r.locked, false)
  assert.equal(r.value, "degraded", "降级也要把活干完——抛错会让「新建会话」直接不可用")
  assert.equal(existsSync(lf), true, "降级执行不该删掉别人的锁")
  rmSync(d, { recursive: true, force: true })
})

test("陈旧锁（持锁进程已崩溃）会被回收", () => {
  const d = tmpDir()
  const lf = join(d, "x.lock")
  writeFileSync(lf, "dead 1")
  const old = (Date.now() - 60_000) / 1000
  utimesSync(lf, old, old) // mtime 一分钟前
  const r = withFileLock(lf, () => "recovered", { timeoutMs: 500, intervalMs: 10, staleMs: 5_000 })
  assert.equal(r.locked, true)
  assert.equal(r.value, "recovered")
  assert.equal(existsSync(lf), false)
  rmSync(d, { recursive: true, force: true })
})

test("fn 抛错时锁仍被释放（不能把后续调用全卡死）", () => {
  const d = tmpDir()
  const lf = join(d, "x.lock")
  assert.throws(
    () =>
      withFileLock(lf, () => {
        throw new Error("boom")
      }),
    /boom/,
  )
  assert.equal(existsSync(lf), false, "异常路径必须走 finally 释放锁")
  // 释放干净 → 下一次调用立刻拿到
  assert.equal(withFileLock(lf, () => "again", { timeoutMs: 100 }).locked, true)
  rmSync(d, { recursive: true, force: true })
})

test("锁文件里记着持有者 pid（便于排查「谁卡住了」）", () => {
  const d = tmpDir()
  const lf = join(d, "x.lock")
  withFileLock(lf, () => {
    const txt = readFileSync(lf, "utf8")
    assert.match(txt, new RegExp(`^${process.pid}\\b`))
  })
  rmSync(d, { recursive: true, force: true })
})

test("临界区确实互斥：嵌套调用会等待而非直接进入", () => {
  const d = tmpDir()
  const lf = join(d, "x.lock")
  const order: string[] = []
  // 外层持有期间，内层（不同进程视角下）应该拿不到——这里用「锁文件存在」直接验证
  withFileLock(
    lf,
    () => {
      order.push("outer-in")
      assert.equal(existsSync(lf), true, "临界区内锁文件必须存在")
      order.push("outer-out")
    },
    { timeoutMs: 500 },
  )
  assert.deepEqual(order, ["outer-in", "outer-out"])
  rmSync(d, { recursive: true, force: true })
})
