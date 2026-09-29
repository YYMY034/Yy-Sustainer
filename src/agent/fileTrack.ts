/**
 * D6 文件修改追踪：按会话记录本轮 write/edit 改动的文件 + 改前快照，供前端「修改文件 N + 撤销」。
 *
 * 设计：
 * - 快照在 write/edit 实际写盘前采集（write 新建 → snapshot=null 表示撤销时删除；edit → 存原全文）。
 * - 同一文件同轮多次编辑只保留第一次快照（第一次的改前状态才是"撤销后应回到"的状态）。
 * - 记录按 sessionId 隔离（AsyncLocalStorage store.sessionId 由 loop 传入），runTurn 结束后由 gateway 取走并清空。
 *
 * B0-a（T93）：采集原来**没有任何上限**，而且是 `readFileSync(path, "utf8")` 一把梭：
 *   ① 模型 edit 一个几百 MB 的文件 → 整个进程被撑爆（read 工具有 MAX_READ_BYTES，这里没有）
 *   ② 二进制文件经 utf8 读入再写回 = **损坏**，撤销反而毁文件
 * 现在按 Buffer 读、先看大小、再探 NUL；超限/二进制/读不了一律**不采快照**，但记 `skipped` 原因。
 * `skipped` 与「新建文件（snapshot=null）」必须区分——否则撤销端会把一个原本就存在的大文件
 * 当成「本轮新建」直接删掉。
 */
import { existsSync, readFileSync, statSync } from "node:fs"

/** 单文件快照上限。超过就不采：宁可没有撤销能力，也不能把进程/磁盘搭进去。 */
export const MAX_SNAPSHOT_BYTES = 512 * 1024

export interface FileEdit {
  path: string // 绝对路径
  snapshot: string | null // 写前内容；null = 本次是新建文件（撤销 = 删除）
  kind: "write" | "edit"
  ts: number
  /** 没采到快照的原因。有它就**不是**「原本不存在」——撤销端绝不能删这个文件 */
  skipped?: "too-large" | "binary" | "unreadable"
}

// sessionId -> 本轮已采集的文件修改（runTurn 开始时无需清空——用 beginTurn/endTurn 显式管理）
const store = new Map<string, FileEdit[]>()

export function beginFileTracking(sessionId: string): void {
  store.set(sessionId, [])
}

/** 二进制探测：UTF-8 文本不该含 NUL。顺带也能挡住 UTF-16（ASCII 区全是 NUL）。 */
function looksBinary(buf: Buffer): boolean {
  return buf.includes(0)
}

/** 在写盘前调用：采集改前快照（同轮同文件只留首次） */
export function trackFileChange(sessionId: string | undefined, absPath: string, kind: "write" | "edit"): void {
  if (!sessionId) return
  const list = store.get(sessionId)
  if (!list) return
  if (list.some((f) => f.path === absPath)) return // 已有更早快照，保留

  let before: string | null = null
  let skipped: FileEdit["skipped"]

  if (kind === "write" && !existsSync(absPath)) {
    before = null // 新建文件：撤销 = 删除
  } else if (existsSync(absPath)) {
    try {
      const st = statSync(absPath)
      if (!st.isFile()) {
        skipped = "unreadable" // 目录/设备文件，读了也没法原样写回
      } else if (st.size > MAX_SNAPSHOT_BYTES) {
        skipped = "too-large"
      } else {
        const buf = readFileSync(absPath)
        // 二进制经 utf8 往返会损坏——不采，让撤销端明说「无法自动恢复」
        if (looksBinary(buf)) skipped = "binary"
        else before = buf.toString("utf8")
      }
    } catch {
      skipped = "unreadable"
    }
  }
  // 其余情况（edit 一个不存在的文件）维持原语义：snapshot=null 且不标 skipped

  list.push({ path: absPath, snapshot: before, kind, ts: Date.now(), ...(skipped ? { skipped } : {}) })
}

/** runTurn 收尾取走本轮全部修改并清空 */
export function takeFileEdits(sessionId: string): FileEdit[] {
  const list = store.get(sessionId) ?? []
  store.delete(sessionId)
  return list
}

/** 给人看的一句「为什么这条不能撤销」 */
export function skipReason(s: FileEdit["skipped"]): string {
  if (s === "too-large") return `文件超过 ${Math.round(MAX_SNAPSHOT_BYTES / 1024)}KB，未采快照`
  if (s === "binary") return "二进制文件，无法用文本快照原样恢复"
  return "读取失败（可能已被删除或无权限）"
}

/** 撤销时对单条 FileEdit 的处置决策 */
export type UndoAction =
  | { op: "delete" } // 本轮新建 → 删除
  | { op: "restore"; content: string } // 有快照 → 原样写回
  | { op: "refuse"; reason: string } // 没采到快照 → 一个字节都不动

/**
 * 撤销决策。**抽成纯函数是为了能测**——
 * 「skipped 的文件不能删」是数据毁灭级的错误（那文件原本就存在），
 * 不能只靠网关里那段 try/catch 保证。tests/fileTrack.test.ts 盯着。
 */
export function planUndo(f: FileEdit): UndoAction {
  if (f.skipped) return { op: "refuse", reason: skipReason(f.skipped) }
  if (f.snapshot == null) return { op: "delete" }
  return { op: "restore", content: f.snapshot }
}
