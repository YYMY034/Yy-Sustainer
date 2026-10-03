/**
 * T123–T125 回归：被动记忆 / 递归编排 / 通知开关。
 *   T123 memoryIndexSummary 接线（行为级单测在 tests/memoryIndex.test.ts）+ prepare 注入门控
 *   T124 递归 delegate（深度 2 层）+ sub-step path 事件 + Web 嵌套分道
 *   T125 notify.onlyFailure（成功静默、失败必推）
 * 反向断言：compactBase 内部调用不注入记忆索引；超过 2 层的委派被入口拦截。
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const read = (p) => strip(readFileSync(join(root, p), "utf8"))
const mem = read("src/agent/memory.ts")
const loop = read("src/agent/loop.ts")
const tools = read("src/agent/tools.ts")
const gw = read("src/gateway.ts")
const web = read("web/index.html")
const cfg = read("src/agent/config.ts")

let pass = 0
let fail = 0
const check = (label, ok, extra = "") => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

// T123
check("memory.ts 导出 memoryIndexSummary 且封顶 1600", mem.includes("export function memoryIndexSummary(maxChars = 1600)") && mem.includes("看完整索引"))
check("prepare 注入门控：compactBase 与 disableInjection 都不注入", loop.includes("opts.compactBase || opts.disableInjection ? \"\" : memoryIndexSummary()"))
check("注入节带使用指引（memory_read 读全文，不许凭索引编造）", loop.includes("需要细节时用 memory_read 读全文，不要凭索引编造内容"))
check("反向：内部调用走精简路径（compactBase 分支存在）", loop.includes("opts.compactBase ? undefined : skillsPrompt()"))

// T124
check("ToolContext/AgentOptions 带委派路径", tools.includes("path?: string[]") && loop.includes("delegatePath?: string[]"))
check("递归深度闸：超过 2 层入口拦截", tools.includes("childPath.length > 2") && tools.includes("委派深度已达上限"))
check("子代理工具集允许再委派（递归成立）", tools.includes("makeTools({ allowDelegate: true })"))
check("delegate 透传 delegatePath 给子代理", tools.includes("delegatePath: childPath"))
check("sub-step 事件带 path（gateway 转发 + 兜底）", gw.includes("path: info.path ?? [info.persona]"))
check("Web 分道按 path 组键", web.includes("m.path.join(\">\")"))

// T125
check("notify 配置含 onlyFailure 开关", cfg.includes("onlyFailure?: boolean"))
check("notifyDone 尊重开关：成功静默、failure 标记必推", gw.includes("if (n?.onlyFailure && !failure) return"))
check("失败调用点标记 failure=true（任务失败 + 回合出错）", (gw.match(/, true\)/g) || []).length >= 2)

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
