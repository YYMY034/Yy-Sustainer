import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface SkillInfo {
  name: string
  description: string
  path: string
}

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

function scanDir(dir: string, out: SkillInfo[]): void {
  if (!existsSync(dir)) return
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const skillFile = join(dir, d.name, "SKILL.md")
    if (!existsSync(skillFile)) continue
    try {
      const { meta } = parseFrontmatter(readFileSync(skillFile, "utf8"))
      out.push({
        name: meta.name ?? d.name,
        description: meta.description ?? "",
        path: skillFile,
      })
    } catch {
      /* 跳过坏文件 */
    }
  }
}

/** 扫单个 SKILL.md（插件根目录直接放的），目录名 = plugin 名 */
function scanSingle(dir: string, fallbackName: string, out: SkillInfo[]): void {
  const skillFile = join(dir, "SKILL.md")
  if (!existsSync(skillFile)) return
  try {
    const { meta } = parseFrontmatter(readFileSync(skillFile, "utf8"))
    out.push({ name: meta.name ?? fallbackName, description: meta.description ?? "", path: skillFile })
  } catch {
    /* 跳过坏文件 */
  }
}

/**
 * Skill 加载（兼容 opencode 格式）：
 * - 主源：~/.yyagent/skills/<name>/SKILL.md
 * - 兼容源：~/.config/opencode/skills/<name>/SKILL.md（复用已有 opencode skills）
 * - R3 插件接入：~/.yyagent/plugins/<plugin>/SKILL.md 与 ~/.yyagent/plugins/<plugin>/skills/<name>/SKILL.md
 *   ——插件除提供工具外可自带工作流文档，注入 system prompt 的方式与主 skill 完全一致
 * 清单注入 system prompt；agent 按需用 read 读全文执行。
 */
export function loadSkills(): SkillInfo[] {
  const out: SkillInfo[] = []
  scanDir(join(homedir(), ".yyagent", "skills"), out)
  const opencodeDir = process.env.OPENCODE_SKILLS_DIR ?? join(homedir(), ".config", "opencode", "skills")
  scanDir(opencodeDir, out)
  // R3：插件目录里的 SKILL.md（插件根单个）+ plugins/*/skills/（插件内多 skill 子目录）
  const pluginsDir = join(homedir(), ".yyagent", "plugins")
  if (existsSync(pluginsDir)) {
    for (const d of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      scanSingle(pluginsDir + "/" + d.name, d.name, out) // <plugin>/SKILL.md
      scanDir(pluginsDir + "/" + d.name + "/skills", out) // <plugin>/skills/<name>/SKILL.md
    }
  }
  return out
}

export function skillsPrompt(): string {
  const skills = loadSkills()
  if (!skills.length) return ""
  return (
    "\n\n## Skills（工作流文档）\n" +
    "以下 skill 匹配到任务场景时，先用 read 工具读取其 SKILL.md 全文并遵循其中的步骤执行：\n" +
    skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
  )
}
