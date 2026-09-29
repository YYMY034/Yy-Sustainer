/**
 * T99 回归：后台任务面板。
 * 静态断言（动态行为见 probe-bg-exit 的 /api/bg 断言）：
 *   ① 引擎导出合并快照与日志尾（id 校验在引擎侧，不拿请求参数拼路径）
 *   ② 网关两条路由（8.2 已同步）
 *   ③ 自动化页有面板容器 + 刷新/渲染/看日志展开三件套
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

check("引擎导出 listBgSnapshot（内存 ∪ 磁盘）", tools.includes("export function listBgSnapshot()"))
check("快照标注「状态未知」语义（done=undefined 不冒充终态）", tools.includes("done: r.endedAt !== undefined ? true : undefined"))
check("引擎导出 bgLogTailById 且先对记录再读文件", /export function bgLogTailById[\s\S]{0,400}getBgTask\(id\)[\s\S]{0,200}existsSync\(logFile\)/.test(tools))

check("网关 GET /api/bg 路由", gw.includes('p === "/api/bg"'))
check("网关 GET /api/bg/log 路由且 404 分支在", gw.includes('p === "/api/bg/log"') && gw.includes("未找到该任务的日志"))
check("网关从引擎导入两个新导出", gw.includes("listBgSnapshot") && gw.includes("bgLogTailById"))

check("自动化页有后台任务容器", web.includes('id="bgList"'))
check("有刷新函数且挂在 refreshState（仅页面可见时）", web.includes("async function refreshBgPanel()") && web.includes('if ($("autoPage")?.classList.contains("show")) refreshBgPanel()'))
check("bg-exit 事件联动刷新面板", /m\.type === "bg-exit"[\s\S]{0,300}refreshBgPanel\(\)/.test(web))
check("「看日志」展开走 data-bglog 且不重复插入", web.includes("data-bglog") && web.includes('row.querySelector(".bg-tail")'))

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
