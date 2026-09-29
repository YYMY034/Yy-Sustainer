/**
 * T102 回归：bug 修复轮的四项修复都在位。
 *   ① toCoreMessages 剥 assistant 思考块（行为级断言在 tests/store.test.ts，这里钉住接线存在）
 *   ② bg_read(wait) 唤醒路径摘 abort 监听（回合级 signal 的监听器泄漏）
 *   ③ runConverge 支持思考流（主轮有、续跑没有 → reasoning 模型收敛段静默 + reasoningText 缺一截）
 *   ④ bg-exit 的面板刷新只在自动化页可见时发生
 * 反向断言：用户消息的思考标签不得被剥（那是贴的代码，剥了 = 篡改用户输入）。
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const store = strip(readFileSync(join(root, "src/session/store.ts"), "utf8"))
const tools = strip(readFileSync(join(root, "src/agent/tools.ts"), "utf8"))
const loop = strip(readFileSync(join(root, "src/agent/loop.ts"), "utf8"))
const web = strip(readFileSync(join(root, "web/index.html"), "utf8"))

let pass = 0
let fail = 0
const check = (label, ok, extra = "") => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

check("store 有 stripThinkingForModel 且 toCoreMessages 调用它", store.includes("export function stripThinkingForModel") && store.includes("m.role === \"assistant\" ? stripThinkingForModel(m.content).trim() : m.content"))
check("只对 assistant 剥（用户消息原样）", store.includes("m.role === \"assistant\" && !content"))
check("剥未闭合的半截思考", /<thinking>\[\\s\\S\]\*\$\/g/.test(store))

check("bg_read 唤醒路径摘 abort 监听", tools.includes("signal?.removeEventListener(\"abort\", onAbort)"))

check("runConverge 返回类型带 reasoningText", loop.includes("Promise<{ text: string; steps: number; reasoningText?: string }>")
  && loop.includes("return { text, steps, ...(reasoningText ? { reasoningText } : {}) }"))
check("收敛段思考流有处理分支", (loop.match(/chunk\.type === "reasoning-delta"/g) || []).length === 2)
check("主轮与收敛段 reasoning 落库时合并", loop.includes("[reasoningText, convReasoning].filter(Boolean).join(\"\\n\")"))

check("bg-exit 刷新面板有可见性门槛", web.includes('if ($("autoPage")?.classList.contains("show")) refreshBgPanel()'))

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
