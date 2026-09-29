/**
 * T101 回归：原生思考（reasoning 流）。
 * 静态断言（动态行为见 probe-step-progress 的 reasoning 断言）：
 *   ① loop 捕获 reasoning-delta/reasoning，状态化包 <thinking> 标签
 *   ② AgentResult.reasoningText 回传，网关只在用 r.text 时前置（streamedText 兜底不重复）
 *   ③ TUI 渲染剥标签（Web 走 T63 折叠，无需改）
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const loop = strip(readFileSync(join(root, "src/agent/loop.ts"), "utf8"))
const gw = strip(readFileSync(join(root, "src/gateway.ts"), "utf8"))
const tui = strip(readFileSync(join(root, "src/tui/App.tsx"), "utf8"))

let pass = 0
let fail = 0
const check = (label, ok, extra = "") => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

check("loop 捕获 reasoning-delta（v5 流类型）", loop.includes('chunk.type === "reasoning-delta"'))
check("进入思考发开标签、离开补闭合（状态化）", loop.includes('handlers.onText?.("<thinking>\\n")') && loop.includes('handlers.onText?.("\\n</thinking>\\n")'))
check("流在思考中被打断也闭合（for 循环外兜底）", /if \(inReason\) \{[\s\S]{0,200}handlers\.onText\?\.\("\\n<\/thinking>\\n"\)[\s\S]{0,80}\}\s*\n\s*\} catch/.test(loop))
check("reasoningText 随 AgentResult 回传", loop.includes("reasoningText?: string") && loop.includes("...(reasoningText ? { reasoningText } : {})"))

check("网关只在用 r.text 时前置 thinking（防 streamedText 路径重复）", gw.includes("const head = rawText && r?.reasoningText ? `<thinking>${r.reasoningText}</thinking>\\n\\n` : \"\""))
check("网关前置发生在 stopOrTimeoutContent（成功/停止/超时共用）", /stopOrTimeoutContent = \(\): string => \{[\s\S]{0,400}r\?\.reasoningText/.test(gw))

check("TUI 渲染剥 thinking 标签", tui.includes("stripThinking") && tui.includes("m.role === \"assistant\" ? stripThinking(m.content) : m.content"))
check("剥未闭合的半截 thinking（历史遗留）", /<thinking>\[\\s\\S\]\*\$\/g/.test(tui))

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
