import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { normalize } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import type { CoreMessage } from "ai"

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  cwd: string
  model?: string
  /** 上下文占用百分比（红绿灯缓存，切回会话不丢） */
  ctxPct?: number
  /** 会话累计 token 消耗（deepseek 风格统计：输入/输出/缓存命中 + 请求轮数） */
  usage?: { in: number; out: number; cached: number; turns: number; steps: number }
}

export interface StoredMessage {
  /** T55："system" = 系统提示（如模型切换），仅入库展示用，toCoreMessages 会过滤、绝不进 LLM 上下文 */
  role: "user" | "assistant" | "system"
  content: string
  ts: number
  tools?: string[]
  /** 用户消息附带的图片（dataUrl，与 content 中 [图片n] 占位一一对应），前端渲染成小气泡 */
  images?: string[]
  /** assistant 消息：本次生成实际使用的模型 spec（如 sensenova/glm-5.2），前端昵称显示用 */
  model?: string
  steps?: Array<{ name: string; argsSummary: string; input?: string; output?: string }>
  /** D6：本轮模型修改的文件（不含快照——快照在网关内存，撤销经 /api/sessions/:id/undo 走服务端） */
  fileEdits?: Array<{ path: string; kind: "write" | "edit" }>
  /** 用户对本条 assistant 回复的评分（点赞/点踩），进入会话记忆供模型感知 */
  feedback?: "up" | "down"
}

interface SessionFile {
  meta: SessionMeta
  messages: StoredMessage[]
}

const ROOT = join(homedir(), ".yyagent", "sessions")
const INDEX = join(ROOT, "index.json")

function ensure(): void {
  mkdirSync(ROOT, { recursive: true })
}

function readIndex(): SessionMeta[] {
  try {
    return JSON.parse(readFileSync(INDEX, "utf8")) as SessionMeta[]
  } catch {
    return []
  }
}

function writeIndex(list: SessionMeta[]): void {
  ensure()
  writeFileSync(INDEX, JSON.stringify(list, null, 2))
}

export function createSession(cwd: string, model?: string, title = "新对话"): SessionMeta {
  const meta: SessionMeta = {
    id: randomUUID().slice(0, 8),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cwd,
    model,
  }
  const list = readIndex()
  list.unshift(meta)
  writeIndex(list)
  persist(meta, [])
  return meta
}

export function listSessions(): SessionMeta[] {
  // T32：归一化 cwd——存量数据里同一路径有多种斜杠写法（C:\... / C://... / C:////...），
  // 前端按 cwd 字符串分组会裂成多个组。读出口统一压成规范形式（C:\Users\...），写入端不动。
  return readIndex().map((s) => (s.cwd ? { ...s, cwd: normalize(s.cwd) } : s))
}

export function loadSession(id: string): SessionFile | undefined {
  const f = join(ROOT, `${id}.json`)
  if (!existsSync(f)) return undefined
  return JSON.parse(readFileSync(f, "utf8")) as SessionFile
}

export function persist(meta: SessionMeta, messages: StoredMessage[]): void {
  ensure()
  writeFileSync(join(ROOT, `${meta.id}.json`), JSON.stringify({ meta, messages }, null, 2))
  const list = readIndex()
  const i = list.findIndex((x) => x.id === meta.id)
  if (i >= 0) {
    list[i] = meta
  } else {
    list.unshift(meta)
  }
  writeIndex(list)
}

export function deleteSession(id: string): void {
  const list = readIndex().filter((x) => x.id !== id)
  writeIndex(list)
  try {
    unlinkSync(join(ROOT, `${id}.json`))
  } catch {
    /* 文件可能不存在 */
  }
}

export function toCoreMessages(messages: StoredMessage[]): CoreMessage[] {
  return messages
    // T55：system（模型切换提示等）只入库展示，绝不进 LLM 上下文
    .filter((m) => m.role !== "system" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }) as CoreMessage)
}

/** P2-2 撤回/编辑：截掉 ts 及之后的所有消息，返回剩余消息数组（找不到返回 undefined） */
export function truncateFrom(messages: StoredMessage[], ts: number): StoredMessage[] | undefined {
  const idx = messages.findIndex((m) => m.ts === ts)
  if (idx < 0) return undefined
  return messages.slice(0, idx)
}
