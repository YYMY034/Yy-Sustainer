/**
 * T103 回归：长驻进程的两组并发 bug 修复。
 *   ① 守护进程（main.ts）与网关并存时定时任务双跑 → 守护进程每刻钟探测网关、活着就退让
 *   ② 长驻进程（main.ts / gateway）任务收尾全关 MCP → 删除；一次性进程（cli.ts）的关闭必须保留
 * 反向断言：cli.ts 的 closeMcpTools 不得被顺手删掉（坑 #6 的原始场景）。
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const main = strip(readFileSync(join(root, "src/main.ts"), "utf8"))
const gw = strip(readFileSync(join(root, "src/gateway.ts"), "utf8"))
const cli = strip(readFileSync(join(root, "src/cli.ts"), "utf8"))

let pass = 0
let fail = 0
const check = (label, ok, extra = "") => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

check("main 有 gatewayActive 探测（读 YYAGENT_GATEWAY_PORT，默认 8642）", main.includes("async function gatewayActive()") && main.includes('process.env.YYAGENT_GATEWAY_PORT ?? "8642"'))
check("cron 回调每刻钟现探网关（不是只在启动时判一次）", /cron\.schedule\(t\.cron, async \(\) => \{\s*if \(await gatewayActive\(\)\) return/.test(main))
check("启动时打印退让提示", main.includes("防双跑"))
check("main 任务收尾不再全关 MCP", !/finally \{[\s\S]{0,200}closeMcpTools/.test(main))
check("gateway 定时任务收尾不再全关 MCP（防杀掉交互回合正在用的连接）", !/taskRunning\.delete\(t\.name\)[\s\S]{0,300}closeMcpTools/.test(gw))
check("反向：cli.ts 一次性进程的 closeMcpTools 必须保留（坑 #6 原始场景）", cli.includes("closeMcpTools()"))
check("反向：closeMcpTools 本体仍在 mcp/client.ts 导出", readFileSync(join(root, "src/mcp/client.ts"), "utf8").includes("export async function closeMcpTools"))

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
