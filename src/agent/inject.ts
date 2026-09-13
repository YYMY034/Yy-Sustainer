import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export interface InjectionContext {
  cwd: string
  sessionId?: string
  model?: string
}

/**
 * 上下文注入接口（留给用户自己实现）。
 *
 * 在 ~/.yyagent/injections/context.ts 中导出:
 *   export async function inject(ctx: InjectionContext): Promise<string>
 * 返回的字符串会被拼接到 system prompt 之后。
 * 文件不存在则注入为空。
 */
export async function loadInjection(ctx: InjectionContext): Promise<string> {
  const dir = join(homedir(), ".yyagent", "injections")
  for (const name of ["context.ts", "context.js", "context.mjs"]) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    try {
      const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`)
      if (typeof mod.inject === "function") {
        const out = await mod.inject(ctx)
        if (typeof out === "string" && out.trim()) return out.trim()
      }
    } catch (e) {
      console.error(`[injection 错误] ${(e as Error).message}`)
    }
    break
  }
  return ""
}
