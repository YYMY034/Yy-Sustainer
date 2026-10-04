/**
 * T115 回归：内部调用推理档位（reasoning_effort=low）。
 *   ① 共享助手存在且语义正确（key 与 provider name 对齐）
 *   ② 四个内部调用点全部接线（压缩 / 钩子判定 / 识图 / compactBase agent 调用）
 *   反向断言：主对话路径（runAgentStream/runAgent 的非 compactBase 分支）不得设置推理档位
 *   ——主对话的深度思考是质量来源，不能被「省成本」顺手关掉。
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const read = (p) => strip(readFileSync(join(root, p), "utf8"))
const cfg = read("src/agent/config.ts")
const loop = read("src/agent/loop.ts")
const judge = read("src/agent/hookJudge.ts")
const vision = read("src/agent/vision.ts")

let pass = 0
let fail = 0
const check = (label, ok, extra = "") => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

check("共享助手存在且 reasoningEffort=low", cfg.includes("export function internalProviderOptions(providerName: string): Record<string, { reasoningEffort: string }>") && cfg.includes('reasoningEffort: "low"'))
check("压缩调用接线", /generateText\(\{[\s\S]{0,300}providerOptions: internalProviderOptions\(providerName\)/.test(loop) || loop.includes("providerOptions: internalProviderOptions(providerName),"))
check("钩子判定接线", judge.includes("providerOptions: internalProviderOptions(providerName)"))
check("识图转述接线", vision.includes("providerOptions: internalProviderOptions(providerName)"))
check("compactBase agent 调用接线（拆分器等）", loop.includes("? { providerOptions: internalProviderOptions(providerName) }"))
check("主对话可选档位（T128：ui.reasoningEffort 优先，顶层兜底）", loop.includes("config.ui?.reasoningEffort || config.reasoningEffort"))
check("收敛续跑段与主轮同源（providerOptions 随 prep 传递）", loop.includes("...(prep.providerOptions ? { providerOptions: prep.providerOptions } : {})"))
check("providerOptions 字面量出现次数（压缩 + 接口 + 收敛两处 + 主对话两分支 + 钩子无关）", (loop.match(/providerOptions/g) || []).length === 7)

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
