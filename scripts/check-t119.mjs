/**
 * T119–T122 回归：场景补齐批。
 *   T119 全局并发闸（RunGate 纯逻辑单测在 tests/runGate.test.ts，这里钉接线）
 *   T120 通知测试；T121 会话导出；T122 记忆统计
 * 反向断言：主对话与内部调用的推理档位互不干扰（check-t115 已钉）；并发闸 0 = 不限。
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const read = (p) => strip(readFileSync(join(root, p), "utf8"))
const gw = read("src/gateway.ts")
const cfg = read("src/agent/config.ts")
const diag = read("src/gateway/diagnostics.ts")
const web = read("web/index.html")

let pass = 0
let fail = 0
const check = (label, ok, extra = "") => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

// T119
check("RunGate 模块存在且 acquirer 无双计数（await 后不再 active++）", existsSync(join(root, "src/util/runGate.ts")) && !/await new Promise[\s\S]{0,200}\}\)\n\s*this\.active\+\+/.test(read("src/util/runGate.ts")))
check("网关建闸且上限可配（maxConcurrentRuns，默认 2）", gw.includes("const runGate = new RunGate(2)") && gw.includes("loadConfig().maxConcurrentRuns ?? 2"))
check("config 有 maxConcurrentRuns 字段", cfg.includes("maxConcurrentRuns?: number"))
check("runTurn 接闸（sessionBusy 之后）", gw.indexOf("await acquireRunSlot(sessionId)") > gw.indexOf('sessionBusy.add(sessionId)'))
check("runTurn finally 释放", /sessionBusy\.delete\(sessionId\)[\s\S]{0,120}releaseRunSlot\(\)/.test(gw))
check("定时任务同闸（acquire + finally 释放）", /await acquireRunSlot\(""\)/.test(gw) && /taskRunning\.delete\(t\.name\)[\s\S]{0,120}releaseRunSlot\(\)/.test(gw))
check("等位时明说排队（notice）", gw.includes("全局并发已满"))

// T120
check("通知测试路由存在", gw.includes('p === "/api/notify/test"'))
check("测试路由返回各链路结果（toast + webhook）", gw.includes("webhook = r.ok ? \"ok\"") && gw.includes("toast: true"))
check("设置页有测试按钮（先保存再测）", web.includes('id="notifyTest"') && web.includes('$("notifyTest").onclick') && web.indexOf('"/api/notify", { method: "POST"') < web.indexOf('"/api/notify/test"'))

// T121
check("会话导出路由（mt 正则形状，probe-routes 可识别）", /let mt = p\.match\(\^\\\/api\\\/sessions\\\/\(\[\\w-\]\+\)\\\/export\$\//.test(gw) || gw.includes("p.match(/^\\/api\\/sessions\\/([\\w-]+)\\/export$/)"))
check("导出剥思考块（stripThinkingForModel）", gw.includes("stripThinkingForModel(m2.content)"))
check("导出附步骤数", gw.includes("经 ${m2.steps.length} 步工具调用"))
check("顶栏导出按钮 + 处理器", web.includes('id="exportBtn"') && web.includes('$("exportBtn").onclick') && web.includes("/api/sessions/${activeId}/export"))

// T122
check("诊断含记忆统计（user + projects 两层）", diag.includes("memoryLayer") && diag.includes("memory.projects"))
check("健康卡展示记忆行", web.includes('id="memorySummary"') && web.includes("window.__lastDiag?.memory"))

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
