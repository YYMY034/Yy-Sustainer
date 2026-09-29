/**
 * T92 MCP 超时策略单测
 *
 * 这个模块的由来值得一提：白皮书 9.7 曾把「MCP callTool 无超时」列为遗留项，
 * 但核实 SDK 源码后发现**默认就有 60 秒超时**（`options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC`）。
 * 所以真正要测的不是「有没有超时」，而是「超时值怎么解析」「超时怎么判定」「超时文案够不够用」。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  MCP_DEFAULT_TIMEOUT_MS,
  MCP_MAX_TOTAL_MS,
  MCP_REQUEST_TIMEOUT_CODE,
  isMcpTimeout,
  mcpCallErrorText,
  resolveMcpTimeoutMs,
} from "../src/mcp/timeout.js"

test("默认超时是 120 秒（比 SDK 内置的 60 秒宽松一倍）", () => {
  assert.equal(MCP_DEFAULT_TIMEOUT_MS, 120_000)
  assert.equal(resolveMcpTimeoutMs(undefined), MCP_DEFAULT_TIMEOUT_MS)
  assert.equal(resolveMcpTimeoutMs(null), MCP_DEFAULT_TIMEOUT_MS)
})

test("总时长硬上限必须大于单次超时（否则配置一调大就自相矛盾）", () => {
  assert.ok(MCP_MAX_TOTAL_MS > MCP_DEFAULT_TIMEOUT_MS)
  assert.equal(MCP_MAX_TOTAL_MS, 30 * 60_000)
})

test("接受正整数配置（含字符串形式的数字）", () => {
  assert.equal(resolveMcpTimeoutMs(300_000), 300_000)
  assert.equal(resolveMcpTimeoutMs("45000"), 45_000)
  assert.equal(resolveMcpTimeoutMs(1000.7), 1000, "小数向下取整")
})

test("非法配置一律退回默认值（不能把 0 当成「不超时」）", () => {
  assert.equal(resolveMcpTimeoutMs(0), MCP_DEFAULT_TIMEOUT_MS)
  assert.equal(resolveMcpTimeoutMs(-1), MCP_DEFAULT_TIMEOUT_MS)
  assert.equal(resolveMcpTimeoutMs(Number.NaN), MCP_DEFAULT_TIMEOUT_MS)
  assert.equal(resolveMcpTimeoutMs(Number.POSITIVE_INFINITY), MCP_DEFAULT_TIMEOUT_MS)
  assert.equal(resolveMcpTimeoutMs("abc"), MCP_DEFAULT_TIMEOUT_MS)
  assert.equal(resolveMcpTimeoutMs({}), MCP_DEFAULT_TIMEOUT_MS)
})

test("isMcpTimeout：按错误码识别", () => {
  assert.equal(isMcpTimeout({ code: MCP_REQUEST_TIMEOUT_CODE, message: "随便什么" }), true)
  assert.equal(MCP_REQUEST_TIMEOUT_CODE, -32001, "ErrorCode.RequestTimeout 的取值")
})

test("isMcpTimeout：按 message 兜底识别（不同版本 SDK 文案不一致）", () => {
  assert.equal(isMcpTimeout(new Error("Request timed out")), true)
  assert.equal(isMcpTimeout(new Error("request timeout after 60000ms")), true)
  assert.equal(isMcpTimeout(new Error("Maximum total timeout exceeded")), true)
})

test("isMcpTimeout：不误判其他错误", () => {
  assert.equal(isMcpTimeout(new Error("ECONNREFUSED 127.0.0.1:3000")), false)
  assert.equal(isMcpTimeout(new Error("工具执行失败")), false)
  assert.equal(isMcpTimeout({ code: -32603, message: "Internal error" }), false)
})

test("isMcpTimeout：对 null / undefined / 原始值不抛错", () => {
  assert.equal(isMcpTimeout(null), false)
  assert.equal(isMcpTimeout(undefined), false)
  assert.equal(isMcpTimeout("timeout"), false, "字符串不是错误对象，不认")
  assert.equal(isMcpTimeout(42), false)
})

test("超时文案：说清等了多久 + 可能原因 + 怎么改", () => {
  const txt = mcpCallErrorText("tabbit", "browser_click", { code: MCP_REQUEST_TIMEOUT_CODE, message: "Request timed out" }, 120_000)
  assert.match(txt, /tabbit\/browser_click/, "要指名道姓说是哪个 server 的哪个工具")
  assert.match(txt, /120 秒/, "要告诉用户等了多久")
  assert.match(txt, /npx/, "要给出最可能的原因")
  assert.match(txt, /mcpTimeoutMs/, "要给出可操作的配置项")
})

test("非超时文案：保留原始错误信息（别把真实原因吃掉）", () => {
  const txt = mcpCallErrorText("fs", "read_file", new Error("ENOENT: no such file"), 120_000)
  assert.match(txt, /fs\/read_file/)
  assert.match(txt, /ENOENT: no such file/)
  assert.doesNotMatch(txt, /mcpTimeoutMs/, "非超时不该扯超时配置")
})

test("非 Error 对象也能生成文案（不能因为拿不到 message 就崩）", () => {
  const txt = mcpCallErrorText("s", "t", { weird: true }, 120_000)
  assert.match(txt, /s\/t/)
  assert.ok(txt.length > 10)
})
