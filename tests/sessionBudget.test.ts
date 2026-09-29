/**
 * T93 P3：会话 token 预算熔断的守卫。
 *
 * 起因：`meta.usage` 记得很全（输入/输出/缓存/轮数/步数），`/api/usage` 也能看，
 * 但**从来不强制**——长任务跑飞了没有刹车，用户是看到账单才知道。
 *
 * 盯四件事：
 *   ① 默认关（0 = 不限）——交互场景用户自己能停，不该替他决定
 *   ② 前置拒绝必须**一个 token 都不花**（不是跑起来再拦）
 *   ③ 轮内熔断必须复用既有的停止路径，且**把这一轮的 token 记进账**——
 *      中止/熔断时 `result.usage` 是 0，不自己累计就永远记不进，预算拦不住第二次
 *   ④ 熔断的落库文案不能写「已停止」（那会让人以为是自己点了停止）
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = (p: string): string => readFileSync(join(process.cwd(), p), "utf8")
const gw = SRC("src/gateway.ts")
const tui = SRC("src/tui/App.tsx")
const cfg = SRC("src/agent/config.ts")
const loop = SRC("src/agent/loop.ts")

test("默认关（0 = 不限），且配置注释写清代价", () => {
  assert.match(cfg, /sessionTokenBudget\?: number/)
  assert.match(cfg, /0 = 不限/)
  assert.match(gw, /const budgetCap = loadConfig\(\)\.sessionTokenBudget \?\? 0/)
  // 判据必须是「> 0 才启用」，不能反过来
  assert.match(gw, /if \(budgetCap > 0 && sessionTokensUsed\(meta\.usage\) >= budgetCap\)/)
})

test("前置拒绝：一个 token 都不花，且说清数字与补救", () => {
  // 必须在加载模型/发起请求之前就 return
  const at = gw.indexOf("budgetCap > 0 && sessionTokensUsed(meta.usage) >= budgetCap")
  const callAt = gw.indexOf("await runAgentStream(")
  assert.ok(at > 0 && at < callAt, "预算检查排在发起请求之后了——超限时还在花钱")
  assert.match(gw, /broadcast\(\{ type: "error", sessionId, message: budgetExceededNotice\(used, budgetCap, "before"\) \}\)/)
  assert.match(gw, /function budgetExceededNotice\([\s\S]*?config\.sessionTokenBudget/)
  assert.match(gw, /function budgetExceededNotice\([\s\S]*?新建会话/)
})

test("轮内熔断复用既有的停止路径，不新增错误分支", () => {
  // 走 abort 让 runAgentStream 早返回 → 落到成功分支的「已停止」落库
  assert.match(gw, /ac\.abort\(new Error\(`budget-exceeded:\$\{budgetCap\}`\)\)/)
  // 只停一次
  assert.match(gw, /if \(budgetCap > 0 && !budgetStopped && /)
  assert.match(gw, /budgetStopped = true/)
})

test("**熔断的那一轮必须记进账**（否则预算拦不住第二次）", () => {
  // 轮内累计
  assert.match(gw, /turnTokens\.in \+= inputTokens/)
  assert.match(gw, /turnTokens\.out \+= outputTokens/)
  // meta.usage 与账本都用轮内累计，不用 r.usage（中止时它是 0）
  assert.match(gw, /const turnIn = turnTokens\.in \|\| r\?\.usage\?\.in \|\| 0/)
  assert.match(gw, /const turnOut = turnTokens\.out \|\| r\?\.usage\?\.out \|\| 0/)
  assert.match(gw, /in: u\.in \+ turnIn,/)
  assert.match(gw, /appendUsage\(\{[\s\S]*?in: turnIn,[\s\S]*?out: turnOut,/)
  // loop 必须把 outputTokens 报上来，否则累计不了
  assert.equal((loop.match(/outputTokens: step\.usage\?\.outputTokens \?\? 0/g) ?? []).length, 3, "三处 onStepFinish 都要报 outputTokens")
})

test("熔断的落库文案区别于「用户主动停止」", () => {
  // 两个分支（有正文 / 无正文）都必须说清是预算熔断——只断言「出现过」太松，
  // 改了一个分支另一个还在就漏了（实测：那么改过之后旧断言确实没红）
  const fnStart = gw.indexOf("const stopOrTimeoutContent = ()")
  const fnEnd = gw.indexOf("const turnTimeout =", fnStart)
  assert.ok(fnStart > 0 && fnEnd > fnStart, "找不到 stopOrTimeoutContent")
  const fnBody = gw.slice(fnStart, fnEnd)
  const hits = (fnBody.match(/token 预算/g) ?? []).length
  assert.ok(hits >= 2, `熔断文案只在 ${hits} 个分支里出现——另一个分支会退化成「已停止」`)
  assert.ok(fnBody.includes("已达到本会话 token 预算而停止，未输出内容"), "无正文分支没说清")
  // 通知条也要分三种，不能一律「已停止」
  assert.match(gw, /text: budgetStopped\s*\n\s*\? `已达本会话 token 预算/)
  assert.match(gw, /: timedOut\s*\n\s*\? `已超时停止/)
})

test("TUI 与网关同一套语义（两条入口一致）", () => {
  assert.match(tui, /const sessionBudget = loadConfig\(\)\.sessionTokenBudget \?\? 0/)
  assert.match(tui, /if \(sessionBudget > 0 && usedBefore >= sessionBudget\)/)
  assert.match(tui, /ac\.abort\(new Error\(`budget-exceeded:\$\{sessionBudget\}`\)\)/)
  // TUI 也要记进账
  assert.match(tui, /turnTokens\.in \+= inputTokens/)
  assert.match(tui, /m\.usage = \{[\s\S]*?in: u\.in \+ \(turnTokens\.in \|\| r\?\.usage\?\.in \|\| 0\)/)
})
