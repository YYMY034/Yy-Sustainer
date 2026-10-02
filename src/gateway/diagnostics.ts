/**
 * T110：诊断导出（gateway 拆分的第一块独立模块）。
 *
 * 为什么单独一个文件：gateway.ts 已经 2800+ 行，这个功能恰好自包含
 * （只依赖 config/store/taskstore 这些下层模块），拿它立「新功能 = 新模块」的标杆，
 * 后续拆分按同样的路数走（每拆一块，probe-routes/单测兜底）。
 *
 * 红线：**任何密钥/凭据/用户内容不出现在输出里**——apiKey/authToken 打码，
 * providers/会话只出元数据（名字、数量、时间），不出消息正文、不出记忆内容。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { appRoot, loadConfig } from "../agent/config.js"
import { listSessions } from "../session/store.js"
import { loadDaemonTasks } from "../agent/taskstore.js"

export interface DiagOpts {
  /** 网关的 logs 目录（history.jsonl 所在）——由调用方传入，本模块不感知网关路径布局 */
  logsDir: string
}

/** 版本号从包文件读一次（打包态 appRoot 解析过两种目录深度的差异，坑 #94） */
let cachedVersion: string | null = null
function pkgVersion(): string {
  if (cachedVersion) return cachedVersion
  try {
    cachedVersion = String(JSON.parse(readFileSync(join(appRoot(), "package.json"), "utf8")).version ?? "unknown")
  } catch {
    cachedVersion = "unknown"
  }
  return cachedVersion
}

export function buildDiagnostics(opts: DiagOpts): Record<string, unknown> {
  const cfg = loadConfig()
  const sessions = listSessions()
  const tasks = loadDaemonTasks()

  // 最近失败任务：history.jsonl 里 ok:false 的行，取最后 20 条（只取元数据，不取报告正文）
  const recentErrors: Array<Record<string, unknown>> = []
  const historyFile = join(opts.logsDir, "history.jsonl")
  if (existsSync(historyFile)) {
    const lines = readFileSync(historyFile, "utf8").split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0 && recentErrors.length < 20; i--) {
      try {
        const rec = JSON.parse(lines[i]) as { ok?: boolean; ts?: string; task?: string; error?: string }
        if (rec.ok === false) recentErrors.push({ ts: rec.ts, task: rec.task, error: String(rec.error ?? "").slice(0, 160) })
      } catch { /* 坏行跳过 */ }
    }
  }

  // 用量账本：只出体积与最后一条（不逐行展开，账本可能很大）
  let usage: Record<string, unknown> = { present: false }
  try {
    const usageFile = join(homedir(), ".yyagent", "usage.jsonl")
    if (existsSync(usageFile)) {
      const st = statSync(usageFile)
      const lastLine = readFileSync(usageFile, "utf8").split(/\r?\n/).filter(Boolean).pop()
      usage = { present: true, bytes: st.size, lastRecord: lastLine ? JSON.parse(lastLine) : null }
    }
  } catch { /* 读不了就报 absent */ }

  // T122：记忆统计——条目数/体积/最后修改（治理视图的数据源；内容不出现在诊断里）
  const memoryLayer = (dir: string): { topics: number; bytes: number; lastModified: number | null } => {
    const tDir = join(dir, "topics")
    if (!existsSync(tDir)) return { topics: 0, bytes: 0, lastModified: null }
    let topics = 0
    let bytes = 0
    let last = 0
    for (const f of readdirSync(tDir)) {
      if (!f.endsWith(".md")) continue
      topics++
      const st = statSync(join(tDir, f))
      bytes += st.size
      last = Math.max(last, st.mtimeMs)
    }
    return { topics, bytes, lastModified: last || null }
  }
  const memoryRoot = join(homedir(), ".yyagent", "memory")
  const memory: Record<string, unknown> = { user: memoryLayer(memoryRoot) }
  const projectsDir = join(memoryRoot, "projects")
  if (existsSync(projectsDir)) {
    const projects: Record<string, unknown> = {}
    for (const slug of readdirSync(projectsDir)) projects[slug] = memoryLayer(join(projectsDir, slug))
    memory.projects = projects
  }

  return {
    generatedAt: new Date().toISOString(),
    version: pkgVersion(),
    runtime: { node: process.version, platform: process.platform, uptimeMs: Math.round(process.uptime() * 1000) },
    config: {
      model: cfg.model,
      visionModel: cfg.visionModel,
      permission: cfg.permission,
      maxSteps: cfg.maxSteps,
      searchEngine: cfg.searchEngine,
      proxy: !!cfg.proxy,
      lanShare: !!cfg.lanShare,
      sessionArchiveDays: cfg.sessionArchiveDays ?? 0,
      providers: Object.keys(cfg.providers ?? {}),
      mcpServers: Object.keys(cfg.mcpServers ?? {}),
      hooksEnabled: (cfg.hooks ?? []).filter((h) => h.enabled).length,
      // 密钥/token/会话内容/记忆内容一律不出现在诊断里（privacy-first 的替代品是手动导出）
      secrets: "redacted",
    },
    sessions: {
      count: sessions.length,
      oldest: sessions.length ? Math.min(...sessions.map((s) => s.updatedAt ?? 0)) : null,
      newest: sessions.length ? Math.max(...sessions.map((s) => s.updatedAt ?? 0)) : null,
    },
    tasks: tasks.map((t) => ({ name: t.name, cron: t.cron, enabled: t.enabled !== false, lastOk: (t as { last?: { ok?: boolean } }).last?.ok ?? null })),
    recentErrors,
    usage,
    memory,
  }
}
