/**
 * T98 回归：等待与节奏透明。
 * 静态断言三处接线（动态行为见 probe-bg-exit / probe-step-progress）：
 *   ① web 状态行计时器与回合 token 渲染（paintStreamStatus / statusSince / turnTok）
 *   ② 网关 onStep 广播带 turnIn/turnOut（真实累计，不是估算）
 *   ③ bg_read(wait) 等待期间经 statusSink 推「等待后台任务」状态
 * 断言前剥注释（纪律），选择器正则用 [ \t] 不用 \s。
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const web = strip(readFileSync(join(root, "web/index.html"), "utf8"))
const gw = strip(readFileSync(join(root, "src/gateway.ts"), "utf8"))
const tools = strip(readFileSync(join(root, "src/agent/tools.ts"), "utf8"))

let pass = 0
let fail = 0
const check = (label, ok, extra = "") => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

check("web 状态行有计时渲染函数", web.includes("function paintStreamStatus()"))
check("计时只在状态文本变化时重置（赋值前比较）", /if \(m\.text !== streamStatusText\) statusSince = Date\.now\(\)/.test(web) && web.indexOf("if (m.text !== streamStatusText) statusSince") < web.indexOf("streamStatusText = m.text"))
check("状态事件吃进回合 token 累计", web.includes("turnTok.in = m.turnIn"))
check("≥3s 才显示秒数（短状态不闪数字）", /if \(el >= 3\) t \+= ` · \$\{el\}s`/.test(web))
check("有 1s 心跳重绘且只在流式忙时", /setInterval\(\(\) => \{ if \(streamingOn && busy\(\)\) paintStreamStatus\(\) \}, 1000\)/.test(web))
check("新回合（busy=true）重置计时与 token", /if \(m\.busy\) \{ statusSince = Date\.now\(\); turnTok = \{ in: 0, out: 0 \} \}/.test(web))

check("网关 status 广播带 turnIn/turnOut", gw.includes("turnIn: turnTokens.in") && gw.includes("turnOut: turnTokens.out"))

check("bg_read(wait) 进入即推等待状态", tools.includes("等待后台任务 ${task_id} 结束…"))
check("等待中每 5s 推已等时长", tools.includes("已等 ${Math.round((Date.now() - w0) / 1000)}s"))
check("等待结束（含超时/中止）必清心跳定时器", /finally \{\s*clearInterval\(iv\)/.test(tools))

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
