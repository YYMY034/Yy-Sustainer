/**
 * T116 回归：会话检索 LRU 缓存。
 *   ① conversation_search 每次全量读盘 → mtime 失效的 LRU 缓存（20 条 / 单文件 2MB 上限）
 *   ② 三个调用点（搜索扫描 / 单会话读取）全部走缓存
 * 反向断言：readSession 本体的白名单校验与解析保护原样保留（缓存只是它外面的壳）。
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const p = strip(readFileSync(join(root, "src/agent/pastchats.ts"), "utf8"))

let pass = 0
let fail = 0
const check = (label, ok, extra = "") => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

check("LRU 缓存存在：20 条上限 + 2MB 单文件门槛", p.includes("const SESS_CACHE_MAX = 20") && p.includes("const SESS_CACHE_MAX_BYTES = 2 * 1024 * 1024"))
check("失效靠 mtime（persist 原子写后必变）", p.includes("hit.mtimeMs === st.mtimeMs"))
check("缓存命中走 LRU 触碰（delete + set 重插）", /sessCache\.delete\(id\)\s*\n\s*sessCache\.set\(id, hit\)/.test(p))
check("文件消失时缓存作废（catch 分支 delete）", /catch \{[\s\S]{0,120}sessCache\.delete\(id\)[\s\S]{0,60}return null/.test(p))
check("搜索扫描走缓存", p.includes("const sess = readSessionCached(m.id)"))
check("单会话读取走缓存", p.includes("const sess = readSessionCached(sessionId)"))
check("反向：readSession 本体的白名单校验原样保留", /if \(!\/\^\[A-Za-z0-9_-]\{4,64\}\$\/\.test\(id\)\) return null/.test(p))
check("反向：Array.isArray 结构保护原样保留", p.includes("Array.isArray(f.messages)"))

// spawn 硬化（eval-nightly 首跑炸网关的教训）：长驻进程里每个 spawn 都必须有 error 监听者
const gwRaw = readFileSync(join(root, "src/gateway.ts"), "utf8")
const toolsRaw = readFileSync(join(root, "src/agent/tools.ts"), "utf8")
const mainRaw = readFileSync(join(root, "src/main.ts"), "utf8")
check("后台任务 spawn 的 error 走终态收尾（不炸网关）", toolsRaw.includes('child.on("error"') && toolsRaw.includes("finalize(null)"))
check("网关 toast 用绝对路径 powershell 且异步 error 有监听者", /spawn\(resolvePowerShell\(\)[\s\S]{0,300}\.on\("error"/.test(gwRaw))
check("守护进程通知同样绝对路径 + error 监听者", /spawn\(resolvePowerShell\(\)[\s\S]{0,300}\.on\("error"/.test(mainRaw))
check("四个 powershell spawn 全部走 resolvePowerShell（无 PATH 依赖）", (toolsRaw + gwRaw + mainRaw).includes("resolvePowerShell()") && !/spawn\("powershell\.exe"/.test(toolsRaw + gwRaw + mainRaw))

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
