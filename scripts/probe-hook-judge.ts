/**
 * T93 L1 活体探针（不随 run-all-checks 跑）：
 *
 *   npx tsx scripts/probe-hook-judge.ts
 *
 * 验证「换判定后端」这件事真的接上了，而且**框架本身能闭环**：
 *   ① replay 后端：录下的 FAIL 判定真的会追加修正提示，PASS 不会
 *   ② **故意录错**（把 FAIL 录成 PASS）：修正提示必须消失——证明框架真的在读判定，
 *      而不是无论后端返回什么都走同一条路
 *   ③ 后端返回空（判不出）：strict 的安全钩子要提醒复核，非 strict 的格式钩子不打扰
 *   ④ 后端整个炸掉：原样返回输出，一个字节都不改（fail-open）
 *
 * ③④ 是反向断言——只测「判 FAIL 会追加」的话，一个永远追加或永远不追加的实现都能全绿。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HookSample } from "../src/agent/hookJudge.js"

// **必须先设 HOME 再动态 import**——被测模块在加载时就用 homedir() 定了配置路径和
// replay 文件路径。静态 import 会被提升到前面，那样读到的会是真实 home
// （第一版就这么错的：配置没生效、样本写去了真家目录）。
const HOME = mkdtempSync(join(tmpdir(), "yy-hjp-"))
process.env.HOME = HOME
process.env.USERPROFILE = HOME

const { resetHookJudges, runHooksOnTool } = await import("../src/agent/hooks.js")
const { DEFAULT_REPLAY_FILE } = await import("../src/agent/hookJudge.js")

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

const TOOL = "bash"
const OUTPUT = "正在执行 rm -rf ./build\n已删除 128 个文件"
/** 与现网内置钩子一致的判据（replay 靠 tool+sample+判据 的指纹对齐） */
const SAFETY = { id: "builtin-safety", name: "安全钩子", enabled: true, strict: true, prompt: "检查本次工具执行/输出是否存在安全风险：删除或覆盖重要文件（rm、del、强制覆盖）、泄露密钥或隐私（打印 API Key、密码、token）、对外发送敏感数据、其他破坏性操作。存在风险回复「FAIL：原因（简短）」；否则只回复 PASS。" }
const FMT = { id: "builtin-format", name: "输出格式钩子", enabled: true, prompt: "检查本次输出是否符合要求：使用中文、结构清晰（必要时分点）、关键结论明确、无未解释的报错堆栈、无占位内容。不符合回复「FAIL：原因（简短）」；否则只回复 PASS。" }

function writeCfg(hookBackend?: Record<string, string>): void {
  mkdirSync(join(HOME, ".yyagent"), { recursive: true })
  writeFileSync(join(HOME, ".yyagent", "config.json"), JSON.stringify({
    providers: {},
    model: "x/y",
    hooks: [SAFETY, FMT],
    ...(hookBackend ? { hookBackend } : {}),
  }, null, 2))
  resetHookJudges()
}

/** 写一条 replay 样本。指纹由 tool + sample + 各钩子判据 决定，sample 必须是 runHooksOnTool 切完的那个 */
function writeSample(verdicts: HookSample["verdicts"]): void {
  // hooks.ts 里 SAMPLE_CHARS=2000，本例输出远短于它，sample 就是原文
  const s: HookSample = { ts: Date.now(), tool: TOOL, sample: OUTPUT, hooks: [SAFETY, FMT], verdicts }
  writeFileSync(DEFAULT_REPLAY_FILE, JSON.stringify(s) + "\n")
  // ReplayHookJudge 会缓存载入的样本（长任务里没必要每步重读文件）——
  // 探针每个场景换一次文件，必须让缓存失效，否则读到的是上一个场景的判定
  resetHookJudges()
}

try {
  mkdirSync(join(HOME, ".yyagent"), { recursive: true })

  // ============ ① 录下 FAIL → 追加修正提示 ============
  writeCfg({ "builtin-safety": "replay", "builtin-format": "replay" })
  writeSample([
    { hookId: "builtin-safety", pass: false, reason: "rm -rf 删除大量文件，属破坏性操作" },
    { hookId: "builtin-format", pass: true },
  ])
  let out = await runHooksOnTool(TOOL, OUTPUT)
  check("replay 判 FAIL → 追加修正提示", out !== OUTPUT && out.includes("【钩子检查未通过】"), out.slice(-160))
  check("提示带上钩子名与原因", out.includes("安全钩子") && out.includes("rm -rf 删除大量文件"), out.slice(-200))
  check("提示带「请立即修正后续行为」", out.includes("请立即修正后续行为"))
  check("原文在前（模型照样看得到工具输出）", out.startsWith(OUTPUT))

  // ============ ② 故意录错 → 提示必须消失 ============
  writeSample([
    { hookId: "builtin-safety", pass: true }, // ← 把 FAIL 录成 PASS
    { hookId: "builtin-format", pass: true },
  ])
  out = await runHooksOnTool(TOOL, OUTPUT)
  check("**录成 PASS 时一个字节都不加**（证明框架真在读判定）", out === OUTPUT, JSON.stringify(out))

  // ============ ③ 判不出 → strict 与非 strict 分流 ============
  writeSample([]) // 空 verdicts = 后端一条都判不出
  out = await runHooksOnTool(TOOL, OUTPUT)
  check("strict 的安全钩子：判不出要提醒自行复核", out !== OUTPUT && out.includes("本次未能完成检查"), out.slice(-160))
  check("非 strict 的格式钩子：判不出不打扰", !out.includes("输出格式钩子"), out.slice(-200))
  check("提醒也不是阻断——原文仍在", out.startsWith(OUTPUT))

  // ============ ④ 后端整个炸掉 → 原样返回 ============
  writeCfg({ "builtin-safety": "replay", "builtin-format": "replay" })
  // 把 replay 文件写成目录，让读取直接抛错
  rmSync(DEFAULT_REPLAY_FILE, { force: true, recursive: true })
  mkdirSync(DEFAULT_REPLAY_FILE, { recursive: true })
  resetHookJudges()
  out = await runHooksOnTool(TOOL, OUTPUT)
  // fail-open 的准确含义是「**不阻断主流程**」，不是「一个字都不加」：
  // 读不了样本 → 判不出 → strict 的安全钩子照样提醒复核（它本来就看不了，更该提醒）
  check("后端读不了 → 不抛异常、原文仍在", out.startsWith(OUTPUT), JSON.stringify(out).slice(0, 120))
  check("且 strict 钩子仍提醒复核（判不出 ≠ 没风险）", out.includes("本次未能完成检查"), out.slice(-120))

  // ============ ⑤ 没配后端 → 走 llm（无可用模型时也 fail-open） ============
  writeCfg() // 不配 hookBackend
  out = await runHooksOnTool(TOOL, OUTPUT)
  check("默认 llm 且无可用模型 → 不炸、原文仍在", out.startsWith(OUTPUT), JSON.stringify(out).slice(0, 120))
  check("没配后端时走 llm（行为与改动前一致）", out.includes("本次未能完成检查"), out.slice(-120))
} catch (e) {
  fail++
  console.log(`FAIL 运行出错 — ${(e as Error).message}`)
} finally {
  try { rmSync(DEFAULT_REPLAY_FILE, { force: true, recursive: true }) } catch { /* 临时 */ }
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
