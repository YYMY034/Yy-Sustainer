/**
 * 定时任务工具：让模型知道自动化任务系统的存在，并能在用户有需求时自动创建/管理。
 * 数据源 = yyagentd.config.json 的 tasks（与网关调度器、Web 自动化页面同源）；
 * 写操作直接改配置文件，网关轮询/重启后生效；跑一次的临时提醒不进来（那是 cron 的职责）。
 */
import { tool, type Tool } from "ai"
import { z } from "zod"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"

interface DaemonTask { name: string; cron: string; prompt: string; cwd?: string; model?: string; timeoutMs?: number; enabled?: boolean }

function configPath(): string {
  // 引擎跑在 src/agent/，配置在仓库根（与 gateway.ts 的 daemonConfigPath 同一文件）
  return join(import.meta.dirname ?? ".", "..", "..", "yyagentd.config.json")
}

function loadTasks(): DaemonTask[] {
  try {
    return (JSON.parse(readFileSync(configPath(), "utf8")).tasks ?? []) as DaemonTask[]
  } catch {
    return []
  }
}

function saveTasks(tasks: DaemonTask[]): void {
  const p = configPath()
  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(readFileSync(p, "utf8")) } catch { /* 新文件 */ }
  cfg.tasks = tasks
  if (!existsSync(p)) { const { mkdirSync } = require("node:fs") as typeof import("node:fs"); mkdirSync(dirname(p), { recursive: true }) }
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n")
}

const CRON_HELP = `cron 五段式：分 时 日 月 周（如 "0 9 * * *" 每天9点、"30 8 * * 1-5" 工作日8:30、"0 */2 * * *" 每2小时）`

export const taskListTool = tool({
  description:
    "查看当前所有定时自动化任务（名称/cron/启用状态/最近一次运行结果）。用户问「我有哪些定时任务/自动化任务」或创建前查重时使用。",
  inputSchema: z.object({}),
  async execute() {
    const tasks = loadTasks()
    if (!tasks.length) return "当前没有定时任务。可用 task_create 创建（cron 五段式：分 时 日 月 周）。"
    return tasks.map((t) => `• ${t.name}${t.enabled === false ? "（已停用）" : ""} | cron: ${t.cron} | 任务: ${t.prompt.slice(0, 80)}${t.cwd ? ` | 工作区: ${t.cwd}` : ""}`).join("\n")
  },
})

export const taskCreateTool = tool({
  description:
    `创建定时自动化任务：到点后引擎会以独立无人值守会话自动执行 prompt（产出经 Windows toast 通知）。${CRON_HELP}。` +
    "用户说「每天/每周/定时帮我…」这类周期性需求时主动使用；prompt 必须自包含（到点执行时看不到当前对话）。name 用简短中文。",
  inputSchema: z.object({
    name: z.string().describe("任务名，唯一，如「每日晨报」"),
    cron: z.string().describe("五段式 cron，如 \"0 9 * * *\"=每天9点"),
    prompt: z.string().describe("到点自动执行的完整指令，必须自包含（写清目标、路径、输出要求，不引用当前对话）"),
    cwd: z.string().optional().describe("可选工作目录（涉及特定项目时给该项目的绝对路径）"),
  }),
  async execute({ name, cron, prompt, cwd }) {
    name = name.trim()
    if (!name || !prompt.trim()) return "[失败] name 与 prompt 必填"
    // node-cron 五段校验（与网关同一套规则；这里做轻校验，网关调度时还会再验）
    const seg = cron.trim().split(/\s+/)
    if (seg.length !== 5) return `[失败] cron 需五段式（分 时 日 月 周），收到: ${cron}`
    const tasks = loadTasks()
    if (tasks.some((t) => t.name === name)) return `[失败] 任务名已存在: ${name}（换名或让用户在自动化页面修改）`
    tasks.push({ name, cron: cron.trim(), prompt: prompt.trim(), cwd: cwd?.trim() || undefined, enabled: true })
    saveTasks(tasks)
    return `[已创建] 定时任务「${name}」cron=${cron.trim()}。重启引擎或打开自动化页面保存后生效调度；提示用户可在左侧「自动化」页查看/管理。`
  },
})

export const taskDeleteTool = tool({
  description: "删除定时自动化任务。用户明确说「取消/删掉某某定时任务」时使用，先 task_list 确认存在。",
  inputSchema: z.object({ name: z.string().describe("要删除的任务名") }),
  async execute({ name }) {
    const tasks = loadTasks()
    const idx = tasks.findIndex((t) => t.name === name)
    if (idx < 0) return `[失败] 无此任务: ${name}（用 task_list 查看现有任务）`
    tasks.splice(idx, 1)
    saveTasks(tasks)
    return `[已删除] 定时任务「${name}」`
  },
})

export const taskToggleTool = tool({
  description: "启用/停用定时任务（停用不删除，可再启用）。",
  inputSchema: z.object({ name: z.string().describe("任务名") }),
  async execute({ name }) {
    const tasks = loadTasks()
    const t = tasks.find((x) => x.name === name)
    if (!t) return `[失败] 无此任务: ${name}`
    t.enabled = t.enabled === false
    saveTasks(tasks)
    return `[已${t.enabled ? "启用" : "停用"}] 定时任务「${name}」`
  },
})

export function taskTools(): Record<string, Tool> {
  return {
    task_list: taskListTool,
    task_create: taskCreateTool,
    task_delete: taskDeleteTool,
    task_toggle: taskToggleTool,
  }
}
