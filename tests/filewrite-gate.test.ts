/**
 * T93：文件写入权限门的判定语义单测。
 *
 * 背景：T90 给 `write` / `edit` 修好了「工作区外写盘按危险操作处理」，
 * 但 `xlsx_write` / `docx_write` / `imggen` / `videogen` 四个工具一处都没调 `gate()`——
 * 换工具名就能绕过确认。修法是把判定抽成 `gateFileWrite` 单一出口。
 *
 * 这个文件盯的是**判定语义**（而不是「谁调了它」——那是 scripts/probe-write-gate.ts 的活）：
 * 一旦有人改坏了 inside/outside 的判定，这里当场红。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { gateFileWrite, insideWorkspace } from "../src/agent/permissions.js"
import type { QuestionBroker } from "../src/agent/ask.js"

const CWD = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj"

/** 记录被问过什么，并按预设回答 */
function fakeBroker(answer: string): QuestionBroker & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    ask: async (q: { question: string }) => {
      asked.push(q.question)
      return answer
    },
  } as unknown as QuestionBroker & { asked: string[] }
}

const inside = process.platform === "win32" ? "C:\\work\\proj\\out.xlsx" : "/work/proj/out.xlsx"
const outside = process.platform === "win32" ? "C:\\Users\\x\\.yyagent\\config.json" : "/home/x/.yyagent/config.json"

test("insideWorkspace：工作区内为真", () => {
  assert.equal(insideWorkspace(inside, CWD), true)
  assert.equal(insideWorkspace(CWD, CWD), true, "cwd 自己也算区内")
})

test("insideWorkspace：工作区外为假", () => {
  assert.equal(insideWorkspace(outside, CWD), false)
})

test("insideWorkspace：相对路径按 cwd 解析，逃逸出 .. 判为区外", () => {
  const esc = process.platform === "win32" ? "C:\\work\\other\\a.txt" : "/work/other/a.txt"
  assert.equal(insideWorkspace(esc, CWD), false)
  // 区内的相对路径
  assert.equal(insideWorkspace(process.platform === "win32" ? "C:\\work\\proj\\sub\\a.txt" : "/work/proj/sub/a.txt", CWD), true)
})

test("full-auto：任何路径都放行，且不问用户", async () => {
  const b = fakeBroker("拒绝")
  assert.equal(await gateFileWrite({ tool: "xlsx_write", target: outside, cwd: CWD, mode: "full-auto", broker: b, sessionId: "s1" }), null)
  assert.equal(b.asked.length, 0)
})

test("danger-confirm + 工作区内：放行且不问（正常干活不该被拦）", async () => {
  const b = fakeBroker("拒绝")
  assert.equal(await gateFileWrite({ tool: "xlsx_write", target: inside, cwd: CWD, mode: "danger-confirm", broker: b, sessionId: "s2" }), null)
  assert.equal(b.asked.length, 0, "区内写盘不该弹确认")
})

test("danger-confirm + 工作区外 + 有 broker：会问，用户允许则放行", async () => {
  const b = fakeBroker("允许（y）")
  assert.equal(await gateFileWrite({ tool: "docx_write", target: outside, cwd: CWD, mode: "danger-confirm", broker: b, sessionId: "s3" }), null)
  assert.equal(b.asked.length, 1, "区外写盘必须问")
  assert.match(b.asked[0], /docx_write/, "确认框要带上工具名，否则用户不知道是什么在写")
})

test("danger-confirm + 工作区外 + 有 broker + 用户拒绝：返回拒绝说明", async () => {
  const b = fakeBroker("拒绝")
  const r = await gateFileWrite({ tool: "imggen", target: outside, cwd: CWD, mode: "danger-confirm", broker: b, sessionId: "s4" })
  assert.ok(r && r.includes("拒绝"), `应返回拒绝说明，实际 ${JSON.stringify(r)}`)
})

test("danger-confirm + 工作区外 + 无 broker（无人值守）：直接拒绝，不挂起", async () => {
  const r = await gateFileWrite({ tool: "videogen", target: outside, cwd: CWD, mode: "danger-confirm", sessionId: "s5" })
  assert.ok(r && r.includes("权限拒绝"), `无人值守的区外写盘必须拒绝，实际 ${JSON.stringify(r)}`)
})

test("confirm-all + 工作区内 + 有 broker：会问（confirm-all 就是要全问）", async () => {
  const b = fakeBroker("允许（y）")
  assert.equal(await gateFileWrite({ tool: "xlsx_write", target: inside, cwd: CWD, mode: "confirm-all", broker: b, sessionId: "s6" }), null)
  assert.equal(b.asked.length, 1)
})

test("区外授权按目录粒度记：同目录第二个文件不再问", async () => {
  const b = fakeBroker("允许（y）")
  const dir = process.platform === "win32" ? "C:\\Users\\x\\outdir" : "/home/x/outdir"
  const f1 = process.platform === "win32" ? `${dir}\\a.xlsx` : `${dir}/a.xlsx`
  const f2 = process.platform === "win32" ? `${dir}\\b.xlsx` : `${dir}/b.xlsx`
  assert.equal(await gateFileWrite({ tool: "xlsx_write", target: f1, cwd: CWD, mode: "danger-confirm", broker: b, sessionId: "s7" }), null)
  assert.equal(await gateFileWrite({ tool: "xlsx_write", target: f2, cwd: CWD, mode: "danger-confirm", broker: b, sessionId: "s7" }), null)
  assert.equal(b.asked.length, 1, "同一目录第二个文件不该再问（否则写十个文件要问十次）")
})

test("授权是会话级的：换会话要重新问", async () => {
  const b = fakeBroker("允许（y）")
  const dir = process.platform === "win32" ? "C:\\Users\\x\\outdir2" : "/home/x/outdir2"
  const f = process.platform === "win32" ? `${dir}\\a.xlsx` : `${dir}/a.xlsx`
  await gateFileWrite({ tool: "xlsx_write", target: f, cwd: CWD, mode: "danger-confirm", broker: b, sessionId: "s8" })
  await gateFileWrite({ tool: "xlsx_write", target: f, cwd: CWD, mode: "danger-confirm", broker: b, sessionId: "s9" })
  assert.equal(b.asked.length, 2, "换会话必须重新问")
})

test("拒绝的默认项是「拒绝」——习惯性回车不能等于开门", async () => {
  // QuestionBroker 的 defaultOption 由 gate 传，这里用「直接返回默认项」的 broker 模拟回车
  const asked: Array<{ question: string; defaultOption?: string }> = []
  const broker = {
    ask: async (q: { question: string; defaultOption?: string }) => {
      asked.push(q)
      return q.defaultOption ?? "允许（y）"
    },
  } as unknown as QuestionBroker
  const r = await gateFileWrite({ tool: "docx_write", target: outside, cwd: CWD, mode: "danger-confirm", broker, sessionId: "s10" })
  assert.equal(asked[0]?.defaultOption, "拒绝")
  assert.ok(r && r.includes("拒绝"), "默认项是拒绝时，回车应答必须得到拒绝")
})
