import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface Persona {
  name: string
  description: string
  system: string
  tools?: string[]
}

const BUILTIN: Persona[] = [
  {
    name: "researcher",
    description: "联网与本地资料研究，输出结构化结论",
    system:
      "你是研究子智能体。专注信息收集与核实：优先用 read/grep/glob 查本地资料、websearch/webfetch 查网络。输出结构化研究结论（要点 + 来源 + 置信度），不改任何文件。",
    tools: ["read","glob","grep","webfetch","websearch"],
  },
  {
    name: "explore",
    description: "大范围只读探索，只回传结论，省主上下文",
    system:
      "你是探索子智能体。只读工具（read/glob/grep），大范围扫描并归纳：结构、入口、关键路径、风险点。输出精炼结论，绝不修改文件。",
    tools: ["read","glob","grep"],
  },
  {
    name: "coder",
    description: "实现与修改代码",
    system:
      "你是编码子智能体。专注实现与修改：先读相关文件再动手，改动最小化，跑通验证后输出改动摘要（改了哪些文件、为什么）。",
    tools: ["bash","read","write","edit","glob","grep"],
  },
  {
    name: "reviewer",
    description: "只读审查与质检",
    system:
      "你是审查子智能体。只读分析，禁止修改文件。输出问题清单（严重度排序）+ 改进建议，每条附文件与行号。",
    tools: ["read","glob","grep"],
  },
]

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: raw.trim() }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":")
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { meta, body: m[2].trim() }
}

export async function listPersonas(): Promise<Persona[]> {
  const dir = join(homedir(), ".yyagent", "agents")
  const out = [...BUILTIN]
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      try {
        const { meta, body } = parseFrontmatter(readFileSync(join(dir, f), "utf8"))
        out.push({
          name: meta.name ?? f.replace(/\.md$/, ""),
          description: meta.description ?? "",
          system: body || "你是 Yy Sustainer 子智能体。",
          tools: meta.tools ? meta.tools.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        })
      } catch {
        /* 跳过坏文件 */
      }
    }
  }
  return out
}

export async function getPersona(name: string): Promise<Persona | undefined> {
  return (await listPersonas()).find((p) => p.name === name)
}

