/**
 * T91 定时任务存储：从「安装目录里的 yyagentd.config.json」搬到 ~/.yyagent/tasks.json。
 *
 * 为什么必须搬（三条都是真实故障，不是洁癖）：
 *  1. 写不进去：打包后 Electron 装在 Program Files，非管理员对安装目录没有写权限，
 *     模型调 task_create 直接 EPERM，用户只看到一句失败；
 *  2. 读写不是同一个文件：打包后整包变成 dist/gateway.mjs 单文件，
 *     gateway 用 __dirname + ".."、tasks.ts 用 import.meta.dirname + "../.."，
 *     同一份配置解析出两个路径 —— 模型「创建成功」，调度器却读不到；
 *  3. 违反「文件式一切落盘 ~/.yyagent」：定时任务不在备份/迁移/带走的范围内。
 *
 * 首次运行自动从旧位置迁移一次（旧文件保留不删，用户可自行清理）。
 * 写入用「临时文件 + rename」原子替换，避免调度器读到写了一半的 JSON。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { appRoot } from "./config.js"

export interface DaemonTask {
  name: string
  cron: string
  prompt: string
  cwd?: string
  model?: string
  timeoutMs?: number
  enabled?: boolean
}

const DIR = join(homedir(), ".yyagent")
const FILE = join(DIR, "tasks.json")

export function daemonTasksPath(): string {
  return FILE
}

/** 旧位置（安装目录）——只在迁移时读一次 */
function legacyPath(): string {
  return join(appRoot(), "yyagentd.config.json")
}

function migrateOnce(): void {
  try {
    if (existsSync(FILE)) return
    const legacy = legacyPath()
    if (!existsSync(legacy)) return
    const raw = JSON.parse(readFileSync(legacy, "utf8")) as { tasks?: DaemonTask[] }
    if (!raw.tasks?.length) return
    saveDaemonTasks(raw.tasks)
    console.error(`[定时任务] 已从安装目录迁移 ${raw.tasks.length} 个任务到 ${FILE}（旧文件保留，可自行删除）`)
  } catch {
    /* 迁移失败按空处理，不影响启动 */
  }
}

export function loadDaemonTasks(): DaemonTask[] {
  migrateOnce()
  try {
    return (JSON.parse(readFileSync(FILE, "utf8")).tasks ?? []) as DaemonTask[]
  } catch {
    return []
  }
}

/** 原子写：临时文件 + rename，避免读到半个文件 */
export function saveDaemonTasks(tasks: DaemonTask[]): void {
  mkdirSync(DIR, { recursive: true })
  const tmp = `${FILE}.tmp`
  writeFileSync(tmp, JSON.stringify({ tasks }, null, 2) + "\n", "utf8")
  renameSync(tmp, FILE)
}
