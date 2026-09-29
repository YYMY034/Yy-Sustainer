/**
 * T92 日志轮转单测
 *
 * 盯住三件事：①没超限时不乱动文件；②超限时按 .1/.2 顺序滚、最老的被丢；
 * ③appendLogLine 的「估算 + 定期 stat 校正」不会把轮转漏掉。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendLogLine, rotateIfNeeded, sweepOldFiles } from "../src/util/logfile.js"

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "yy-logfile-"))
}

test("未超限时不轮转", () => {
  const d = tmpDir()
  const f = join(d, "a.jsonl")
  writeFileSync(f, "x".repeat(100))
  assert.equal(rotateIfNeeded(f, { maxBytes: 1000 }), false)
  assert.equal(existsSync(`${f}.1`), false)
  rmSync(d, { recursive: true, force: true })
})

test("超限时滚成 .1，主文件让位", () => {
  const d = tmpDir()
  const f = join(d, "a.jsonl")
  writeFileSync(f, "A".repeat(500))
  assert.equal(rotateIfNeeded(f, { maxBytes: 100 }), true)
  assert.equal(existsSync(f), false, "滚动后主文件应被移走（由下一次写入重建）")
  assert.equal(readFileSync(`${f}.1`, "utf8"), "A".repeat(500))
  rmSync(d, { recursive: true, force: true })
})

test("keep=2 时保留 .1/.2，更老的被丢弃", () => {
  const d = tmpDir()
  const f = join(d, "a.jsonl")
  // 依次制造三代内容：第一代 → 第二代 → 第三代
  writeFileSync(f, "gen1")
  rotateIfNeeded(f, { maxBytes: 1, keep: 2 }) // gen1 → .1
  writeFileSync(f, "gen2")
  rotateIfNeeded(f, { maxBytes: 1, keep: 2 }) // .1 → .2，gen2 → .1
  writeFileSync(f, "gen3")
  rotateIfNeeded(f, { maxBytes: 1, keep: 2 }) // .2 丢弃，.1 → .2，gen3 → .1
  assert.equal(readFileSync(`${f}.1`, "utf8"), "gen3")
  assert.equal(readFileSync(`${f}.2`, "utf8"), "gen2")
  assert.equal(existsSync(`${f}.3`), false, "keep=2 不该出现第三份")
  rmSync(d, { recursive: true, force: true })
})

test("appendLogLine：小量写入不触发轮转", () => {
  const d = tmpDir()
  const f = join(d, "b.jsonl")
  for (let i = 0; i < 10; i++) appendLogLine(f, `line-${i}\n`, { maxBytes: 4096 })
  assert.equal(readFileSync(f, "utf8").split("\n").filter(Boolean).length, 10)
  assert.equal(existsSync(`${f}.1`), false)
  rmSync(d, { recursive: true, force: true })
})

test("appendLogLine：累计超限后自动轮转，且新文件从零开始记", () => {
  const d = tmpDir()
  const f = join(d, "c.jsonl")
  // 每行 100 字节，上限 250 → 第 3 行写入后累计 300 > 250，应触发轮转
  for (let i = 0; i < 3; i++) appendLogLine(f, `${String(i).padEnd(99, "-")}\n`, { maxBytes: 250 })
  assert.equal(existsSync(`${f}.1`), true, "累计超限应产生 .1")
  const rolled = readFileSync(`${f}.1`, "utf8")
  assert.equal(rolled.split("\n").filter(Boolean).length, 3, "轮转前写进去的行都在 .1 里")
  rmSync(d, { recursive: true, force: true })
})

test("appendLogLine：文件被外部改大后，stat 校正能让它发现超限", () => {
  const d = tmpDir()
  const f = join(d, "d.jsonl")
  appendLogLine(f, "seed\n", { maxBytes: 1024 })
  // 模拟别的进程把文件写爆（自己的估算看不到这段增长）
  writeFileSync(f, "Z".repeat(5000))
  // 写够 STAT_EVERY 次触发校正；这里直接多写几行
  for (let i = 0; i < 70; i++) appendLogLine(f, `pad-${i}\n`, { maxBytes: 1024 })
  assert.equal(existsSync(`${f}.1`), true, "外部增长应被 stat 校正发现并轮转")
  rmSync(d, { recursive: true, force: true })
})

test("sweepOldFiles：按数量保留最近 keep 个", () => {
  const d = tmpDir()
  for (let i = 0; i < 8; i++) {
    const p = join(d, `bg-${i}.log`)
    writeFileSync(p, `out-${i}`)
    // 手动把 mtime 拉开，保证「最近」的判定稳定（同毫秒写入在文件系统上可能并列）
    const t = (Date.now() - (8 - i) * 60_000) / 1000
    utimesSync(p, t, t)
  }
  const removed = sweepOldFiles(d, { keep: 3, maxAgeMs: 365 * 24 * 3600_000, suffix: ".log" })
  assert.equal(removed, 5)
  assert.equal(existsSync(join(d, "bg-7.log")), true, "最新的必须留下")
  assert.equal(existsSync(join(d, "bg-6.log")), true)
  assert.equal(existsSync(join(d, "bg-5.log")), true)
  assert.equal(existsSync(join(d, "bg-4.log")), false)
  rmSync(d, { recursive: true, force: true })
})

test("sweepOldFiles：超过 maxAgeMs 的一律清掉（即使没到 keep 上限）", () => {
  const d = tmpDir()
  const fresh = join(d, "fresh.log")
  const old = join(d, "old.log")
  writeFileSync(fresh, "new")
  writeFileSync(old, "old")
  const ancient = (Date.now() - 30 * 24 * 3600_000) / 1000
  utimesSync(old, ancient, ancient)
  const removed = sweepOldFiles(d, { keep: 10, maxAgeMs: 24 * 3600_000, suffix: ".log" })
  assert.equal(removed, 1)
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(fresh), true)
  rmSync(d, { recursive: true, force: true })
})

test("sweepOldFiles：只动匹配后缀的文件", () => {
  const d = tmpDir()
  writeFileSync(join(d, "keep.txt"), "not a log")
  for (let i = 0; i < 3; i++) writeFileSync(join(d, `x-${i}.log`), "log")
  sweepOldFiles(d, { keep: 1, maxAgeMs: 365 * 24 * 3600_000, suffix: ".log" })
  assert.equal(existsSync(join(d, "keep.txt")), true, "非 .log 文件不该被清")
  rmSync(d, { recursive: true, force: true })
})

test("轮转后的文件大小确实回落（不会边写边滚成死循环）", () => {
  const d = tmpDir()
  const f = join(d, "e.jsonl")
  for (let i = 0; i < 200; i++) appendLogLine(f, `${"y".repeat(200)}\n`, { maxBytes: 2048 })
  const size = statSync(f).size
  assert.ok(size <= 2048 * 2, `轮转后主文件不该无限增长，实际 ${size} 字节`)
  rmSync(d, { recursive: true, force: true })
})
