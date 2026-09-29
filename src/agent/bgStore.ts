import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

/**
 * T93 B1：后台任务的**元数据**落盘。
 *
 * 要解决的现状：`bgTasks` 是进程内 `Map`，网关一重启就空。而**日志文件本来就在磁盘上**
 * （`~/.yyagent/bg/bg-N.log`，保留 50 个 / 7 天）——于是重启后出现最难用的一种状态：
 * 日志还在，但 `bg_read()` 列出空、`bg_read(task_id)` 说「未找到任务」，
 * 模型看得到日志路径却拿不到任何上下文。
 *
 * 只落元数据，**不含任何用户文件内容**，所以这一步风险和 checkpoint 那个目录不是一个量级。
 *
 * 顺手修一个会由本次改动放大的 bug：`bgSeq` 重启归零 → id 复用。一旦落盘，
 * 重启后的 `bg-1` 会覆盖旧 `bg-1` 的记录，而 `bg-1.log` 可能还在保留期内 → 读到错配的日志。
 * 所以 `nextBgId()` 必须从磁盘已有的最大 id 起步。
 */

const DIR = join(homedir(), ".yyagent", "bg")
const TASKS_FILE = join(DIR, "tasks.json")

/** 结构版本。字段语义变了就升号，旧版按「读不出来」处理 */
export const BG_TASKS_VERSION = 1
/** 记录数上限。日志寿命是 7 天，记录比日志活得更久没有意义 */
export const BG_MAX_RECORDS = 200
/** 与日志清理同源：少于这么多或新于这么多才留 */
export const BG_LOG_KEEP = 50
export const BG_LOG_MAX_AGE_MS = 7 * 24 * 3600_000

export interface BgTaskRec {
  v: number
  id: string // bg-N
  pid: number
  command: string // 模型给的命令原文（只存不用作路径）
  logFile: string // 服务端构造：~/.yyagent/bg/bg-N.log
  cwd: string
  startedAt: number
  endedAt?: number
  exitCode?: number | null
}

function ensure(): void {
  mkdirSync(DIR, { recursive: true })
}

/** 原子写：tmp + rename。半截 JSON 比没有更糟（读的人会以为一条记录都没有）。 */
function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, file)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* 没建成功就不用删 */ }
    throw e
  }
}

/** 读全部记录。文件不在 / JSON 坏 / 版本不符 → 空数组（不猜、不静默迁移） */
export function loadBgTasks(): BgTaskRec[] {
  try {
    if (!existsSync(TASKS_FILE)) return []
    const parsed = JSON.parse(readFileSync(TASKS_FILE, "utf8")) as BgTaskRec[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((r) => r && typeof r.id === "string" && typeof r.startedAt === "number" && r.v === BG_TASKS_VERSION)
  } catch {
    return []
  }
}

/** 按 startedAt 倒序（新的在前） */
export function listBgTasks(): BgTaskRec[] {
  return loadBgTasks().sort((a, b) => b.startedAt - a.startedAt)
}

/** 日志文件对应路径（与 startBackground 的命名保持一致，供读日志用）。
 *  **id 不合法就返回 undefined**——`bg_read` 的 task_id 是模型给的输入，
 *  直接拼进路径等于开一个任意文件读取（`../../foo` 能逃出 bg 目录）。 */
export function bgLogPath(id: string): string | undefined {
  if (!isValidBgId(id)) return undefined
  return join(DIR, `${id}.log`)
}

/** 后台任务 id 的形状。`nextBgId()` 只产这种，读侧也只认这种。 */
export function isValidBgId(id: unknown): id is string {
  return typeof id === "string" && /^bg-\d{1,9}$/.test(id)
}

/** 按 id 查记录。id 不合法直接 undefined（不做任何路径拼接）。 */
export function getBgTask(id: string): BgTaskRec | undefined {
  if (!isValidBgId(id)) return undefined
  return loadBgTasks().find((r) => r.id === id)
}

/** 追加或更新一条，顺手把记录数压回上限内（删最旧） */
export function saveBgTask(rec: Omit<BgTaskRec, "v">): void {
  try {
    ensure()
    const all = loadBgTasks().filter((r) => r.id !== rec.id)
    all.push({ ...rec, v: BG_TASKS_VERSION })
    all.sort((a, b) => a.startedAt - b.startedAt)
    writeAtomic(TASKS_FILE, all.slice(-BG_MAX_RECORDS))
  } catch {
    /* 落元数据失败不能影响主流程——它只是让重启后少一条可查的记录 */
  }
}

/** 从记录里解析 id 序号（`bg-12` → 12）。不是这个形状的忽略。 */
function idNum(id: string): number | undefined {
  const m = /^bg-(\d+)$/.exec(id)
  return m ? Number(m[1]) : undefined
}

/**
 * 下一个后台任务 id。**必须从磁盘已有最大序号起步**——
 * 用进程内计数器的话，重启后又是 bg-1，会覆盖旧记录并和还在保留期的日志错配。
 */
export function nextBgId(): string {
  let max = 0
  for (const r of loadBgTasks()) {
    const n = idNum(r.id)
    if (n !== undefined && n > max) max = n
  }
  return `bg-${max + 1}`
}

/**
 * 清掉「日志已经没了」的记录。日志是 7 天 / 50 个滚动删的，
 * 记录比日志活得更久只会让人点开一个空文件。
 */
export function sweepBgRecords(): number {
  try {
    const all = loadBgTasks()
    const keep = all.filter((r) => existsSync(r.logFile))
    const removed = all.length - keep.length
    if (removed > 0) writeAtomic(TASKS_FILE, keep)
    return removed
  } catch {
    return 0
  }
}
