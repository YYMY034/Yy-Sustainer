import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { memoryIndexSummary } from "../src/agent/memory.js"

// worker 已隔离 HOME——直接操作沙箱里的 memory 目录（一个测试文件一个沙箱）
const MEM = join(homedir(), ".yyagent", "memory")

test("memoryIndexSummary：两层索引都进摘要（T123）", () => {
  rmSync(MEM, { recursive: true, force: true })
  mkdirSync(join(MEM, "topics"), { recursive: true })
  writeFileSync(join(MEM, "MEMORY.md"), "- user-prefs — 用户偏好 TypeScript")
  mkdirSync(join(MEM, "projects", "demo", "topics"), { recursive: true })
  writeFileSync(join(MEM, "projects", "demo", "MEMORY.md"), "- arch — 文件式一切")
  const s = memoryIndexSummary()
  assert.ok(s.includes("[user 层]") && s.includes("user-prefs"), s.slice(0, 120))
  assert.ok(s.includes("[project:demo]") && s.includes("文件式一切"), s.slice(0, 160))
})

test("memoryIndexSummary：超长截断并提示 __index__（上下文成本有界）", () => {
  rmSync(MEM, { recursive: true, force: true })
  mkdirSync(join(MEM, "topics"), { recursive: true })
  writeFileSync(join(MEM, "MEMORY.md"), "x".repeat(3000))
  const s = memoryIndexSummary()
  assert.ok(s.length <= 1700, `len=${s.length}`)
  assert.ok(s.includes("__index__"))
})

test("memoryIndexSummary：无记忆返回空串（不注入空节）", () => {
  rmSync(MEM, { recursive: true, force: true })
  assert.equal(memoryIndexSummary(), "")
  assert.equal(existsSync(join(MEM, "MEMORY.md")), false)
})
