import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export interface LoadedPlugin {
  name: string
  tools: string[]
}

export interface PluginLoadResult {
  tools: Record<string, unknown>
  loaded: LoadedPlugin[]
  errors: string[]
}

/**
 * 插件：~/.yyagent/plugins/*.ts|.js（单文件）或 ~/.yyagent/plugins/<name>/{index,main}.ts|.js（目录形态）
 * 支持两种导出：
 *   export const tools = { my_tool: aiTool({...}) }
 *   export default async () => ({ tools: {...} })
 * 插件工具会与内置工具合并（同名时插件覆盖内置）。
 * R3：插件目录里还可放 SKILL.md（单个）或 skills 子目录里的 SKILL.md（多个），
 * 由 skills/loader 统一扫描注入 system prompt——插件 = 工具 + 工作流文档。
 */
export async function loadPlugins(): Promise<PluginLoadResult> {
  const dir = join(homedir(), ".yyagent", "plugins")
  const tools: Record<string, unknown> = {}
  const loaded: LoadedPlugin[] = []
  const errors: string[] = []
  if (!existsSync(dir)) return { tools, loaded, errors }
  // 候选入口：单文件 + 目录形态（index/main，ts 优先 js）
  const entries: Array<{ label: string; file: string }> = []
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.isFile() && /\.(ts|js|mjs)$/.test(f.name) && !f.name.endsWith(".d.ts") && !f.name.endsWith(".test.ts")) {
      entries.push({ label: f.name, file: join(dir, f.name) })
    } else if (f.isDirectory()) {
      for (const entry of ["index.ts", "main.ts", "index.js", "main.js", "index.mjs", "main.mjs"]) {
        const p = join(dir, f.name, entry)
        if (existsSync(p)) {
          entries.push({ label: `${f.name}/${entry}`, file: p })
          break
        }
      }
    }
  }
  for (const { label, file } of entries) {
    try {
      const mod = await import(pathToFileURL(file).href)
      let pluginTools: Record<string, unknown> | undefined
      const candidate = mod.default ?? mod.plugin ?? mod.tools
      if (typeof candidate === "function") {
        const res = await candidate({})
        pluginTools = res?.tools ?? res
      } else if (candidate && typeof candidate === "object") {
        pluginTools = candidate
      }
      if (pluginTools && typeof pluginTools === "object" && Object.keys(pluginTools).length) {
        Object.assign(tools, pluginTools)
        loaded.push({ name: label, tools: Object.keys(pluginTools) })
      }
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`)
    }
  }
  return { tools, loaded, errors }
}
