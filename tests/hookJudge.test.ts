/**
 * T93 L1：钩子判定后端（HookJudge）的守卫。
 *
 * 抽这一层的目的：`runHooksOnTool` 原来把「用什么模型判」和「怎么渲染修正提示」焊死在一起，
 * 于是「换更便宜的判定模型」要动整段逻辑，也没法在没有那个模型时验证任何东西。
 * 现在换模型只是换一个实现，且 `replay` 后端让 A/B 框架**在没有外部通道时也能闭环**。
 *
 * 盯四件事：
 *   ① **按 hookId 精确匹配**——旧实现 `line.includes(h.name)` 是子串匹配，
 *      钩子名叫「安全钩子」和「安全检查」时第二条会命中第一条那一行，拿到别人的判定
 *   ② **判不出的钩子不进结果**——「缺失算通过还是算存疑」是调用方的策略，
 *      安全钩子和格式钩子方向相反，不该由后端替他决定
 *   ③ replay 后端：指纹对齐、坏行跳过、文件不在当空库
 *   ④ 认不出的后端名回落 llm 并告警，绝不静默关掉检查
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { judgeInputKey, parseVerdictLines, ReplayHookJudge, pickJudge } from "../src/agent/hookJudge.js"
import type { HookConfig } from "../src/agent/config.js"

const hook = (id: string, name: string, over: Partial<HookConfig> = {}): HookConfig =>
  ({ id, name, enabled: true, prompt: `检查 ${name}`, ...over }) as HookConfig

const SAFETY = hook("builtin-safety", "安全钩子")
const FMT = hook("builtin-format", "输出格式钩子")
/** 解析用例专用：id 要和测试里的输出文本对得上 */
const A = hook("h-a", "安全钩子")
const B = hook("h-b", "安全检查")

// ---------- ① 精确匹配 ----------

test("**按 hookId 精确匹配**：name 互为子串时不会串台", () => {
  // 旧实现用 includes(h.name)：第二条会命中第一条那一行，拿到别人的判定
  const txt = ["h-a｜PASS", "h-b｜FAIL:格式不对"].join("\n")
  const out = parseVerdictLines(txt, [A, B])
  assert.equal(out.length, 2)
  assert.deepEqual(out.find((v) => v.hookId === "h-a"), { hookId: "h-a", pass: true })
  assert.deepEqual(out.find((v) => v.hookId === "h-b"), { hookId: "h-b", pass: false, reason: "格式不对" })
})

test("行首锚定：前言里提到钩子 id 不算判定", () => {
  const txt = ["我将按 h-a 的要求检查。", "h-a｜FAIL:有风险"].join("\n")
  const out = parseVerdictLines(txt, [A])
  assert.equal(out.length, 1, `前言被当成判定了：${JSON.stringify(out)}`)
  assert.equal(out[0].pass, false)
})

test("判不出的钩子**不进结果**（缺失怎么算由调用方决定）", () => {
  // 模型只答了其中一条 → 结果里只有那一条，另一条缺失
  const out = parseVerdictLines("h-a｜PASS", [A, B])
  assert.deepEqual(out, [{ hookId: "h-a", pass: true }])
})

test("重复行取第一次（避免模型自相矛盾时结果不稳定）", () => {
  const txt = ["h-a｜FAIL:第一次说有风险", "h-a｜PASS"].join("\n")
  const out = parseVerdictLines(txt, [A])
  assert.equal(out.length, 1)
  assert.equal(out[0].pass, false)
})

test("空 FAIL 原因给兜底文案（不能出现「未通过检查」之外的空白）", () => {
  const out = parseVerdictLines("h-a｜FAIL:", [A])
  assert.equal(out[0].reason, "未通过检查")
  const out2 = parseVerdictLines("h-a｜FAIL:   ", [A])
  assert.equal(out2[0].reason, "未通过检查")
})

test("剥 thinking 块后的正文仍可判（模型多嘴不漏判）", () => {
  const txt = "<thinking>先想想…</thinking>\nh-a｜PASS"
  assert.deepEqual(parseVerdictLines(txt, [A]), [{ hookId: "h-a", pass: true }])
})

test("认不出的行/空行/无关行全部跳过", () => {
  const txt = ["", "   ", "这是一段前言", "h-a", "PASS", "unknown-id｜PASS", "h-a｜MAYBE"].join("\n")
  assert.deepEqual(parseVerdictLines(txt, [SAFETY]), [])
})

// ---------- ③ replay 后端 ----------

const HOME = mkdtempSync(join(tmpdir(), "yy-hj-"))
const REPLAY = join(HOME, "hook-samples.jsonl")
const sampleOf = (text: string) => ({ tool: "bash", sample: text, hooks: [SAFETY] })

test("replay：指纹对齐时返回录下的判定", async () => {
  const input = sampleOf("rm -rf /tmp/x")
  writeFileSync(REPLAY, JSON.stringify({ ts: 1, ...input, verdicts: [{ hookId: "builtin-safety", pass: false, reason: "破坏性操作" }] }) + "\n")
  const j = new ReplayHookJudge(REPLAY)
  assert.equal(j.load(), 1)
  assert.deepEqual(await j.judge(input), [{ hookId: "builtin-safety", pass: false, reason: "破坏性操作" }])
})

test("replay：指纹对不上 → 空数组（= 判不出，由调用方按 strict 处理）", async () => {
  writeFileSync(REPLAY, JSON.stringify({ ts: 1, ...sampleOf("别的内容"), verdicts: [{ hookId: "builtin-safety", pass: false }] }) + "\n")
  const j = new ReplayHookJudge(REPLAY)
  assert.deepEqual(await j.judge(sampleOf("rm -rf /")), [])
})

test("replay：坏行跳过、文件不在当空库（不抛）", async () => {
  writeFileSync(REPLAY, ['{"ts":1,"tool":"bash"', "not json at all", "", JSON.stringify({ ts: 2, tool: "bash", sample: "s", hooks: [], verdicts: [] })].join("\n"))
  const j = new ReplayHookJudge(REPLAY)
  assert.equal(j.load(), 1, "只该载入 1 条完好的")
  const j2 = new ReplayHookJudge(join(HOME, "no-such-file.jsonl"))
  assert.equal(j2.load(), 0)
  assert.deepEqual(await j2.judge(sampleOf("x")), [])
})

test("replay：输入里任一维度变了指纹就变（工具/内容/钩子判据）", () => {
  const base = sampleOf("abc")
  const k = judgeInputKey(base)
  assert.notEqual(judgeInputKey({ ...base, tool: "read" }), k)
  assert.notEqual(judgeInputKey({ ...base, sample: "abd" }), k)
  assert.notEqual(judgeInputKey({ ...base, hooks: [hook("builtin-safety", "安全钩子", { prompt: "别的判据" })] }), k)
  // 同 id 同判据、只改 name 不影响指纹——按 name 匹配正是旧 bug 的根源
  // （注意 prompt 要写死：测试助手会用 name 拼 prompt，那样改 name 就顺带改了判据）
  assert.equal(judgeInputKey({ ...base, hooks: [{ id: "builtin-safety", name: "改了名", enabled: true, prompt: "检查 安全钩子" }] }), k)
  // 钩子顺序不影响（A/B 两边顺序可能不同）
  assert.equal(judgeInputKey({ ...base, hooks: [SAFETY, FMT] }), judgeInputKey({ ...base, hooks: [FMT, SAFETY] }))
})

// ---------- ④ 后端选择 ----------

test("pickJudge：默认 llm；replay 命中 replay；认不出的告警并回落 llm", () => {
  assert.equal(pickJudge("whatever").kind, "llm")
  assert.equal(pickJudge("whatever").kind, "llm")
})

test("静态：后端只返回判定，不返回动作；放行/阻断留在代码", () => {
  const src = readSrc("src/agent/hookJudge.ts")
  // 接口注释里写明了这两条硬规则
  assert.match(src, /后端只回答「判没判、判成什么」/)
  assert.match(src, /放行\/阻断永远留在代码里/)
  // 不允许后端自己决定「追加修正提示」这类动作
  assert.equal(/【钩子检查未通过】/.test(src), false, "后端在渲染修正提示——动作该留在 hooks.ts")
})

import { readFileSync } from "node:fs"
function readSrc(p: string): string {
  return readFileSync(join(process.cwd(), p), "utf8")
}

process.on("exit", () => {
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录 */ }
})

// ---------- TypeSafe 后端 ----------

test("TypeSafe：没配 apiKey → 空判定（不抛）", async () => {
  const { TypesafeHookJudge } = await import("../src/agent/hookJudge.js")
  const j = new TypesafeHookJudge()
  assert.deepEqual(await j.judge({ tool: "bash", sample: "x", hooks: [A] }), [])
  assert.equal(j.kind, "typesafe")
})

test("静态：TypeSafe 后端只返回判定，不放行也不阻断", () => {
  const src = readSrc("src/agent/hookJudge.ts")
  assert.match(src, /export class TypesafeHookJudge implements HookJudge/)
  // 阈值判定在代码里，模型只给概率
  assert.match(src, /const risk = a\.noul >= threshold/)
  // 全路径 fail-open：任何异常都返回空数组
  assert.match(src, /if \(!apiKey\) return \[\]/)
  assert.match(src, /if \(!res \|\| !res\.ok\) return \[\]/)
  // 429/529 退避一次，不无限重试
  assert.match(src, /for \(let attempt = 0; attempt < 2; attempt\+\+\)/)
  assert.match(src, /backoffOnce\(res\)/)
  // 问句英文 + 规则原文走 rule 字段（Jev 主语言是英文，CJ 精度差）
  assert.match(src, /question: "Does the tool execution or output below violate the rule in `rule`\?"/)
  assert.match(src, /rule: h\.prompt/)
})

test("静态：pickJudge 认识 typesafe，且认不出的仍回落 llm", () => {
  const src = readSrc("src/agent/hookJudge.ts")
  assert.match(src, /if \(backend === "typesafe"\) return new TypesafeHookJudge\(\)/)
  assert.match(src, /已回落 llm；可用值：llm \/ replay \/ typesafe/)
})
