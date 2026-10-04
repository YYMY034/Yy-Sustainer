// T83 数据资产自动备份：把 ~/.yyagent 的核心资产（会话/记忆/场景库/todo/配置/用量账本）
// 压缩到 ~/.yyagent/backups/，滚动保留 N 份。用系统自带 tar（Win10+ 内置，-a 按扩展名出 zip）。
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { appRoot, loadConfig } from "./config.js"

const ROOT = join(homedir(), ".yyagent")
const BACKUP_DIR = join(ROOT, "backups")
/** 纳入备份的条目（相对 ~/.yyagent；不存在的自动跳过）
 *  T91：定时任务已从安装目录的 yyagentd.config.json 搬到 tasks.json（见 taskstore.ts），
 *  备份清单跟着改——否则备份里永远没有定时任务，「文件式一切可带走」对它是破的。
 *  注意 .master.key 也在这里面：它是 DPAPI 保护的（绑定当前 Windows 用户），
 *  备份包换机器/换用户都解不开，所以带进备份不会降低密钥保护强度。 */
const ITEMS = ["sessions", "memory", "db", "todo", "bin", "config.json", "tasks.json", "usage.jsonl", "usage-backfill.json", ".master.key"]

export interface BackupInfo { file: string; name: string; size: number; mtime: number }

export function listBackups(): BackupInfo[] {
  try {
    if (!existsSync(BACKUP_DIR)) return []
    return readdirSync(BACKUP_DIR)
      .filter((f) => (f.startsWith("backup-") && f.endsWith(".zip")) || (f.startsWith("repo-bundle-") && f.endsWith(".bundle")))
      .map((f) => {
        const st = statSync(join(BACKUP_DIR, f))
        return { file: f, name: f, size: st.size, mtime: st.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

/**
 * T127：仓库历史 git bundle 备份。数据 zip（会话/记忆/配置）覆盖不了**代码历史**——
 * 引擎源码的 git 提交只在本地仓库里，未推送期间磁盘损坏 = 全部开发归零（2026-10-03 实况）。
 * bundle 记录全部 refs，随时 `git clone <bundle>` 恢复。开发态（有 .git）才做，打包态静默跳过。
 * 滚动保留与数据 zip 共用 keep 池（bundle 按文件名前缀区分）。
 */
function createRepoBundle(out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const gitDir = join(appRoot(), ".git")
    if (!existsSync(gitDir)) return resolve() // 打包态/非 git 环境：静默跳过
    const p = spawn("git", ["bundle", "create", out, "--all"], { cwd: appRoot(), windowsHide: true })
    let err = ""
    p.stderr?.on("data", (d) => { err += String(d) })
    p.on("error", (e) => reject(e as Error))
    p.on("exit", (code) => {
      if (code !== 0) { try { unlinkSync(out) } catch { /* 忽略 */ } return reject(new Error(`git bundle 退出码 ${code}：${err.slice(0, 200)}`)) }
      resolve()
    })
  })
}

/** 立即执行一次备份；成功返回文件名，失败抛错（调用方决定是否静默） */
export function runBackupNow(): Promise<BackupInfo> {
  const keep = Math.max(1, loadConfig().backup?.keep ?? 14)
  mkdirSync(BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)
  const out = join(BACKUP_DIR, `backup-${stamp}.zip`)
  const items = ITEMS.map((i) => join(ROOT, i)).filter((p) => existsSync(p))
  if (!items.length) return Promise.reject(new Error("没有可备份的内容"))
  return new Promise((resolve, reject) => {
    // tar -a：按 .zip 扩展名自动用 zip 格式；-C 把根切到 ~/.yyagent，条目用相对路径。
    // 必须用 System32 的 bsdtar——PATH 里可能排到 Git 的 GNU tar，它把 C:\ 当远程主机（坑 86）
    const tarBin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    const p = spawn(tarBin, ["-a", "-c", "-f", out, "-C", ROOT, ...items.map((i) => i.slice(ROOT.length + 1))], { windowsHide: true })
    let err = ""
    p.stderr?.on("data", (d) => { err += String(d) })
    p.on("error", reject)
    p.on("exit", (code) => {
      if (code !== 0) { try { unlinkSync(out) } catch { /* 忽略 */ } return reject(new Error(err.slice(0, 300) || `tar 退出码 ${code}`)) }
      try {
        // T127：代码历史随行——数据 zip 之外再打一份仓库 bundle。
        // bundle 失败**不拖累**数据备份（它是加分项）：无论成败都走滚动保留并 resolve。
        const finish = () => {
          try {
            const all = listBackups()
            for (const old of all.slice(keep)) { try { unlinkSync(join(BACKUP_DIR, old.file)) } catch { /* 忽略 */ } }
            const st = statSync(out)
            resolve({ file: out, name: out.split(/[\\/]/).pop()!, size: st.size, mtime: st.mtimeMs })
          } catch (e) { reject(e as Error) }
        }
        createRepoBundle(join(BACKUP_DIR, `repo-bundle-${stamp}.bundle`))
          .then(finish, (e) => { console.error(`[备份] repo bundle 跳过：${(e as Error).message.slice(0, 120)}`); finish() })
      } catch (e) { reject(e as Error) }
    })
  })
}

/** 备份调度：由网关启动时调用——立即补一次（距上次超过间隔才真正跑），并挂小时级轮询 */
export function startBackupSchedule(): void {
  const tick = () => {
    const cfg = loadConfig().backup
    if (cfg?.enabled === false) return
    const hours = Math.max(1, cfg?.intervalHours ?? 24)
    const all = listBackups()
    const last = all[0]?.mtime ?? 0
    if (Date.now() - last >= hours * 3600_000) {
      runBackupNow().catch(() => { /* 备份失败不影响网关 */ })
    }
  }
  tick()
  setInterval(tick, 3600_000).unref()
}
