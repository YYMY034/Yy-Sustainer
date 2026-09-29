/**
 * T93 L1：钩子执行层的策略守卫（`hooks.ts`）。
 *
 * 判定逻辑在 hookJudge.ts，这里只管**策略与渲染**。盯三件事：
 *   ① 后端炸了/判不出 → 不阻断主流程（fail-open 是既有契约，`tools.ts:716` 也兜着）
 *   ② **strict 钩子判定缺失时要提醒复核**——旧实现「找不到该钩子的行即按通过」，
 *      模型答歪/超时/返回空都等于「没风险」，对安全钩子方向是反的
 *   ③ 判定缺失的默认策略是「通过」，不能反过来把格式钩子也变严
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BUILTIN_HOOKS } from "../src/agent/config.js"

const SRC = (p: string): string => readFileSync(join(process.cwd(), p), "utf8")

test("内置安全钩子开了 strict，格式/路径钩子没开", () => {
  const safety = BUILTIN_HOOKS.find((h) => h.id === "builtin-safety")
  assert.ok(safety, "没有内置安全钩子")
  assert.equal(safety!.strict, true, "安全钩子该开 strict——判不出 ≠ 没风险")
  for (const h of BUILTIN_HOOKS.filter((x) => x.id !== "builtin-safety")) {
    assert.notEqual(h.strict, true, `${h.name} 不该默认 strict——那会把正常干活也打断`)
  }
})

test("静态：strict 缺失时提醒复核，且**不阻断主流程**", () => {
  const src = SRC("src/agent/hooks.ts")
  // 判定缺失 → strict 才提醒
  assert.match(src, /else if \(!v && h\.strict\)/)
  assert.match(src, /本次未能完成检查（判定缺失或超时），请自行复核后再继续/)
  // 后端抛异常 → 全判不出，继续往下走而不是上抛
  assert.match(src, /verdicts = \[\] \/\/ 后端炸了/)
  // 没有启用钩子 / 输出不是非空字符串 → 原样返回
  assert.match(src, /if \(!hooks\.length \|\| typeof output !== "string" \|\| !output\.trim\(\)\) return output/)
})

test("静态：渲染只在这里做，后端不碰修正提示（动作与判定分离）", () => {
  const hooks = SRC("src/agent/hooks.ts")
  const judge = SRC("src/agent/hookJudge.ts")
  assert.match(hooks, /【钩子检查未通过】/)
  assert.match(hooks, /请立即修正后续行为/)
  assert.equal(/【钩子检查未通过】/.test(judge), false, "后端在渲染修正提示——该留在 hooks.ts")
})

test("静态：后端按钩子配置挑选，认不出的回落 llm 并告警", () => {
  const judge = SRC("src/agent/hookJudge.ts")
  assert.match(judge, /const backend = loadConfig\(\)\.hookBackend\?\.\[hookId\]/)
  assert.match(judge, /if \(backend && backend !== "llm"\)/)
  assert.match(judge, /已回落 llm；可用值：llm \/ replay/)
  // 配置字段存在且默认不影响现行为
  assert.match(SRC("src/agent/config.ts"), /hookBackend\?: Record<string, string>/)
})

test("静态：replay 文件路径是模块常量，不占配置面", () => {
  const judge = SRC("src/agent/hookJudge.ts")
  assert.match(judge, /export const DEFAULT_REPLAY_FILE = join\(homedir\(\), "\.yyagent", "hook-samples\.jsonl"\)/)
  // 不该为它加顶层配置项——内部产物不该占配置面
  assert.equal(/hookReplayFile/.test(SRC("src/agent/config.ts")), false, "又给 replay 文件开了配置项")
})
