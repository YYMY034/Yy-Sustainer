/**
 * T100 回归：子代理分道。
 * 静态断言（动态行为见 probe-delegate-progress 的 sub-step 事件断言）：
 *   ① 类型链路：ToolContext.onSubStep → loop StreamHandlers.onSubStep → 网关广播 sub-step
 *   ② delegate 每步发结构化事件且不再只靠单行文本
 *   ③ 子代理过程摘要（工具×次数）追加进回显落库
 *   ④ web 分道渲染：容器/事件处理/清理三点
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const web = strip(readFileSync(join(root, "web/index.html"), "utf8"))
const gw = strip(readFileSync(join(root, "src/gateway.ts"), "utf8"))
const tools = strip(readFileSync(join(root, "src/agent/tools.ts"), "utf8"))
const loop = strip(readFileSync(join(root, "src/agent/loop.ts"), "utf8"))

let pass = 0
let fail = 0
const check = (label, ok, extra = "") => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

check("ToolContext 有 onSubStep（T124 起 path 进事件）", tools.includes("onSubStep?: (info: { persona: string; path: string[]; step: number; maxSteps: number; tools: string[] }) => void"))
check("loop StreamHandlers 有 onSubStep（T124 起 path 进事件）", loop.includes("onSubStep?: (info: { persona: string; path: string[]; step: number; maxSteps: number; tools: string[] }) => void"))
check("loop 两处 ctx 都接了 onSubStep", (loop.match(/onSubStep: \(info\) => handlers\.onSubStep\?\.\(info\)/g) || []).length === 1 && (loop.match(/onSubStep: \(info: \{ persona/g) || []).length === 1)
check("delegate 每步发结构化事件（path 随行）", tools.includes("store?.onSubStep?.({ persona, path: childPath, step: info.step, maxSteps: info.maxSteps, tools: info.tools })"))
check("状态行文本带委派链（T124：父 › 子）", tools.includes('childPath.join(" › ")'))
check("过程明细（T106 B 批：逐行 工具·参数→输出）落进回显", tools.includes("[子代理过程]") && tools.includes("r.toolDetail ?? []") && tools.includes("d.output ? ` → ${d.output}`"))

check("网关广播 sub-step 且带 persona", gw.includes('broadcast({ type: "sub-step", sessionId, persona: info.persona'))

check("web 有分道容器（streaming 模板内）", web.includes('<div id="subLanes"></div>'))
check("web 处理 sub-step 事件按 path 组键（T124 递归嵌套各行）", /m\.type === "sub-step"[\s\S]{0,400}subLanes\.set\(laneKey/.test(web))
check("回合结束与会话切换都清分道", web.includes("subLanes.clear()") && (web.match(/subLanes\.clear\(\)/g) || []).length === 2)
check("分道样式存在", web.includes(".sub-lane"))

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
