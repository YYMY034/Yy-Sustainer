/**
 * T127 回归：备份产品化（bundle 随行）+ 通知 onlyFailure UI。
 *   ① 数据 zip 之外打仓库 bundle（失败不拖累数据备份；打包态无 .git 静默跳过）
 *   ② 滚动保留共用 keep 池（listBackups 同时认 zip 与 bundle）
 *   ③ /api/notify 接受 onlyFailure；设置页 seg 开关 + 回显
 * 行为级验证：活体跑 /api/backup/run 已确认 bundle 落盘（白皮书十九）。
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const read = (p) => strip(readFileSync(join(root, p), "utf8"))
const backup = read("src/agent/backup.ts")
const gw = read("src/gateway.ts")
const web = read("web/index.html")
const cfg = read("src/agent/config.ts")

let pass = 0
let fail = 0
const check = (label, ok, extra = "") => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

check("createRepoBundle 存在且开发态判定（.git 才做）", backup.includes("function createRepoBundle") && backup.includes('join(appRoot(), ".git")'))
check("bundle 记录全部 refs（--all）", backup.includes('"bundle", "create", out, "--all"'))
check("bundle 失败不拖累数据备份（finish 收尾与成败解耦）", backup.includes(".then(finish,") && backup.includes("bundle 跳过"))
check("listBackups 同时认 zip 与 bundle（共用 keep 池）", backup.includes('f.startsWith("backup-") && f.endsWith(".zip")') && backup.includes('f.startsWith("repo-bundle-") && f.endsWith(".bundle")'))
check("反向：打包态无 .git 时静默跳过（resolve 非 reject）", /if \(!existsSync\(gitDir\)\) return resolve\(\)/.test(backup))

check("notify 配置含 onlyFailure（T125）", cfg.includes("onlyFailure?: boolean"))
check("/api/notify 接受并保留 onlyFailure", gw.includes("onlyFailure: typeof body.onlyFailure === \"boolean\" ? body.onlyFailure : (cfg.notify?.onlyFailure ?? false)"))
check("notifyDone 尊重 onlyFailure（成功静默）", gw.includes("if (n?.onlyFailure && !failure) return"))
check("设置页 segOnlyFail 开关存在", web.includes('id="segOnlyFail"'))
check("设置页 segOnlyFail 回显（active 随配置）", web.includes('(d.notify?.onlyFailure === true)'))
check("设置页 segOnlyFail 点击即存", web.includes("onlyFailure })"))

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
