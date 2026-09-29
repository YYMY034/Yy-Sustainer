import { tool, type Tool } from "ai"
import { z } from "zod"
import { spawn } from "node:child_process"
import { AsyncLocalStorage } from "node:async_hooks"
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import fg from "fast-glob"
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici"
import { gate, gateFileWrite, insideWorkspace, isDangerCommand, clearSessionGrants, type PermissionMode } from "./permissions.js"
import { dockerAvailable, runInSandbox } from "./sandbox.js"
import { loadConfig } from "./config.js"
import { runHooksOnTool } from "./hooks.js"
import { memoryTools } from "./memory.js"
import { pastChatTools } from "./pastchats.js"
import { makeTodoTool } from "./todo.js"
import { makeAskTool } from "./ask.js"
import { upsertDbRecord, queryDb, deleteDbRecord, listDbs, BUILTIN_DBS } from "./db.js"
import { sceneTools } from "./sceneTools.js"
import { BG_LOG_KEEP, BG_LOG_MAX_AGE_MS, bgLogPath, getBgTask, listBgTasks, nextBgId, saveBgTask, sweepBgRecords } from "./bgStore.js"
import { taskTools } from "./tasks.js"
import { trackFileChange } from "./fileTrack.js"
import { psCommand, runPowerShell, truncate } from "./ps.js"
import { makeComputerTool } from "./computer.js"
// T92：后台任务日志（~/.yyagent/bg/<id>.log）按数量/年龄清理
import { sweepOldFiles } from "../util/logfile.js"

// 出海代理：优先读 config.proxy（T67——Electron/桌面启动读不到终端环境变量，配置文件是
// 唯一可靠来源），其次回退 HTTP(S)_PROXY 环境变量（EnvHttpProxyAgent 原生行为）。
//
// T74 修正（这是"不管什么模型都报错"的真凶）：
//  setGlobalDispatcher 是**进程级**的，一旦装上 EnvHttpProxyAgent，AI SDK 发往模型的所有请求
//  都会先过代理。而终端里常见的 http_proxy（企业代理 / 本机 WorkBuddy 内部代理）根本够不着
//  用户的 127.0.0.1:8899，代理只能回一句 "HTTP 502 Bad Gateway" —— 于是本地模型全部挂掉，
//  报错还看着像"上游服务异常"，完全误导。所以本地地址必须永久绕过代理。
const LOCAL_NO_PROXY = "127.0.0.1,localhost,::1,0.0.0.0"
try {
  const proxyUrl = loadConfig().proxy?.trim()
  const envNoProxy = (process.env.NO_PROXY || process.env.no_proxy || "").trim()
  const noProxy = [envNoProxy, LOCAL_NO_PROXY].filter(Boolean).join(",")
  const hasEnvProxy = !!(
    process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy
  )
  if (proxyUrl) {
    setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy }))
  } else if (hasEnvProxy) {
    setGlobalDispatcher(new EnvHttpProxyAgent({ noProxy }))
  }
  // 既没配 config.proxy、环境里也没有代理 → 不装 dispatcher，别给请求无端加一层
} catch {
  /* 无代理配置时忽略 */
}

/** 每次调用的工具上下文：cwd 显式传递（解决 process.chdir 并发污染），broker 贯穿 ask/权限确认；sessionId 供 todo 等按会话存储的工具定位归属 */
export interface ToolContext {
  cwd: string
  broker?: import("./ask.js").QuestionBroker
  sessionId?: string
  /** T93：本轮的中止信号——delegate 要把它透传给子代理，否则主循环 abort 后子代理还在跑 */
  signal?: AbortSignal
  /** T97：主回合的状态回吐口（网关的 onStatus 广播）。delegate 借它把子代理进度
   *  顶到主对话的状态行上——原来子代理跑的时候主对话只看到 delegate 工具转圈，里面死活没人知道 */
  statusSink?: (text: string) => void
}

export const toolCtx = new AsyncLocalStorage<ToolContext>()

function currentCwd(): string {
  return toolCtx.getStore()?.cwd ?? process.cwd()
}

/** T90：目标路径是否落在工作区内——T93 挪到 permissions.ts（与 gateFileWrite 同处），这里只引用 */

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
}

// ---------- 后台任务 ----------

interface BgTask {
  pid: number
  command: string
  logFile: string
  startedAt: number
  done: boolean
  exitCode?: number | null
}

const bgTasks = new Map<string, BgTask>()
/** T92 上次清理后台日志目录的时间（节流用） */
let lastBgSweep = 0

/** T95：bg_read(wait) 的等待者。挂在任务 id 上，退出时逐个唤醒——
 *  把「模型反复 bg_read 轮询」（每次轮询都是一步真实 LLM 调用）变成一次调用等到结果。 */
const bgWaiters = new Map<string, Array<() => void>>()
/** T95：任务所属会话。bg-exit 广播按 sessionId 路由（8.3：每条广播必须带 sessionId） */
const bgSession = new Map<string, string | undefined>()
/** T95：网关注册的退出回调。引擎侧不认识 WS，广播方向是网关反过来订阅 */
const bgExitSubs: Array<(info: { id: string; sessionId?: string; exitCode?: number | null; command: string }) => void> = []
export function onBgExit(cb: (info: { id: string; sessionId?: string; exitCode?: number | null; command: string }) => void): void {
  bgExitSubs.push(cb)
}

function startBackground(command: string, cwd: string): string {
  // B1：id 从磁盘已有最大序号起步。用进程内计数器的话重启后又是 bg-1，
  // 会覆盖旧记录并和还在保留期内的 bg-1.log 错配。
  const id = nextBgId()
  const logDir = join(homedir(), ".yyagent", "bg")
  mkdirSync(logDir, { recursive: true })
  // T92：后台任务日志是「一次任务一个文件」，只增不减 → 保留最近 50 个且 7 天内的。
  // 节流到 5 分钟一次：目录扫描不该成为每次起后台命令的固定开销。
  if (Date.now() - lastBgSweep > 300_000) {
    lastBgSweep = Date.now()
    sweepOldFiles(logDir, { keep: BG_LOG_KEEP, maxAgeMs: BG_LOG_MAX_AGE_MS, suffix: ".log" })
    sweepBgRecords() // B1：日志没了，对应的元数据记录一并清
  }
  const logFile = join(logDir, `${id}.log`)
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCommand(command)], {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const stream = createWriteStream(logFile)
  child.stdout?.pipe(stream)
  child.stderr?.pipe(stream)
  const entry: BgTask = { pid: child.pid ?? 0, command, logFile, startedAt: Date.now(), done: false }
  bgTasks.set(id, entry)
  bgSession.set(id, toolCtx.getStore()?.sessionId)
  // B1：元数据落盘——进程内 Map 重启即空，而日志还在，那时模型「看得到路径拿不到上下文」
  saveBgTask({ id, pid: entry.pid, command, logFile, cwd, startedAt: entry.startedAt })
  child.on("exit", (code) => {
    entry.done = true
    entry.exitCode = code
    stream.end()
    saveBgTask({ id, pid: entry.pid, command, logFile, cwd, startedAt: entry.startedAt, endedAt: Date.now(), exitCode: code })
    // T95：先定值再通知（8.3 的「先赋值再广播」原则在这里同样成立）——
    // 等待者醒来后会立刻读 entry/bgTasks，那时状态必须是终态
    const sid = bgSession.get(id)
    bgSession.delete(id)
    for (const cb of bgExitSubs) {
      try { cb({ id, sessionId: sid, exitCode: code, command }) } catch { /* 某个订阅者炸了不拖累别人 */ }
    }
    const ws = bgWaiters.get(id)
    if (ws) {
      bgWaiters.delete(id)
      for (const w of ws) w()
    }
  })
  return id
}

// T14 会话级权限档位：每会话可独立选择（不互相混淆）；未设置的会话回落全局 config.permission
type PermissionMode3 = "confirm-all" | "danger-confirm" | "full-auto"
const sessionPermission = new Map<string, PermissionMode3>()
export function setSessionPermission(sessionId: string, mode: PermissionMode3): void {
  sessionPermission.set(sessionId, mode)
  // T90：换档位＝用户重新表态，此前攒下的会话级授权（桌面操控/MCP 写操作）一律作废
  clearSessionGrants(sessionId)
}
export function getSessionPermission(sessionId: string): PermissionMode3 | undefined {
  return sessionPermission.get(sessionId)
}
export function deleteSessionPermission(sessionId: string): void {
  sessionPermission.delete(sessionId)
  clearSessionGrants(sessionId)
}
function effectivePermission(): PermissionMode3 {
  const sid = toolCtx.getStore()?.sessionId
  const override = sid ? sessionPermission.get(sid) : undefined
  return (override ?? loadConfig().permission ?? "danger-confirm") as PermissionMode3
}

/** T90：MCP / 桌面操控等外部调用点要复用同一套「会话覆盖 > 全局」的档位判定，故导出 */
export { effectivePermission }

// ---------- 工具定义 ----------

export const bashTool = tool({
  description:
    "在 PowerShell 中执行命令（沙箱模式时在 Docker 的 Linux bash 中执行，工作区挂载 /workspace）。危险命令（sudo、rm -rf、提权、密钥赋值）按权限档位确认或拒绝。构建/测试/长任务用 background=true 转后台，bg_read 看输出。",
  inputSchema: z.object({
    command: z.string().describe("要执行的命令（默认 PowerShell；沙箱模式为 Linux bash）"),
    timeoutMs: z.number().optional().describe("前台超时（毫秒），默认 120000"),
    background: z.boolean().optional().describe("转后台（不阻塞），返回任务 id 与日志路径；后台任务不进沙箱"),
    sandbox: z.boolean().optional().describe("显式要求在 Docker 沙箱内执行（工作区挂载 /workspace）；会话已开沙箱时无需传"),
  }),
  async execute({ command, timeoutMs, background, sandbox }) {
    const mode = effectivePermission()
    // 拆分器调用（toolCtx 无 broker 但跑在拆分专用标志下）跳过 bash 权限门——纯 JSON 输出不会执行命令
    const isSplitter = (globalThis as Record<string, unknown>).__yyagentSplitter === true
    const rejection = isSplitter
      ? null
      : await gate({
          tool: "bash",
          summary: command.slice(0, 120),
          danger: isDangerCommand(command),
          mode,
          broker: toolCtx.getStore()?.broker,
          command,
          cwd: toolCtx.getStore()?.cwd, // T84：项目级白名单按 cwd 匹配
        })
    if (rejection) return rejection
    const cwd = currentCwd()
    // T88 沙箱执行：显式 sandbox=true 或会话开启沙箱模式 → Docker 容器内跑（权限门已在宿主侧先行）。
    // 无 Docker / 启动失败 → 回退本机并如实说明（模型下一步可自行适配语法差异）。后台任务不进沙箱。
    const sandboxCfg = loadConfig().sandbox
    if ((sandbox === true || sandboxCfg?.enabled === true) && !background) {
      const dockerOk = await dockerAvailable()
      if (dockerOk) {
        try {
          const r = await runInSandbox(command, cwd, sandboxCfg?.image || "node:22-bookworm", timeoutMs ?? 120_000)
          return r.output
        } catch (e) {
          return `[沙箱执行失败：${String((e as Error).message ?? e).slice(0, 120)}，已回退本机执行]\n` + runPowerShell(command, timeoutMs ?? 120_000, cwd)
        }
      }
      return `[沙箱不可用：未检测到 Docker，已在本机 PowerShell 执行]\n` + runPowerShell(command, timeoutMs ?? 120_000, cwd)
    }
    if (background) {
      const id = startBackground(command, cwd)
      const e = bgTasks.get(id)!
      return `[后台任务已启动] id=${id}\n命令=${command}\n日志=${e.logFile}\n用 bg_read(task_id="${id}") 查看输出`
    }
    return runPowerShell(command, timeoutMs ?? 120_000, cwd)
  },
})

export const bgReadTool = tool({
  description: "查看后台任务：不传 task_id 列出全部任务状态（含网关重启前启动的）；传 task_id 读该任务日志尾部。任务还在跑时传 wait=true 挂起等它结束（省去反复轮询）",
  inputSchema: z.object({
    task_id: z.string().optional().describe("后台任务 id，如 bg-1"),
    lines: z.number().optional().describe("读取日志尾部行数，默认 40"),
    wait: z.boolean().optional().describe("任务还在跑时挂起等它结束再返回（默认最多等 120 秒）"),
    waitTimeoutMs: z.number().optional().describe("等待超时毫秒，默认 120000，上限 600000"),
  }),
  async execute({ task_id, lines, wait, waitTimeoutMs }) {
    if (!task_id) {
      // B1：磁盘 ∪ 内存。磁盘里有、内存里没有 = 网关重启前启动的任务——
      // 日志还在，只是本进程不知道它的退出码。**不猜**：进程没标结束就只说「状态未知」，
      // 不写 exitCode 冒充「已结束」（那会让模型以为任务失败了）。
      const seen = new Set<string>()
      const rows: string[] = []
      for (const [id, e] of bgTasks) {
        seen.add(id)
        const dur = Math.round((Date.now() - e.startedAt) / 1000)
        rows.push(`${id} ${e.done ? `已结束(code=${e.exitCode})` : "运行中"} ${dur}s pid=${e.pid} | ${e.command.slice(0, 80)} | ${e.logFile}`)
      }
      for (const r of listBgTasks()) {
        if (seen.has(r.id)) continue
        const dur = Math.round(((r.endedAt ?? Date.now()) - r.startedAt) / 1000)
        const state = r.endedAt !== undefined ? `已结束(code=${r.exitCode ?? "?"})` : "状态未知（网关重启过，进程可能仍在运行）"
        rows.push(`${r.id} ${state} ${dur}s pid=${r.pid} | ${r.command.slice(0, 80)} | ${r.logFile}`)
      }
      rows.sort((a, b) => {
        const ia = /^bg-(\d+)/.exec(a), ib = /^bg-(\d+)/.exec(b)
        return Number(ib?.[1] ?? 0) - Number(ia?.[1] ?? 0)
      })
      return rows.length ? rows.join("\n") : "暂无后台任务"
    }
    const e = bgTasks.get(task_id)
    // T95：wait 模式——任务还在跑就挂起等退出事件（超时/abort 也会醒，醒来后走正常读取，
    // 运行中就如实报运行中）。只对内存里有的任务生效：网关重启过的磁盘记录进程不在手上，等不了。
    if (wait && e && !e.done) {
      const timeoutMs = Math.min(Math.max(waitTimeoutMs ?? 120_000, 1000), 600_000)
      const signal = toolCtx.getStore()?.signal
      await new Promise<void>((resolve) => {
        const w: { done: boolean } = { done: false }
        const arr = bgWaiters.get(task_id) ?? []
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (): void => {
          if (w.done) return
          w.done = true
          if (timer) clearTimeout(timer)
          const cur = bgWaiters.get(task_id)
          if (cur) {
            const i = cur.indexOf(finish)
            if (i >= 0) cur.splice(i, 1)
            if (!cur.length) bgWaiters.delete(task_id)
          }
          resolve()
        }
        timer = setTimeout(finish, timeoutMs)
        arr.push(finish)
        bgWaiters.set(task_id, arr)
        signal?.addEventListener("abort", finish, { once: true })
      })
    }
    // task_id 是模型给的输入——不合法就直接当「没这个任务」，绝不拿它拼路径
    const rec = getBgTask(task_id)
    const logFile = e?.logFile ?? rec?.logFile ?? bgLogPath(task_id)
    if (!logFile || !existsSync(logFile)) {
      // 日志不在就分两种说：有记录=任务跑过但日志被清了；没记录=这个 id 从没存在过
      return rec
        ? `未找到任务 ${task_id} 的日志（日志保留 7 天 / 最近 ${BG_LOG_KEEP} 个，可能已被清理）`
        : `未找到任务 ${task_id}（用 bg_read 不带参数列出全部）`
    }
    const all = readFileSync(logFile, "utf8").split(/\r?\n/)
    const tail = all.slice(-(lines ?? 40)).join("\n")
    const done = e ? (e.done ? `已结束(code=${e.exitCode})` : "运行中") : (rec?.endedAt !== undefined ? "已结束" : "状态未知（网关重启过）")
    return `[${task_id}] ${done}\n${truncate(tail) || "(无输出)"}`
  },
})

/** T91 读文件护栏：超过这个大小不再整读（避免一个几百 MB 的日志把进程撑爆） */
const MAX_READ_BYTES = 8 * 1024 * 1024

/** 只读文件头部固定长度（不把整个文件读进内存） */
function readHead(p: string, bytes: number): Buffer {
  const fd = openSync(p, "r")
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

export const readTool = tool({
  description: "读取本地文件内容（文本，UTF-8）。相对路径基于当前工作目录。",
  inputSchema: z.object({
    file_path: z.string().describe("文件路径"),
    offset: z.number().optional().describe("起始行号（1 起）"),
    limit: z.number().optional().describe("最多读取行数，默认 2000"),
  }),
  async execute({ file_path, offset, limit }) {
    const p = resolve(currentCwd(), file_path)
    if (!existsSync(p)) return `文件不存在: ${p}`
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(p)
    } catch (e) {
      return `[失败] 无法访问 ${p}：${(e as Error).message}`
    }
    // T91：目录要明确报错——历史版本直接 readFileSync 会抛 EISDIR，
    // 异常被 AI SDK 收成 tool-error，界面上连结果卡片都不出现，用户只看到步骤卡住
    if (st.isDirectory()) return `[失败] 这是目录不是文件：${p}（用 glob 找文件、grep 搜内容，或 bash 列目录）`
    const oversized = st.size > MAX_READ_BYTES
    let text: string
    try {
      // 超大文件只读前 8MB（走 fd 读固定长度，不整读进内存）：能定位就用 grep，别整读
      const buf = oversized ? readHead(p, MAX_READ_BYTES) : readFileSync(p)
      // 二进制探测：前 8KB 出现 NUL 字节（UTF-16 文本也会命中）——按二进制拒读，避免回一屏乱码
      if (buf.subarray(0, 8192).includes(0)) {
        return `[失败] 疑似二进制文件（含 NUL 字节）：${p}（如确为 UTF-16 文本，请用 bash 转码后再读）`
      }
      text = buf.toString("utf8")
    } catch (e) {
      return `[失败] 读取失败：${(e as Error).message}`
    }
    const lines = text.split(/\r?\n/)
    const start = Math.max(0, (offset ?? 1) - 1)
    const end = Math.min(lines.length, start + (limit ?? 2000))
    const body = lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join("\n")
    const head = oversized ? `[提示] 文件 ${(st.size / 1024 / 1024).toFixed(1)}MB，本次只读取前 8MB；精读请先 grep 定位再配合 offset\n` : ""
    return truncate(head + (body || "(空文件)"))
  },
})

export const writeTool = tool({
  description: "写入文件（覆盖，用于新建或彻底重写）。相对路径基于当前工作目录。",
  inputSchema: z.object({
    file_path: z.string().describe("文件路径"),
    content: z.string().describe("完整文件内容"),
  }),
  async execute({ file_path, content }) {
    const cwd = currentCwd()
    const p = resolve(cwd, file_path)
    const mode = effectivePermission()
    // T90：工作区外的写盘按危险操作处理——历史版本 write/edit 恒传 danger:false，
    // 默认「危险确认」档下往 ~/.yyagent/config.json、系统目录等任意绝对路径静默覆盖都不问一声。
    // 授权按「目录」粒度记：同一目录第二次起免问，不至于逐次确认把正常用起来变成折磨。
    // T93：判定逻辑抽到 permissions.ts 的 gateFileWrite——同一套规则不能有两份
    // （sceneTools 的 xlsx_write/docx_write/imggen/videogen 原来就是因为各写各的才漏掉）。
    const rejection = await gateFileWrite({
      tool: "write",
      target: p,
      cwd,
      mode,
      broker: toolCtx.getStore()?.broker,
      sessionId: toolCtx.getStore()?.sessionId,
    })
    if (rejection) return rejection
    // D6 撤销支持：写盘前采集快照（write 新建 = snapshot null，撤销时删除）
    trackFileChange(toolCtx.getStore()?.sessionId, p, "write")
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content, "utf8")
    return `已写入 ${p}（${content.length} 字符）`
  },
})

export const editTool = tool({
  description: "精确字符串替换编辑文件（patch 式，不要全量重写）。old_string 必须与文件内容完全一致。相对路径基于当前工作目录。",
  inputSchema: z.object({
    file_path: z.string().describe("文件路径"),
    old_string: z.string().describe("要替换的原文（必须唯一，或用 replace_all）"),
    new_string: z.string().describe("替换后的内容"),
    replace_all: z.boolean().optional().describe("替换所有匹配，默认只替换第一处"),
  }),
  async execute({ file_path, old_string, new_string, replace_all }) {
    const cwd = currentCwd()
    const p = resolve(cwd, file_path)
    const mode = effectivePermission()
    // T90：同 write —— 工作区外的编辑按危险操作处理，授权按目录粒度记
    // T93：走 gateFileWrite（与 write、sceneTools 共用同一套判定）
    const rejection = await gateFileWrite({
      tool: "edit",
      target: p,
      cwd,
      mode,
      broker: toolCtx.getStore()?.broker,
      sessionId: toolCtx.getStore()?.sessionId,
    })
    if (rejection) return rejection
    if (!existsSync(p)) return `文件不存在: ${p}`
    const content = readFileSync(p, "utf8")
    const count = content.split(old_string).length - 1
    if (count === 0) return "错误：old_string 在文件中未找到"
    if (count > 1 && !replace_all) return `错误：old_string 出现 ${count} 次，请提供更多上下文或设 replace_all=true`
    // D6 撤销支持：写盘前采集改前快照
    trackFileChange(toolCtx.getStore()?.sessionId, p, "edit")
    const next = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string)
    writeFileSync(p, next, "utf8")
    return `已编辑 ${p}（替换 ${replace_all ? count : 1} 处）`
  },
})

export const globTool = tool({
  description: "按 glob 模式查找文件",
  inputSchema: z.object({
    pattern: z.string().describe("glob 模式，如 src/**/*.ts"),
    path: z.string().optional().describe("搜索根目录，默认当前工作目录"),
  }),
  async execute({ pattern, path }) {
    const cwd = resolve(currentCwd(), path ?? ".")
    const files = await fg(pattern, { cwd, dot: true, ignore: ["**/node_modules/**", "**/.git/**"] })
    return truncate(files.slice(0, 500).join("\n") || "无匹配文件")
  },
})

export const grepTool = tool({
  description: "按正则在文件内容中搜索（类似 grep）",
  inputSchema: z.object({
    pattern: z.string().describe("正则表达式"),
    path: z.string().optional().describe("搜索根目录，默认当前工作目录"),
    include: z.string().optional().describe("文件 glob 过滤，如 *.ts"),
  }),
  async execute({ pattern, path, include }) {
    const cwd = resolve(currentCwd(), path ?? ".")
    let files = await fg(include ?? "**/*", { cwd, dot: true, ignore: ["**/node_modules/**", "**/.git/**"], onlyFiles: true })
    let re: RegExp
    try {
      re = new RegExp(pattern, "i")
    } catch (e) {
      return `无效正则: ${(e as Error).message}`
    }
    const hits: string[] = []
    for (const f of files) {
      try {
        if (statSync(join(cwd, f)).size > 2_000_000) continue
        const lines = readFileSync(join(cwd, f), "utf8").split(/\r?\n/)
        lines.forEach((line, i) => {
          if (hits.length < 200 && re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 300)}`)
        })
      } catch {
        /* 跳过不可读文件 */
      }
      if (hits.length >= 200) break
    }
    return hits.length ? hits.join("\n") : `无匹配（扫描 ${files.length} 个文件）`
  },
})

export const webfetchTool = tool({
  description: "抓取网页内容并转为纯文本",
  inputSchema: z.object({
    url: z.string().describe("完整 URL"),
  }),
  async execute({ url }) {
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) })
      const html = await res.text()
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim()
      return truncate(text)
    } catch (e) {
      return `[抓取失败: ${(e as Error).message}]`
    }
  },
})

export const websearchTool = tool({
  description: "网页搜索（免 key，自动多源回退）。返回标题/链接/摘要列表；需要网页全文时再用 webfetch 抓具体链接",
  inputSchema: z.object({
    query: z.string().describe("搜索关键词"),
    max_results: z.number().optional().describe("结果数量，默认 6"),
  }),
  async execute({ query, max_results }) {
    const n = max_results ?? 6
    // P1-9 搜索引擎可设置（设置页选择，默认必应），另一来源自动兜底
    const prefer = (loadConfig().searchEngine ?? "bing") as "bing" | "duckduckgo" | "baidu"
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }

    async function tryBing(): Promise<string | null> {
      try {
        const res = await fetch(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-hans&count=${n}`, {
          headers,
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        })
        const html = await res.text()
        const out: string[] = []
        const re = /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/g
        const pRe = /<li class="b_algo"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g
        const paras: string[] = []
        let pm: RegExpExecArray | null
        while ((pm = pRe.exec(html))) paras.push(stripTags(pm[1]).slice(0, 200))
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) && out.length < n) {
          const snippet = paras[out.length] ?? ""
          out.push(`${out.length + 1}. ${stripTags(m[2])}\n   ${m[1]}\n   ${snippet}`)
        }
        return out.length ? out.join("\n\n") : null
      } catch {
        return null
      }
    }

    async function tryDdg(): Promise<string | null> {
      for (const base of ["https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/"]) {
        try {
          const res = await fetch(`${base}?q=${encodeURIComponent(query)}`, { headers, redirect: "follow", signal: AbortSignal.timeout(20_000) })
          const html = await res.text()
          const out: string[] = []
          const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
          const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
          const snippets: string[] = []
          let sm: RegExpExecArray | null
          while ((sm = snipRe.exec(html))) snippets.push(stripTags(sm[1]))
          let m: RegExpExecArray | null
          let i = 0
          while ((m = re.exec(html)) && out.length < n) {
            let href = m[1]
            const uddg = href.match(/uddg=([^&]+)/)
            if (uddg) href = decodeURIComponent(uddg[1])
            out.push(`${i + 1}. ${stripTags(m[2])}\n   ${href}\n   ${snippets[i] ?? ""}`)
            i++
          }
          if (out.length) return out.join("\n\n")
        } catch {
          /* 下一个镜像 */
        }
      }
      return null
    }

    async function tryBaidu(): Promise<string | null> {
      try {
        const res = await fetch(`https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${n}`, {
          headers,
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        })
        const html = await res.text()
        const out: string[] = []
        // 百度结果容器：h3 > a（真实链接在 mu 属性或需解析），摘要 content-right
        const re = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/g
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) && out.length < n) {
          out.push(`${out.length + 1}. ${stripTags(m[2])}\n   ${m[1]}`)
        }
        return out.length ? out.join("\n\n") : null
      } catch {
        return null
      }
    }

    // 用户偏好的引擎优先，其余兜底（bing 默认第一位）
    const all: Record<string, () => Promise<string | null>> = { bing: tryBing, duckduckgo: tryDdg, baidu: tryBaidu }
    const order: Array<() => Promise<string | null>> = [
      all[prefer] ?? tryBing,
      ...Object.entries(all).filter(([k]) => k !== prefer).map(([, v]) => v),
    ]
    for (const attempt of order) {
      const r = await attempt()
      if (r) return r
    }
    return "[搜索失败] 全部搜索源不可达。可设置 HTTPS_PROXY 环境变量后重试，或改用 webfetch 直接抓取已知 URL。"
  },
})

// ---------- P1-10 场景数据库工具 ----------

export const dbSaveTool = tool({
  description:
    "把持久信息写入场景数据库（~/.yyagent/db/，跨会话永久保存；库名与字段见系统提示词「场景数据库」节）。用户说「记一下/存到库里/记住这个联系人」时使用。返回带 id，可用于更新或删除。",
  inputSchema: z.object({
    db: z.string().describe("库名：notes / contacts / knowledge"),
    record: z.record(z.string(), z.unknown()).describe("记录字段对象，如 {title, content}；带 id 表示更新已有记录"),
    tags: z.array(z.string()).optional().describe("可选标签，便于检索"),
  }),
  async execute({ db, record, tags }) {
    if (!BUILTIN_DBS[db] && !listDbs().some((d) => d.name === db)) {
      return `[失败] 未知数据库：${db}（可用：${Object.keys(BUILTIN_DBS).join(" / ")}）`
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) return "[失败] record 必须是字段对象"
    const saved = upsertDbRecord(db, { ...(record as Record<string, unknown>), ...(tags?.length ? { tags } : {}) })
    return `[已保存] ${db} 库记录 id=${saved.id}（更新时引用此 id）`
  },
})

export const dbQueryTool = tool({
  description:
    "从场景数据库检索持久信息（跨会话）。notes=笔记、contacts=联系人·搭子、knowledge=知识片段。关键词全文匹配，也可按标签过滤；带 id 参数取单条。",
  inputSchema: z.object({
    db: z.string().describe("库名：notes / contacts / knowledge"),
    q: z.string().optional().describe("关键词（全文匹配，空=全部）"),
    tag: z.string().optional().describe("按标签过滤"),
    id: z.string().optional().describe("精确取某条记录"),
    deleteId: z.string().optional().describe("删除指定 id 的记录"),
  }),
  async execute({ db, q, tag, id, deleteId }) {
    if (!BUILTIN_DBS[db] && !listDbs().some((d) => d.name === db)) {
      return `[失败] 未知数据库：${db}（可用：${Object.keys(BUILTIN_DBS).join(" / ")}）`
    }
    if (deleteId) {
      const ok = deleteDbRecord(db, deleteId)
      return ok ? `[已删除] ${db} 库记录 ${deleteId}` : `[失败] 记录不存在：${deleteId}`
    }
    let records = queryDb(db, q, tag)
    if (id) records = records.filter((r) => r.id === id)
    if (!records.length) return `[空] ${db} 库没有匹配记录`
    return JSON.stringify(records.slice(0, 50), null, 2)
  },
})

// ---------- 多智能体 ----------

/**
 * T93 P3：子代理结果的收口。
 *
 * 用满步数上限时**必须说清是截断**——否则主代理会把半截结果当成结论，
 * 于是要么基于不完整的信息继续跑，要么反复重派同一个任务。
 * 抽成纯函数是为了能单测（这段文案是给模型看的，写错字的代价是它理解错）。
 */
export function subagentResult(text: string, steps: number, cap: number): string {
  const body = (text ?? "").trim()
  if (steps < cap || cap <= 0) return body || "（子任务没有产出内容）"
  return (
    `${body || "（子任务没有产出内容）"}\n\n---\n` +
    `[注意] 子任务已用完全部 ${cap} 步上限而停止，上面的内容**可能不完整**，` +
    `不要把它当作最终结论。可把任务拆小后重派，或调大 config.subagentMaxSteps（当前 ${cap}）。`
  )
}

export const delegateTool = tool({
  description:
    "把独立子任务派发给专家子智能体并行执行。可用角色：researcher（研究）、explore（只读探索）、coder（编码）、reviewer（审查），以及 ~/.yyagent/agents/ 下的自定义角色。一次回复中可发多个 delegate 调用实现并行。子智能体只回传结论，不占主上下文。",
  inputSchema: z.object({
    persona: z.string().describe("角色名"),
    task: z.string().describe("子任务完整描述，必须自包含（子智能体看不到主对话）"),
  }),
  async execute({ persona, task }) {
    const { getPersona } = await import("./personas.js")
    const { runAgent } = await import("./loop.js")
    const p = await getPersona(persona)
    if (!p) {
      const names = (await (await import("./personas.js")).listPersonas()).map((x) => x.name).join(", ")
      return `[失败] 未知角色: ${persona}（可用角色：${names}）`
    }
    const base = makeTools({})
    const tools = p.tools?.length
      ? ({ ...Object.fromEntries(p.tools.map((t) => [t, base[t]]).filter(([, v]) => v)), ...memoryTools(), ...makeTodoTool() } as Record<string, Tool>)
      : base
    // T93：子代理原来只拿到 cwd —— 主循环 abort 后它照跑、它的权限确认问不到人、
    // todo_write 还会落到全局 ~/.yyagent/todo.json 污染别的会话。四项上下文一起透传。
    const store = toolCtx.getStore()
    // T93 P3：步数上限原来硬编码 30，而主代理是 config.maxSteps ?? 50——
    // 子任务更容易被截断，且截断后**静默**返回：主代理分不清它是做不完还是做错了。
    // 现在可配（默认仍 30，不改变现状），且用满时明确标注。
    const cap = loadConfig().subagentMaxSteps ?? 30
    try {
      const r = await runAgent(task, {
        system: p.system,
        tools,
        maxSteps: cap,
        cwd: currentCwd(),
        signal: store?.signal,
        sessionId: store?.sessionId,
        broker: store?.broker,
        // T97：子代理每步进度顶到主对话状态行（带角色名与步数上限）。
        // statusSink 来自主回合的 toolCtx——子代理自己的工具跑在自己嵌套的 ctx 里，不会串台
        onStep: (info) =>
          store?.statusSink?.(`[子代理 ${persona}] 第 ${info.step}/${info.maxSteps} 步${info.tools.length ? "：" + info.tools.join(",") : ""}`),
      })
      return subagentResult(r.text, r.steps, cap)
    } catch (e) {
      return `[子任务失败] ${(e as Error).message}`
    }
  },
})

// ---------- 工具集组装 ----------

export interface ToolOptions {
  allowDelegate?: boolean
  readonly?: boolean
}

export function makeTools(opts: ToolOptions = {}): Record<string, Tool> {
  const t: Record<string, Tool> = {}
  if (!opts.readonly) {
    t.bash = bashTool
    t.write = writeTool
    t.edit = editTool
    // T44 桌面操控：截屏识图 / 移动鼠标 / 点击 / 输入 / 按键 / 滚动 / 聚焦窗口
    // 走工厂注入，让 computer 模块按当前会话权限档位提问（避免 tools ↔ computer 循环依赖）
    // T90：补 sessionId——桌面操控按会话授权一次（见 computer.ts 的 grantScope）
    t.computer = makeComputerTool({
      permission: effectivePermission,
      broker: () => toolCtx.getStore()?.broker,
      sessionId: () => toolCtx.getStore()?.sessionId,
    })
  }
  t.read = readTool
  t.glob = globTool
  t.grep = grepTool
  t.webfetch = webfetchTool
  t.websearch = websearchTool
  t.bg_read = bgReadTool
  Object.assign(t, memoryTools() as Record<string, Tool>)
  // T47 过往对话检索：conversation_search / recent_chats / read_conversation（只读，见 pastchats.ts）
  Object.assign(t, pastChatTools() as Record<string, Tool>)
  Object.assign(t, makeTodoTool() as Record<string, Tool>)
  Object.assign(t, makeAskTool() as Record<string, Tool>)
  t.db_save = dbSaveTool
  t.db_query = dbQueryTool
  Object.assign(t, taskTools())
  Object.assign(t, sceneTools())
  if (opts.allowDelegate) t.delegate = delegateTool
  // T66 钩子：包装每个工具——执行完后跑启用的钩子检查（每完成一步检查一次），不通过则把
  // 修正提示追加进工具结果（模型下一步自纠）。runHooksOnTool fail-open，钩子出错不阻断主流程。
  // T89 输出卸载（对标 deepagents context offloading）：超长工具输出落盘 .agent-outputs/，
  // 上下文只留前 800 字符 + 文件句柄——长任务不再被巨量输出撑爆上下文。read/bg_read 除外
  // （read 的输出就是模型要的内容，卸载了等于让它原地再读一遍死循环）。
  const OFFLOAD_EXCLUDE = new Set(["read", "bg_read"])
  const OFFLOAD_CHARS = 3000
  for (const k of Object.keys(t)) {
    const tool = t[k]
    if (typeof tool.execute !== "function") continue
    const orig = tool.execute.bind(tool)
    t[k] = {
      ...tool,
      execute: async (input: never, options: never) => {
        let out = await orig(input, options)
        try {
          out = await runHooksOnTool(k, out as string)
        } catch { /* 钩子失败保留原输出 */ }
        try {
          if (typeof out === "string" && out.length > OFFLOAD_CHARS && !OFFLOAD_EXCLUDE.has(k)) {
            const c = toolCtx.getStore()?.cwd
            if (c) {
              const dir = join(c, ".agent-outputs")
              mkdirSync(dir, { recursive: true })
              const f = join(dir, `${Date.now()}-${k}.txt`)
              writeFileSync(f, out)
              out = out.slice(0, 800) + `\n\n[输出过长已卸载：完整内容（${out.length} 字符）存于 ${f}，需要时用 read 工具读取]`
            }
          }
        } catch { /* 卸载失败原样返回 */ }
        return out
      },
    } as typeof tool
  }
  return t
}
