import type { Tool } from "ai"
import { jsonSchema } from "ai"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { loadConfig } from "../agent/config.js"

export interface McpLoadResult {
  tools: Record<string, Tool>
  servers: string[]
  errors: string[]
  /** 保持连接的 client 列表（TUI 长驻时复用；无头场景进程结束前需 closeMcpTools 回收） */
  clients: Client[]
}

let cached: Promise<McpLoadResult> | null = null
/** 缓存对应的 mcpServers 指纹：配置变了就重连（T44）——设置页改完 MCP 不必再重启网关 */
let cachedSig: string | null = null

function mcpSignature(): string {
  try {
    return JSON.stringify(loadConfig().mcpServers ?? {})
  } catch {
    return "{}"
  }
}

export function loadMcpTools(): Promise<McpLoadResult> {
  const sig = mcpSignature()
  if (!cached || sig !== cachedSig) {
    const stale = cached
    cachedSig = sig
    cached = doLoad()
    // 旧连接在配置变更后异步回收，避免 MCP server 子进程泄漏
    if (stale) {
      void stale
        .then((r) => Promise.allSettled(r.clients.map((c) => c.close())))
        .catch(() => undefined)
    }
  }
  return cached
}

/** 关闭全部 MCP 连接（无头任务结束时调用，避免 server 子进程挂住进程不退出） */
export async function closeMcpTools(): Promise<void> {
  if (!cached) return
  const r = await cached
  cached = null
  cachedSig = null
  await Promise.allSettled(r.clients.map((c) => c.close()))
}

async function doLoad(): Promise<McpLoadResult> {
  const servers = loadConfig().mcpServers ?? {}
  const tools: Record<string, Tool> = {}
  const connected: string[] = []
  const errors: string[] = []
  const clients: Client[] = []

  for (const [name, cfg] of Object.entries(servers)) {
    try {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
      })
      // T58：客户端握手名对外可见（如 Tabbit 显示的连接方/任务名）——用产品名，不用内部标识 yyagent
      const client = new Client({ name: "Yy Sustainer", version: "1.0.0" })
      await client.connect(transport)
      const list = await client.listTools()
      for (const t of list.tools) {
        const toolName = `mcp_${name}_${t.name}`
        tools[toolName] = {
          description: `[MCP:${name}] ${t.description ?? t.name}`,
          inputSchema: jsonSchema((t.inputSchema as Parameters<typeof jsonSchema>[0]) ?? { type: "object", properties: {} }),
          execute: async (args: Record<string, unknown>) => {
            const result = await client.callTool({ name: t.name, arguments: args })
            const content = (result.content as Array<{ type: string; text?: string }>) ?? []
            return content
              .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
              .join("\n") || "(空结果)"
          },
        } as unknown as Tool
      }
      connected.push(`${name}(${list.tools.length})`)
      clients.push(client)
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`)
    }
  }
  return { tools, servers: connected, errors, clients }
}
