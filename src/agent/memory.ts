import { tool } from "ai"
import { z } from "zod"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { toolCtx } from "./tools.js"

/**
 * 记忆分层：
 * - user 层：~/.yyagent/memory/（跨项目用户偏好、个人习惯）
 * - project 层：~/.yyagent/memory/projects/<cwd-slug>/（项目事实、结构、约定）
 * 何时写：用户偏好/跨项目结论 → user；项目相关事实 → project
 * 何时读：涉及历史/背景/偏好时先搜，避免凭空猜
 */

const ROOT = join(homedir(), ".yyagent", "memory")

function scopeDir(scope: "user" | "project"): string {
  if (scope === "user") return ROOT
  // P1-5 cwd 并发污染：项目层 slug 取当前 agent 运行上下文的 cwd（AsyncLocalStorage），
  // 而不是进程 cwd —— 并行运行的不同会话/任务各自落到自己的项目记忆目录
  const cwd = toolCtx.getStore()?.cwd ?? process.cwd()
  const slug = cwd.replace(/^([A-Za-z]):?[\\/]*/, "$1-").replace(/[\\/]+/g, "-").replace(/[^A-Za-z0-9\-_\u4e00-\u9fff]/g, "").toLowerCase()
  return join(ROOT, "projects", slug)
}

function safeTopic(t: string): string | null {
  const s = t.trim().toLowerCase().replace(/\s+/g, "-")
  if (!s || !/^[a-z0-9\u4e00-\u9fff_-]+$/.test(s)) return null
  return s
}

function oneLine(s: string): string {
  return s.replace(/\r?\n/g, " ").trim()
}

const scopeDesc = '记忆层级："user"=跨项目个人偏好/习惯；"project"=当前项目的事实与约定（默认 user）'

export function memoryTools(): Record<string, unknown> {
  const saveTool = tool({
    description: "把持久性信息保存到长期记忆。旧信息需要更正时，在 content 中写明取代哪条。",
    inputSchema: z.object({
      topic: z.string().describe("主题 slug，如 user-prefs、proj-yyagent"),
      summary: z.string().describe("一句话摘要，仅新主题时写入索引"),
      content: z.string().describe("要记住的具体内容"),
      scope: z.enum(["user", "project"]).optional().describe(scopeDesc),
    }),
    async execute({ topic, summary, content, scope }) {
      const dir = scopeDir(scope ?? "user")
      const t = safeTopic(topic)
      if (!t) return `无效主题名: ${topic}`
      const topics = join(dir, "topics")
      mkdirSync(topics, { recursive: true })
      const indexFile = join(dir, "MEMORY.md")
      if (!existsSync(indexFile)) writeFileSync(indexFile, "# 记忆索引\n")
      const file = join(topics, `${t}.md`)
      const date = new Date().toISOString().slice(0, 10)
      if (!existsSync(file)) {
        writeFileSync(file, `# ${t}\n\n- [${date}] ${oneLine(content)}\n`)
        appendFileSync(indexFile, `- ${t} — ${oneLine(summary)}\n`)
        return `已创建记忆主题 ${t}（${scope ?? "user"} 层）并写入首条记忆`
      }
      appendFileSync(file, `- [${date}] ${oneLine(content)}\n`)
      return `已追加到记忆主题 ${t}（${scope ?? "user"} 层）`
    },
  })

  const searchTool = tool({
    description: "按关键词检索长期记忆（可指定层级，默认搜索 user 层）",
    inputSchema: z.object({
      query: z.string().describe("关键词，空格分隔多个（全部命中才算匹配）"),
      scope: z.enum(["user", "project"]).optional().describe(scopeDesc),
    }),
    async execute({ query, scope }) {
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
      if (!words.length) return "空查询"
      const targets: Array<[string, string]> = []
      const u = scopeDir("user")
      if (existsSync(join(u, "topics"))) targets.push(["user", join(u, "topics")])
      const pr = scopeDir("project")
      if (existsSync(join(pr, "topics"))) targets.push(["project", join(pr, "topics")])
      const hits: string[] = []
      for (const [label, dir] of targets) {
        if (scope && label !== scope) continue
        for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
          const lines = readFileSync(join(dir, f), "utf8").split(/\r?\n/)
          lines.forEach((line, i) => {
            const low = line.toLowerCase()
            if (words.every((w) => low.includes(w))) hits.push(`[${label}] ${f}:${i + 1}: ${line.trim()}`)
          })
        }
      }
      return hits.length ? hits.slice(0, 50).join("\n") : "无匹配"
    },
  })

  const readTool = tool({
    description: "读取一个记忆主题的全部内容；topic 传 __index__ 读取该层总索引",
    inputSchema: z.object({
      topic: z.string().describe("主题 slug，或 __index__"),
      scope: z.enum(["user", "project"]).optional().describe(scopeDesc),
    }),
    async execute({ topic, scope }) {
      const dir = scopeDir(scope ?? "user")
      if (topic === "__index__") {
        const indexFile = join(dir, "MEMORY.md")
        return existsSync(indexFile) ? readFileSync(indexFile, "utf8") : "索引为空"
      }
      const t = safeTopic(topic)
      if (!t) return `无效主题名: ${topic}`
      const file = join(dir, "topics", `${t}.md`)
      return existsSync(file) ? readFileSync(file, "utf8") : `主题不存在: ${t}`
    },
  })

  return { memory_save: saveTool, memory_search: searchTool, memory_read: readTool }
}

/**
 * T123：被动记忆索引摘要——把两层 MEMORY.md 索引交给 prepare() 注入系统提示。
 *
 * 为什么要有它：记忆是**拉模式**（模型想起来才去 memory_search），而拉模式的天花板是
 * 「模型得知道有什么可搜」。索引常驻上下文后，跨会话的连续性从「碰运气」变成「看得见」。
 *
 * 约束：总量封顶（超出截断并提示用 memory_read __index__ 看全文）；项目层按目录枚举；
 * 任何读取失败都静默降级为空串（记忆缺席不该弄坏主流程）。内部单一职责调用
 * （compactBase）不注入——它们不看用户记忆。
 */
export function memoryIndexSummary(maxChars = 1600): string {
  const parts: string[] = []
  try {
    const userIndex = join(ROOT, "MEMORY.md")
    if (existsSync(userIndex)) parts.push(`[user 层]\n${readFileSync(userIndex, "utf8").trim()}`)
    const pDir = join(ROOT, "projects")
    if (existsSync(pDir)) {
      for (const slug of readdirSync(pDir)) {
        const f = join(pDir, slug, "MEMORY.md")
        if (existsSync(f)) parts.push(`[project:${slug}]\n${readFileSync(f, "utf8").trim()}`)
      }
    }
  } catch {
    return ""
  }
  if (!parts.length) return ""
  let s = parts.join("\n\n")
  if (s.length > maxChars) s = `${s.slice(0, maxChars)}\n…（索引过长已截断；用 memory_read 的 __index__ 主题看完整索引）`
  return s.trim()
}
