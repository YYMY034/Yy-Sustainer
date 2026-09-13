/**
 * P1-10 场景化持久数据库：文件式 JSON 存储（与引擎"文件即状态"哲学一致）。
 * - 位置：~/.yyagent/db/<name>.json（name 白名单校验）
 * - 内置三库：notes（笔记库）/ contacts（联系人·搭子库）/ knowledge（知识片段库）
 * - 每库统一结构：{ records: Array<{ id, createdAt, updatedAt, tags, ...fields }> }
 * - 网关通过 listDb/getDb/upsertDb/deleteDb/queryDb 暴露 CRUD；前端设置页有管理界面
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import { join, basename } from "node:path"
import { homedir } from "node:os"

export const DB_DIR = join(homedir(), ".yyagent", "db")

/** 内置库定义：字段约束 + 描述（管理界面/工具描述共用） */
export const BUILTIN_DBS: Record<string, { label: string; desc: string; fields: string[] }> = {
  notes: { label: "笔记库", desc: "随手记的想法、备忘、待整理信息", fields: ["title", "content"] },
  contacts: { label: "联系人·搭子库", desc: "联系人/搭子信息：怎么认识、偏好、常用联系渠道", fields: ["name", "type", "contact", "note"] },
  knowledge: { label: "知识片段库", desc: "查证过的事实、结论、引用来源，供后续快速复用", fields: ["topic", "content", "source"] },
}

export interface DbRecord {
  id: string
  createdAt: number
  updatedAt: number
  tags: string[]
  [key: string]: unknown
}

export interface DbFile {
  name: string
  records: DbRecord[]
}

function dbPath(name: string): string {
  return join(DB_DIR, `${basename(name)}.json`)
}

export function isValidDbName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name)
}

export function listDbs(): Array<{ name: string; label?: string; desc?: string; count: number }> {
  if (!existsSync(DB_DIR)) return []
  const out: Array<{ name: string; label?: string; desc?: string; count: number }> = []
  for (const f of readdirSafe(DB_DIR)) {
    if (!f.endsWith(".json")) continue
    const name = f.slice(0, -5)
    if (!isValidDbName(name)) continue
    try {
      const data = JSON.parse(readFileSync(join(DB_DIR, f), "utf8")) as DbFile
      const meta = BUILTIN_DBS[name]
      out.push({ name, label: meta?.label, desc: meta?.desc, count: data.records?.length ?? 0 })
    } catch { /* 跳过损坏文件 */ }
  }
  return out
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

export function getDb(name: string): DbFile {
  const p = dbPath(name)
  if (!existsSync(p)) return { name, records: [] }
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as DbFile
    if (!Array.isArray(data.records)) return { name, records: [] }
    return data
  } catch {
    return { name, records: [] }
  }
}

export function saveDb(name: string, data: DbFile): void {
  mkdirSync(DB_DIR, { recursive: true })
  writeFileSync(dbPath(name), JSON.stringify({ name, records: data.records }, null, 2))
}

export function upsertDbRecord(name: string, rec: Partial<DbRecord> & { id?: string }): DbRecord {
  const db = getDb(name)
  const now = Date.now()
  const existing = rec.id ? db.records.find((r) => r.id === rec.id) : undefined
  let saved: DbRecord
  if (existing) {
    Object.assign(existing, rec, { updatedAt: now })
    saved = existing
  } else {
    saved = {
      id: `r${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      createdAt: now,
      updatedAt: now,
      tags: Array.isArray(rec.tags) ? rec.tags : [],
      ...rec,
    }
    db.records.push(saved)
  }
  saveDb(name, db)
  return saved
}

export function deleteDbRecord(name: string, id: string): boolean {
  const db = getDb(name)
  const idx = db.records.findIndex((r) => r.id === id)
  if (idx < 0) return false
  db.records.splice(idx, 1)
  saveDb(name, db)
  return true
}

/** 全文查询：id 精确 → tag 精确 → 关键词子串（不分大小写），q 为空返回全部 */
export function queryDb(name: string, q?: string, tag?: string): DbRecord[] {
  let records = getDb(name).records
  if (tag) records = records.filter((r) => r.tags?.includes(tag))
  if (q) {
    const kw = q.toLowerCase()
    records = records.filter((r) => JSON.stringify(r).toLowerCase().includes(kw))
  }
  return records
}
