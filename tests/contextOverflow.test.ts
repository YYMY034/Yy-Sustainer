/**
 * T93 P3：上下文超长判定与恢复的守卫。
 *
 * 背景：`config.contextTokens` 是**手拍**的值（默认 131072）。配了 32k/8k 窗口的模型时，
 * 压缩阈值（它的 60%）形同虚设，长任务跑几十步后在某一步突然死掉。而这个错误在
 * `describeFailure` 里落进 `badrequest` → `retryBudget = 0`，提示还说
 * 「通常是该模型不支持所选参数」——**病因完全不相干**，用户既不知道真实原因也不知道能做什么。
 *
 * 这里盯三件事：
 *   ① 各家各族的超长说法都要认得（漏判的代价是任务白死）
 *   ② **不能误伤**：普通 400 / 鉴权 / 限流不能被判成超长，否则会白压一次历史
 *   ③ 恢复只在 executed=0 时发生——工具结果顶爆上下文时 executed>0，
 *      整轮重发会把工具再跑一遍（重复副作用）。这条用静态断言钉死顺序。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { contextOverflowHint, isContextOverflow } from "../src/agent/errors.js"

test("认得各家各族的超长说法", () => {
  const cases: unknown[] = [
    { message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens." },
    { message: "context_length_exceeded" },
    { error: { code: "context_length_exceeded", message: "x" } },
    { message: "Maximum context length exceeded" },
    { message: "This request exceeds the maximum context window" },
    { message: "Too many tokens in prompt" },
    { message: "Request too large for model" },
    { message: "Payload too large" },
    { message: "Please reduce the length of the messages." },
    { message: "string too long for model" },
    { statusCode: 413, message: "whatever" },
    { response: { status: 413 }, message: "nope" },
    { lastError: { message: "string exceeds the maximum allowed" } },
  ]
  for (const c of cases) {
    assert.equal(isContextOverflow(c), true, `没认出来：${JSON.stringify(c)}`)
  }
})

test("**Error 实例也要认**——message 是不可枚举属性，Object.entries 看不到它", () => {
  // asDiagnosedError 包出来的就是普通 Error，真实链路里最常见的一种。
  // 只靠 Object.entries 会整类漏掉（第一版实测漏了，恢复一次都没触发）。
  const e = new Error("Bad Request · This model's maximum context length is 8192 tokens")
  assert.equal(isContextOverflow(e), true, "Error 实例没认出来")
  const wrapped = new Error("上游返回 400")
  ;(wrapped as unknown as { cause: unknown }).cause = new Error("context_length_exceeded")
  assert.equal(isContextOverflow(wrapped), true, "cause 里的超长没认出来")
  const plain = new Error("该模型不支持 temperature 参数")
  assert.equal(isContextOverflow(plain), false, "普通 Error 被误判")
})

test("**不能误伤**：普通 400 / 鉴权 / 限流 / 网络错误不是超长", () => {
  const cases: unknown[] = [
    { message: "该模型不支持 temperature 参数", statusCode: 400 },
    { message: "Invalid API key", statusCode: 401 },
    { message: "Insufficient balance", statusCode: 402 },
    { message: "Rate limit exceeded", statusCode: 429 },
    { message: "Internal server error", statusCode: 500 },
    { message: "fetch failed", statusCode: undefined },
    { message: "模型不存在", statusCode: 404 },
    { message: "" },
    null,
    undefined,
    {},
  ]
  for (const c of cases) {
    assert.equal(isContextOverflow(c), false, `误判成超长了：${JSON.stringify(c)}`)
  }
})

test("嵌套结构里的超长也要认（AI SDK 会把真因埋在 lastError/response.body 里）", () => {
  assert.equal(
    isContextOverflow({ lastError: { responseBody: { error: { message: "maximum context length is 4096" } } } }),
    true,
  )
  assert.equal(
    isContextOverflow({ data: { error: { message: "This model's maximum context length is 8192 tokens" } } }),
    true,
  )
})

test("hint 说清该调什么，并区分「压过还没用」", () => {
  const a = contextOverflowHint(131072, false)
  assert.ok(a.includes("131072"), a)
  assert.ok(a.includes("config.contextTokens"), a)
  const b = contextOverflowHint(131072, true)
  assert.ok(b.includes("已自动压缩"), b)
  assert.notEqual(a, b, "压过和没压过要给不同信息，否则用户不知道该不该再调配置")
})

test("静态：恢复必须排在幂等护栏之后（否则工具会重跑一遍）", () => {
  const gw = readSrc("src/gateway.ts")
  const guardAt = gw.indexOf("为避免重复副作用不再自动重发")
  const recoverAt = gw.indexOf("if (isContextOverflow(e))")
  assert.ok(guardAt > 0 && recoverAt > guardAt, "上下文恢复排在幂等护栏之前了——工具结果顶爆时会重放副作用")
  // 只给一次机会
  assert.ok(gw.includes("if (ctxCompacted) throw new Error(contextOverflowHint("), "没有「只压一次」的闸门")
  // 不擅自改全局配置
  assert.equal(/saveConfig\([\s\S]{0,80}contextTokens/.test(gw), false, "在自动改全局 contextTokens——用户数据不擅自处理")
})

test("静态：silent 分支不能吞掉已有准确病因的错误", () => {
  const gw = readSrc("src/gateway.ts")
  // 「没有输出 + 没有步骤」会把未知错误改写成「模型没有返回任何内容」。
  // 走过超限恢复的错误必须例外——第一版实测：恢复跑了、提示却被替换成那句废话。
  assert.match(gw, /const silent =\s*\n?\s*dinfo\.kind === "unknown" && !streamedText\.trim\(\) && !steps\.length && !ctxCompacted/)
})

test("静态：system 消息不进可压缩历史（和 toCoreMessages 同一套过滤）", () => {
  const gw = readSrc("src/gateway.ts")
  assert.match(gw, /const compactable = messages\s*\n\s*\.filter\(\(m\) => m\.role !== "system"/)
})

import { readFileSync } from "node:fs"
import { join } from "node:path"
function readSrc(p: string): string {
  return readFileSync(join(process.cwd(), p), "utf8")
}
