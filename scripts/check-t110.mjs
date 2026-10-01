/**
 * T109–T114 回归：工程底座批次。
 *   T109 CI workflow；T110 诊断导出（新模块 + 路由 + 前端按钮 + 红线）；T111 会话归档
 *   （行为级断言在 tests/store.test.ts）+ 前端渲染上限；T112 发布脚本；T113 社区文件；
 *   T114 任务登记表。
 * 反向断言：诊断输出里绝不允许出现密钥/token 字段名；渲染上限不得对短会话生效。
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const read = (p) => readFileSync(join(root, p), "utf8")
const web = strip(read("web/index.html"))
const gw = strip(read("src/gateway.ts"))
const diag = strip(read("src/gateway/diagnostics.ts"))
const store = strip(read("src/session/store.ts"))
const cfg = strip(read("src/agent/config.ts"))

let pass = 0
let fail = 0
const check = (label, ok, extra = "") => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

// T109
check("CI workflow 存在且跑 tsc + npm test", existsSync(join(root, ".github/workflows/ci.yml")) && read(".github/workflows/ci.yml").includes("npm test") && read(".github/workflows/ci.yml").includes("tsc --noEmit"))

// T110
check("诊断是独立模块（gateway 拆分第一块）", existsSync(join(root, "src/gateway/diagnostics.ts")))
check("诊断路由接上且传 logsDir", gw.includes('p === "/api/diagnostics"') && gw.includes("buildDiagnostics({ logsDir: LOGS_DIR })"))
check("诊断红线：secrets 字段标注 redacted", diag.includes('secrets: "redacted"'))
check("诊断红线：反向——模块里不得出现 apiKey/authToken 的取值出口", !/apiKey[^\n]*:/.test(diag) && !diag.includes("authToken"))
check("设置页有诊断下载按钮与处理器", web.includes('id="diagBtn"') && web.includes('$("diagBtn").onclick'))

// T111
check("config 有 sessionArchiveDays 字段", cfg.includes("sessionArchiveDays?: number"))
check("store 有 archiveStaleSessions 且 days<=0 显式关闭", store.includes("export function archiveStaleSessions(days") && store.includes("if (!(days > 0)) return"))
check("网关启动时做归档清扫（repairIndex 之后）", gw.includes("archiveStaleSessions(days)") && gw.indexOf("archiveStaleSessions(days)") > gw.indexOf("repairIndex()"))
check("渲染上限：默认 200 条且保留原始下标", web.includes("const RENDER_CAP = 200") && web.includes("messages.slice(from).map((m, idx) => {") && web.includes("const i = from + idx"))
check("渲染上限反向：短会话从 0 起画（上限不对短会话生效）", web.includes("messages.length <= RENDER_CAP ? 0 :"))
check("「显示全部」逃生门接上", web.includes('[data-op="showAllMsgs"]') && web.includes("window.__showAllMsgs = true"))

// T112
check("发布脚本存在且有干净树检查 + 版本格式校验", existsSync(join(root, "scripts/release.mjs")) && read("scripts/release.mjs").includes("git status --porcelain") && read("scripts/release.mjs").includes("\\d+\\.\\d+\\.\\d+"))
check("发布脚本固定用 release-new 输出目录（绕开被锁的 release/）", read("scripts/release.mjs").includes("release-new"))

// T113 + T114
check("CONTRIBUTING 存在且提到 test:all 纪律", existsSync(join(root, "CONTRIBUTING.md")) && read("CONTRIBUTING.md").includes("test:all"))
check("issue 模板存在（bug + feature）", existsSync(join(root, ".github/ISSUE_TEMPLATE/bug_report.yml")) && existsSync(join(root, ".github/ISSUE_TEMPLATE/feature_request.yml")))
check("用户手册存在", existsSync(join(root, "docs/USER-GUIDE.md")))
check("任务登记表存在且包含本批编号", existsSync(join(root, "docs/TASKS.md")) && read("docs/TASKS.md").includes("| T114 |"))

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
