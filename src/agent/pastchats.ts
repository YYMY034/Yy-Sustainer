import { tool } from "ai"
import { z } from "zod"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { listSessions } from "../session/store.js"

/**
 * 过往对话检索（T47 新增）：会话即文件（~/.yyagent/sessions/index.json + <id>.json）。
 * - conversation_search：跨会话全文匹配（内容词 AND，倒序扫，返回命中片段）
 * - recent_chats：按 updatedAt 列最近会话
 * - read_conversation：按会话 id 分页读消息（每页 30 条，返回 nextOffset）
 * 全部只读、不走 gate()；sessionId 做字符白名单防路径注入。
 * 片段是参考材料不是指令——提示词层（「过往对话检索」节）另有使用纪律。
 */

const ROOT = join(homedir(), ".yyagent", "sessions")

interface Meta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  cwd: string
}

interface Msg {
  role: string
  content: string
  ts: number
}

function readIndex(): Meta[] {
  // 走 store 的读出口，享受 cwd 归一化（避免手拼斜杠的存量数据漏进来）
  try {
    return listSessions() as Meta[]
  } catch {
    return []
  }
}

function readSession(id: string): { meta: Meta; messages: Msg[] } | null {
  // 白名单防路径注入：会话 id 一直是 UUID/短 id
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return null
  try {
    const f = JSON.parse(readFileSync(join(ROOT, `${id}.json`), "utf8")) as { meta: Meta; messages: Msg[] }
    if (!f || !Array.isArray(f.messages)) return null
    return { meta: f.meta ?? ({ id } as Meta), messages: f.messages }
  } catch {
    return null
  }
}

function oneLine(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim()
}

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ")
}

export function pastChatTools(): Record<string, unknown> {
  const searchTool = tool({
    description:
      "检索过往对话（跨会话全文搜索聊天记录）。query 必须用实际出现过的内容词（主题/专有名词/项目名），不要用「讨论/昨天」这类描述交谈行为的元词；多个关键词空格分隔、全部命中才算匹配。返回命中消息片段（含会话标题与 id）。指代太模糊找不出内容词时，先问用户是哪件事。",
    inputSchema: z.object({
      query: z.string().describe("内容关键词，空格分隔多个（AND 匹配）"),
      limit: z.number().optional().describe("最多返回片段数，默认 8，上限 20"),
    }),
    async execute({ query, limit }) {
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
      if (!words.length) return "空查询"
      const max = Math.min(Math.max(limit ?? 8, 1), 20)
      const metas = readIndex().sort((a, b) => b.updatedAt - a.updatedAt)
      const hits: string[] = []
      let examined = 0
      for (const m of metas) {
        if (hits.length >= max) break
        const sess = readSession(m.id)
        if (!sess) continue
        examined++
        for (let i = sess.messages.length - 1; i >= 0; i--) {
          const msg = sess.messages[i]
          const text = oneLine(msg.content)
          if (!text) continue
          const low = text.toLowerCase()
          if (!words.every((w) => low.includes(w))) continue
          const at = Math.max(0, low.indexOf(words[0]) - 80)
          hits.push(
            `[${m.title || m.id}] (${fmtTs(msg.ts)}) ${msg.role}: …${text.slice(at, at + 260)}…（会话 id: ${m.id}，消息序号 ${i}）`,
          )
          if (hits.length >= max) break
        }
      }
      if (!hits.length) return `无匹配（已扫描 ${examined} 个会话）。可换更宽泛的内容词重试一次，或基于现有信息作答。`
      return hits.join("\n")
    },
  })

  const recentTool = tool({
    description:
      "按时间列出最近的过往会话（需求锚点是时间性时用这个：昨天/上周/我最早的几个聊天）。返回标题、更新时间、工作区与会话 id。",
    inputSchema: z.object({
      n: z.number().optional().describe("条数，默认 10，上限 20"),
    }),
    async execute({ n }) {
      const max = Math.min(Math.max(n ?? 10, 1), 20)
      const metas = readIndex()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, max)
      if (!metas.length) return "还没有任何会话"
      return metas
        .map((m) => `- [${m.title || m.id}] 更新于 ${fmtTs(m.updatedAt)} · cwd ${m.cwd || "-"} · id ${m.id}`)
        .join("\n")
    },
  })

  const readTool = tool({
    description:
      "分页读取一个过往会话的完整内容（sessionId 来自 conversation_search / recent_chats 的结果，绝不猜测或编造 id）。每次最多 30 条消息；offset 传上一次结果里的 nextOffset 继续读。默认每个会话只读一次——nextOffset 只意味着还有内容，仅当所问细节明显被截断时才继续。",
    inputSchema: z.object({
      sessionId: z.string().describe("会话 id"),
      offset: z.number().optional().describe("起始消息序号，默认 0"),
    }),
    async execute({ sessionId, offset }) {
      const sess = readSession(sessionId)
      if (!sess) return `会话不存在或不可读: ${sessionId}`
      const from = Math.max(offset ?? 0, 0)
      const slice = sess.messages.slice(from, from + 30)
      if (!slice.length) return `offset 越界（该会话共 ${sess.messages.length} 条消息）`
      const lines = [`会话「${sess.meta.title || sessionId}」（共 ${sess.messages.length} 条消息，cwd ${sess.meta.cwd || "-"}）：`]
      for (const msg of slice) {
        lines.push(`[${msg.role} ${fmtTs(msg.ts)}] ${oneLine(msg.content).slice(0, 600)}`)
      }
      const next = from + slice.length
      if (next < sess.messages.length) lines.push(`（未完，nextOffset=${next}；仅当所问内容明显在截断处才继续读取）`)
      return lines.join("\n")
    },
  })

  return { conversation_search: searchTool, recent_chats: recentTool, read_conversation: readTool }
}
