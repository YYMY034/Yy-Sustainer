/**
 * T93 P3：子代理步数上限与截断标注的守卫。
 *
 * 起因：`delegate` 调 `runAgent` 时 `maxSteps: 30` 硬编码，而主代理是
 * `config.maxSteps ?? 50`——子任务更容易被截断。更糟的是截断后**静默**返回：
 * 主代理分不清它是「做不完」还是「做完了」，于是要么基于半截结果继续跑，
 * 要么反复重派同一个任务。
 *
 * 盯三件事：
 *   ① 上限可配，且默认仍是 30（不擅自改变现状）
 *   ② **用满时必须标注截断**，并告诉调用方该怎么办（这段文案是给模型看的）
 *   ③ 没用满时一个字节都不加——不能把正常结果也污染上警告
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { subagentResult } from "../src/agent/tools.js"

test("没用满上限：原样返回，不加任何警告", () => {
  assert.equal(subagentResult("做完了", 5, 30), "做完了")
  assert.equal(subagentResult("做完了", 29, 30), "做完了")
  assert.equal(subagentResult(" 做完了\n", 1, 30), "做完了", "首尾空白该 trim")
})

test("**用满上限：必须标注截断**，并说清该怎么办", () => {
  const out = subagentResult("跑到一半", 30, 30)
  assert.ok(out.startsWith("跑到一半"), "原文要在前面，模型得看到已产出的部分")
  assert.ok(out.includes("已用完全部 30 步上限"), out)
  assert.ok(out.includes("可能不完整"), out)
  assert.ok(out.includes("不要把它当作最终结论"), out)
  // 要给出可执行的两条路，否则模型只能干瞪眼
  assert.ok(out.includes("拆小"), out)
  assert.ok(out.includes("subagentMaxSteps"), out)
})

test("空正文 + 用满：也不能返回空串", () => {
  const out = subagentResult("", 30, 30)
  assert.ok(out.includes("（子任务没有产出内容）"), out)
  assert.ok(out.includes("已用完全部 30 步上限"), out)
  assert.equal(subagentResult("", 3, 30), "（子任务没有产出内容）")
})

test("cap<=0 视为不设限（不标注）", () => {
  assert.equal(subagentResult("x", 999, 0), "x")
})

test("标注里带上真实上限（配大之后文案要跟着变）", () => {
  const out = subagentResult("半截", 80, 80)
  assert.ok(out.includes("全部 80 步"), out)
  assert.ok(out.includes("当前 80"), out)
  assert.ok(!out.includes("30 步"), "还写着 30——文案没跟着配置走")
})

test("静态：delegate 读配置而不是硬编码，且默认 30", () => {
  const src = readSrc("src/agent/tools.ts")
  assert.equal(/maxSteps: 30,/.test(src), false, "还在硬编码 30")
  assert.match(src, /const cap = loadConfig\(\)\.subagentMaxSteps \?\? 30/, "没有从配置读，或默认值不是 30")
  assert.match(src, /maxSteps: cap,/, "runAgent 没用 cap")
  assert.match(src, /return subagentResult\(r\.text \+ procLine, r\.steps, cap\)/, "返回没走 subagentResult（T100 起回显带过程摘要）")
  const cfg = readSrc("src/agent/config.ts")
  assert.match(cfg, /subagentMaxSteps\?: number/, "config 里没有 subagentMaxSteps")
  // 不该复用 maxSteps——子任务是有界聚焦的活，预算不是同一个概念
  assert.match(cfg, /给独立字段而不是复用 maxSteps/)
})

import { readFileSync } from "node:fs"
import { join } from "node:path"
function readSrc(p: string): string {
  return readFileSync(join(process.cwd(), p), "utf8")
}
