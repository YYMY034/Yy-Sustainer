import type { Tool } from "ai"
import { jsonSchema } from "ai"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { loadConfig } from "../agent/config.js"
import { gate } from "../agent/permissions.js"
import { effectivePermission, toolCtx } from "../agent/tools.js"
// T92 超时策略（含对「SDK 无超时」这个误判的更正说明，见该文件头部注释）
import { MCP_MAX_TOTAL_MS, mcpCallErrorText, resolveMcpTimeoutMs } from "./timeout.js"

/**
 * T90 只读判定的名称启发式：MCP 未声明 annotations 时的兜底。
 * 判据是「有没有副作用」，所以白名单刻意收窄——拿不准就按写操作处理（多问一次），
 * 宁可多一次确认，不可让外部进程静默写盘 / 静默操作用户的浏览器会话。
 */
const READONLY_NAME_RE =
  /(^|_)(read|get|list|search|query|fetch|stat|info|status|describe|view|show|diff|cat|ls|dir|tree|find|grep|glob|screenshot|snapshot|tabs|history|inspect|analyze|check|validate|parse|resolve|exists|count|health|version|whoami|wait|poll|echo|peek)(_|$)/i

function mcpToolReadOnly(name: string, hint?: boolean): boolean {
  if (hint === true) return true
  if (hint === false) return false
  return READONLY_NAME_RE.test(name)
}

/** 供回归脚本断言分类结果（scripts/check-t90-perms.ts） */
export { mcpToolReadOnly }

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
  const conf = loadConfig()
  const servers = conf.mcpServers ?? {}
  const trusted = new Set(conf.mcpTrusted ?? [])
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
      // T92：握手与列工具同样显式给超时。不传的话 SDK 用固定的 60s——
      // 对「npx 首次冷启动要下载依赖」这类 server 偏紧，容易在初始化阶段就失败。
      const timeout = resolveMcpTimeoutMs(conf.mcpTimeoutMs)
      await client.connect(transport, { timeout })
      const list = await client.listTools({}, { timeout })
      for (const t of list.tools) {
        const toolName = `mcp_${name}_${t.name}`
        // T90 权限门：MCP 工具此前完全绕过 gate()——fs 写盘、Playwright 点击在任何权限档下都不问一声。
        // 现在：只读工具直接放行；写操作按危险操作处理（交互模式本会话首次确认一次，
        // 无人值守拒绝），config.mcpTrusted 里的 server 例外（危险档下免确认）。
        const readOnly = mcpToolReadOnly(t.name, t.annotations?.readOnlyHint)
        const trustedServer = trusted.has(name)
        tools[toolName] = {
          description: `[MCP:${name}] ${t.description ?? t.name}`,
          inputSchema: jsonSchema((t.inputSchema as Parameters<typeof jsonSchema>[0]) ?? { type: "object", properties: {} }),
          execute: async (args: Record<string, unknown>) => {
            if (!readOnly) {
              const ctx = toolCtx.getStore()
              const denial = await gate({
                tool: `mcp_${name}`,
                summary: `${t.name}(${JSON.stringify(args ?? {}).slice(0, 140)})`,
                danger: !trustedServer,
                mode: effectivePermission(),
                broker: ctx?.broker,
                sessionId: ctx?.sessionId,
                grantScope: `mcp:${name}`,
              })
              if (denial) return denial
            }
            // T92：长任务友好——服务端还在报进度就重置计时（它没挂），但总时长有硬上限兜底。
            // 超时错误翻成人话（等多久 / 为什么 / 怎么改），别让用户对着 `Request timed out` 发呆。
            const timeoutMs = resolveMcpTimeoutMs(conf.mcpTimeoutMs)
            try {
              const result = await client.callTool({ name: t.name, arguments: args }, undefined, {
                timeout: timeoutMs,
                resetTimeoutOnProgress: true,
                maxTotalTimeout: MCP_MAX_TOTAL_MS,
              })
              const content = (result.content as Array<{ type: string; text?: string }>) ?? []
              return content
                .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
                .join("\n") || "(空结果)"
            } catch (e) {
              throw new Error(mcpCallErrorText(name, t.name, e, timeoutMs))
            }
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
