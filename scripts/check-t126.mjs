/**
 * T126 回归：系统性排查批的修复。
 *   ① 任务名字符集校验（gateway create/update + main.ts 防御；允许内部空格，首字符非空格）
 *   ② 任务 cwd 存在性校验（create/update 都拦，坏 cwd 不再等到 spawn 才报误导性 ENOENT）
 *   ③ 网关与守护进程的全局异常兜底（uncaughtException/unhandledRejection 记日志不退出）
 *   ④ 动态验证在 scripts/probe-input-paths.ts（12 项活体）
 * 反向断言：合法名（中文/_/含空格）不被误伤；穿越形状必须被拒。
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const read = (p) => readFileSync(join(root, p), "utf8")
const gwRaw = read("src/gateway.ts")
const gw = strip(gwRaw)
const main = read("src/main.ts")
const mem = strip(read("src/agent/memory.ts"))

let pass = 0
let fail = 0
const check = (label, ok, extra = "") => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

check("create 任务名字符集校验（首字符非空格）", gw.includes('if (!/^[\\w\\u4e00-\\u9fff-][\\w\\u4e00-\\u9fff -]{0,63}$/.test(name))'))
check("create 校验 cwd 存在性（fs.existsSync）", gw.includes("if (t.cwd && !fs.existsSync(t.cwd))"))
check("update 校验 cwd 存在性", gw.includes("!fs.existsSync(cwdCandidate)"))
check("main.ts runOnce 任务名防御（tasks.json 可手编）", main.includes("任务名含非法字符，拒绝执行"))
check("反向：正则允许内部空格（合法名不误伤）", gw.includes("[\\w\\u4e00-\\u9fff -]{0,63}"))

check("网关全局兜底：uncaughtException", gw.includes('process.on("uncaughtException"'))
check("网关全局兜底：unhandledRejection", gw.includes('process.on("unhandledRejection"'))
check("兜底限流（1 秒内不刷屏）", gw.includes("lastFatalLog"))
check("守护进程同样兜底", main.includes('process.on("uncaughtException"'))

check("memory safeTopic 守卫原样（穿越拒绝）", mem.includes("if (!s || !/^[a-z0-9\\u4e00-\\u9fff_-]+$/.test(s)) return null"))
check("动态验证探针存在", existsSync(join(root, "scripts/probe-input-paths.ts")))

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
