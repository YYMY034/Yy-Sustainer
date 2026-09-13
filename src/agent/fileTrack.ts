/**
 * D6 文件修改追踪：按会话记录本轮 write/edit 改动的文件 + 改前快照，供前端「修改文件 N + 撤销」。
 *
 * 设计：
 * - 快照在 write/edit 实际写盘前采集（write 新建 → snapshot=null 表示撤销时删除；edit → 存原全文）。
 * - 同一文件同轮多次编辑只保留第一次快照（第一次的改前状态才是"撤销后应回到"的状态）。
 * - 记录按 sessionId 隔离（AsyncLocalStorage store.sessionId 由 loop 传入），runTurn 结束后由 gateway 取走并清空。
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export interface FileEdit {
  path: string // 绝对路径
  snapshot: string | null // 写前内容；null = 本次是新建文件（撤销 = 删除）
  kind: "write" | "edit"
  ts: number
}

// sessionId -> 本轮已采集的文件修改（runTurn 开始时无需清空——用 beginTurn/endTurn 显式管理）
const store = new Map<string, FileEdit[]>()

export function beginFileTracking(sessionId: string): void {
  store.set(sessionId, [])
}

/** 在写盘前调用：采集改前快照（同轮同文件只留首次） */
export function trackFileChange(sessionId: string | undefined, absPath: string, kind: "write" | "edit"): void {
  if (!sessionId) return
  const list = store.get(sessionId)
  if (!list) return
  if (list.some((f) => f.path === absPath)) return // 已有更早快照，保留
  const before = kind === "write" && !existsSync(absPath) ? null : existsSync(absPath) ? readFileSync(absPath, "utf8") : null
  list.push({ path: absPath, snapshot: before, kind, ts: Date.now() })
}

/** runTurn 收尾取走本轮全部修改并清空 */
export function takeFileEdits(sessionId: string): FileEdit[] {
  const list = store.get(sessionId) ?? []
  store.delete(sessionId)
  return list
}
