/**
 * Yy Sustainer 引擎网关：HTTP + WebSocket，给桌面客户端（Electron/Tauri/浏览器）用。
 * - 引擎零改动：复用 runAgentStream / QuestionBroker / session store / config / todo
 * - 只监听 127.0.0.1（本机客户端）
 * - 静态托管 web/（客户端页面）
 * - 同一时刻一个活跃流式任务；进行中收到的新消息进队列，当前任务结束自动续跑（对齐 TUI 排队语义）
 *
 * REST:
 *   GET    /api/sessions                 会话列表
 *   POST   /api/sessions                 {title?} 新建
 *   GET    /api/sessions/:id             {meta, messages}
 *   DELETE /api/sessions/:id             删除
 *   POST   /api/sessions/:id/rename      {title}
 *   GET    /api/state                    {config(脱敏), models, busy, queue, question, todo}
 *   POST   /api/model                    {model, sessionId?} 切模型（会话级：写入该会话 override；无 sessionId = 默认模型）
 *   POST   /api/chat                     {sessionId, text, imagesBase64?} 发送（忙则入队）
 *   POST   /api/stop                     中断当前任务（队列保留）
 *   DELETE /api/queue                    清空队列
 *   POST   /api/queue/send               {id} 排队消息立即发送（空闲则立刻执行，忙则提前到队首）
 *   POST   /api/queue/edit               {id, content?} 排队消息编辑（content 缺省 = 仅出队取回，前端放回输入框）
 *   DELETE /api/queue/item               {id} 删除单条排队消息
 *   POST   /api/messages/recall          {sessionId, ts} 撤回：停止模型 + 删除该消息及之后全部
 *   POST   /api/messages/edit            {sessionId, ts, content} 编辑：停止模型 + 截断 + 替换内容并重新发送
 *   POST   /api/messages/takeback        {sessionId, ts} 取回编辑：停止模型 + 截断 + 原文返回（前端放回输入框，不自动重发）
 *   GET    /api/tasks                    定时任务列表（含最近一次结果）
 *   POST   /api/tasks/create             {name,cron,prompt,cwd?,timeoutMs?} 新建（写配置 + 即时调度）
 *   POST   /api/tasks/update             {name,cron?,prompt?,cwd?,timeoutMs?} 修改
 *   POST   /api/tasks/delete             {name} 删除
 *   POST   /api/tasks/toggle             {name} 启用/停用
 *   POST   /api/tasks/run                {name} 立即运行
 *   POST   /api/export/xlsx              {name?,sheet?,rows:[[...]]} 把表格导出为 xlsx（exceljs），直接回二进制
 * WS（推送）:
 *   {type:"text",delta} {type:"status",text} {type:"tool",...} {type:"question",q}
 *   {type:"busy",busy} {type:"message",sessionId,message} {type:"queue",items}
 *   {type:"error",message} {type:"retry",info}
 */
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import childProcess from "node:child_process"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { WebSocketServer, WebSocket } from "ws"
import { runAgentStream, compactNow, type AgentResult } from "./agent/loop.js"
import { describeFailure, retryBudget } from "./agent/errors.js"
import { setSessionPermission, deleteSessionPermission, getSessionPermission } from "./agent/tools.js"
import { QuestionBroker } from "./agent/ask.js"
import { loadConfig, saveConfig, setDefaultModel, resolveModel, addModelToProvider } from "./agent/config.js"
// P-1 发行版：本地免费模型（Ollama）一键下载 / 检测 / 写 provider
import { ollamaStatus, ensureOllamaRunning, pullModel, wireOllamaProvider, MODEL_CHOICES } from "./agent/ollama.js"
import {
  createSession,
  listSessions,
  loadSession,
  persist,
  deleteSession,
  toCoreMessages,
  truncateFrom,
  type StoredMessage,
} from "./session/store.js"
import { readTodo, deleteTodo } from "./agent/todo.js"
// T45 用量账本：逐轮 token 消耗落一份 append-only 明细，供热力图 / 环形图按日按模型聚合
import { appendUsage, backfillUsage, usageDaily, usageByModel, pruneUsage } from "./session/usage.js"
import { beginFileTracking, takeFileEdits } from "./agent/fileTrack.js"
import { listDbs, getDb, upsertDbRecord, deleteDbRecord, queryDb, isValidDbName, BUILTIN_DBS } from "./agent/db.js"
import { countTokens } from "gpt-tokenizer"
import cronLib from "node-cron"
import type { FileEdit } from "./agent/fileTrack.js"

// D6 撤销快照池：sessionId -> (assistantMsgTs -> 本轮文件快照)；撤销 = 按快照恢复/删除文件
const undoSnapshots = new Map<string, Map<number, FileEdit[]>>()

const PORT = Number(process.env.YYAGENT_GATEWAY_PORT ?? 8642)
// P2-4 分享：默认 0.0.0.0（局域网可访问 /api/file 分享链接）；YYAGENT_HOST 可收回本机
const HOST = process.env.YYAGENT_HOST ?? "0.0.0.0"
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIR = path.join(__dirname, "..", "web")
// P-1 发行版可写性：包内 logs 目录在打包后位于**只读的 asar** 里，往里写会抛 EROFS/EPERM。
// 而 history.jsonl 的写入点在定时任务的**成功分支**上（runDaemonTask），一旦抛错就会跳进 catch，
// catch 里那句 appendFileSync 再抛一次 → 任务结果整个丢掉、完成通知也发不出去。
// 所以这里探一次可知可写：优先包内 logs（开发态 / 便携版照旧），不可写就退到 ~/.yyagent/logs。
const LOGS_DIR = (() => {
  const candidates = [path.join(__dirname, "..", "logs"), path.join(homedir(), ".yyagent", "logs")]
  for (const d of candidates) {
    try {
      fs.mkdirSync(d, { recursive: true })
      fs.appendFileSync(path.join(d, ".write-probe"), "") // 真写一次才算数（accessSync 在 Windows 上不可靠）
      fs.rmSync(path.join(d, ".write-probe"), { force: true })
      return d
    } catch { /* 试下一个 */ }
  }
  return candidates[candidates.length - 1]
})()

// ---- 全局运行状态 ----
// TUI 功能会话标题（不可删除）。历史数据是「⚙ 模型配置」，UI 去 emoji 后新数据为「模型配置」——用 endsWith 兼容两者
const CONFIG_TITLE = "模型配置"
const isConfigSession = (title: string | undefined) => typeof title === "string" && title.endsWith(CONFIG_TITLE)
// R4 会话独立发送：busy/abort/queue 全部按会话隔离——每个对话有自己的发送按钮（A 会话跑任务，B 会话可以立即发）
const sessionBusy = new Set<string>() // 正在跑任务的会话 id 集合
const sessionAborts = new Map<string, AbortController>() // sessionId → 停止控制器
const sessionQueues = new Map<string, QueueItem[]>() // sessionId → 该会话的排队消息
const brokers = new Map<string, QuestionBroker>() // sessionId → 提问桥（并行会话的问题互不串台）
function brokerOf(sessionId: string): QuestionBroker {
  let b = brokers.get(sessionId)
  if (!b) { b = new QuestionBroker(); brokers.set(sessionId, b) }
  return b
}
const anyBusySessionId = (): string | null => [...sessionBusy][0] ?? null
// F1：前端当前打开的会话（由 /api/state?sid= 上报），statePayload 按它返回会话级模型
let stateActiveSid: string | null = null
type QueueItem = { id: number; sessionId: string; text: string; imagesBase64?: string[]; imagesDataUrl?: string[] }
let queueSeq = 0 // 排队条目自增 id（前端「立即发送/编辑」按 id 定位）
const sessionsModelOverride = new Map<string, string>() // 会话级模型（对齐 TUI：会话 model 优先）
const wsClients = new Set<WebSocket>()

function broadcast(msg: Record<string, unknown>): void {
  const s = JSON.stringify(msg)
  for (const c of wsClients) {
    if (c.readyState === WebSocket.OPEN) c.send(s)
  }
}

function calcCtxPct(msgs: Array<{ content: string }>): number {
  try {
    const c = loadConfig()
    const t = countTokens(msgs.map((m) => m.content).join("\n\n"))
    return Math.min(100, Math.round((t / (c.contextTokens ?? 131_072)) * 100))
  } catch {
    return 0
  }
}

// ---- P1-1 定时任务（网关进程内运行 + Windows toast 通知） ----
interface DaemonTask { name: string; cron: string; prompt: string; cwd?: string; model?: string; timeoutMs?: number; enabled?: boolean }
interface TaskRunRec { ok: boolean; ts: number; durationMs?: number; report?: string; error?: string }

function daemonConfigPath(): string {
  return path.join(__dirname, "..", "yyagentd.config.json")
}
function loadDaemonTasks(): DaemonTask[] {
  try {
    return (JSON.parse(fs.readFileSync(daemonConfigPath(), "utf8")).tasks ?? []) as DaemonTask[]
  } catch {
    return []
  }
}
// 自动化界面：写回 yyagentd.config.json 的 tasks（保留其余字段）
function saveDaemonTasks(tasks: DaemonTask[]): void {
  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(fs.readFileSync(daemonConfigPath(), "utf8")) } catch { /* 新文件 */ }
  cfg.tasks = tasks
  fs.writeFileSync(daemonConfigPath(), JSON.stringify(cfg, null, 2) + "\n")
}
// ---- 网关进程内 cron 调度：新建/修改/启停即时生效，无需重启 daemon ----
const cronJobs = new Map<string, ReturnType<typeof cronLib.schedule>>()
function scheduleTask(t: DaemonTask): void {
  unscheduleTask(t.name)
  if (t.enabled === false || !cronLib.validate(t.cron)) return
  const job = cronLib.schedule(t.cron, () => {
    if (taskRunning.has(t.name)) return // 上一次还没跑完，跳过本轮
    void runDaemonTask(t)
  })
  job.start()
  cronJobs.set(t.name, job)
}
function unscheduleTask(name: string): void {
  cronJobs.get(name)?.stop()
  cronJobs.delete(name)
}
function scheduleAllTasks(): void {
  for (const t of loadDaemonTasks()) scheduleTask(t)
  console.log(`[yyagent-gateway] 定时任务已调度: ${[...cronJobs.keys()].join(", ") || "(无)"}`)
}
// history.jsonl 最近一次结果索引（task 名 → 记录）
function lastRunRecs(): Map<string, TaskRunRec> {
  const map = new Map<string, TaskRunRec>()
  try {
    const lines = fs.readFileSync(path.join(LOGS_DIR, "history.jsonl"), "utf8").trimEnd().split(/\r?\n/)
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as TaskRunRec & { task: string }
        if (rec.task) map.set(rec.task, rec)
      } catch { /* 跳过坏行 */ }
    }
  } catch { /* 无历史 */ }
  return map
}
function taskListPayload(): Array<{ name: string; cron: string; enabled: boolean; last: TaskRunRec | null; running: boolean }> {
  const last = lastRunRecs()
  return loadDaemonTasks().map((t) => ({
    name: t.name,
    cron: t.cron,
    enabled: t.enabled !== false,
    last: last.get(t.name) ?? null,
    running: taskRunning.has(t.name),
  }))
}
function toast(title: string, message: string): void {
  try {
    const { spawn } = childProcess
    const ps = path.join(__dirname, "..", "scripts", "toast.ps1")
    spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, "-Title", title, "-Message", message], {
      windowsHide: true,
      stdio: "ignore",
    }).unref()
  } catch { /* 通知失败不影响任务 */ }
}
const taskRunning = new Set<string>()
async function runDaemonTask(t: DaemonTask): Promise<void> {
  taskRunning.add(t.name)
  broadcast({ type: "tasks", tasks: taskListPayload() })
  broadcast({ type: "notice", text: `任务「${t.name}」开始运行` })
  const t0 = Date.now()
  try {
    const { runAgent } = await import("./agent/loop.js")
    const agentConfig = loadConfig()
    const r = await runAgent(t.prompt, {
      model: t.model,
      cwd: t.cwd ?? process.cwd(),
      signal: AbortSignal.timeout(t.timeoutMs ?? agentConfig.taskTimeoutMs ?? 600_000),
    })
    const rec: TaskRunRec = { ok: true, ts: Date.now(), durationMs: Date.now() - t0, report: r.text.slice(0, 2000) }
    fs.appendFileSync(path.join(LOGS_DIR, "history.jsonl"), JSON.stringify({ ts: new Date().toISOString(), task: t.name, ok: true, steps: r.steps, durationMs: rec.durationMs, report: rec.report }) + "\n")
    toast(`Yy Sustainer · ${t.name}`, `任务完成（${r.steps} 步）：${r.text.slice(0, 60)}`)
    broadcast({ type: "notice", text: `✅ 任务「${t.name}」完成（${r.steps} 步）` })
  } catch (e) {
    const msg = (e as Error).message
    fs.appendFileSync(path.join(LOGS_DIR, "history.jsonl"), JSON.stringify({ ts: new Date().toISOString(), task: t.name, ok: false, durationMs: Date.now() - t0, error: msg }) + "\n")
    toast(`Yy Sustainer · ${t.name} 失败`, msg.slice(0, 80))
    broadcast({ type: "notice", text: `❌ 任务「${t.name}」失败：${msg.slice(0, 60)}` })
  } finally {
    taskRunning.delete(t.name)
    broadcast({ type: "tasks", tasks: taskListPayload() })
    const { closeMcpTools } = await import("./mcp/client.js")
    await closeMcpTools()
  }
}

// ---- 核心：跑一个流式任务（对齐 TUI send() 语义：重试、步骤、落盘、错误消息） ----
async function runTurn(sessionId: string, text: string, imagesBase64?: string[], imagesDataUrl?: string[]): Promise<void> {
  const file = loadSession(sessionId)
  if (!file) {
    broadcast({ type: "error", message: `会话不存在: ${sessionId}` })
    return
  }
  const { meta, messages } = file
  const model = sessionsModelOverride.get(sessionId) ?? meta.model ?? loadConfig().model

  // 附件：图片直传（视觉模型）；base64 由客户端给，文本附件已在客户端拼进 text
  const history = toCoreMessages(messages)
  // 落库用可读文本（[IMG:n] 内部标记 → [图片n] 占位，前端渲染成图片小气泡）；
  // 发给引擎的 text 保留标记供 prepare() 解析图文顺序。images 存 dataUrl 供气泡显示。
  const displayText = text.replace(/\[IMG:(\d+)\]/g, (_, i) => `[图片${Number(i) + 1}]`).replace(/[ \t]+/g, " ").trim()
  const userMsg: StoredMessage = { role: "user", content: displayText, ts: Date.now() }
  if (imagesDataUrl?.length) userMsg.images = imagesDataUrl
  const msgsAfterUser = [...messages, userMsg]
  if (meta.title === "新对话" && text) meta.title = displayText.replace(/\s+/g, " ").slice(0, 30)
  meta.updatedAt = Date.now()
  persist(meta, msgsAfterUser)
  broadcast({ type: "message", sessionId, message: userMsg })
  // R4 会话独立：busy 状态按会话记录，其他会话不受影响
  sessionBusy.add(sessionId)
  broadcast({ type: "busy", busy: true, sessionId }) // F4：带 sessionId，侧栏给对应会话加转圈
  broadcast({ type: "status", sessionId, text: "思考中" })

  // D6 文件修改追踪：本轮 write/edit 的文件快照（撤销功能数据源）
  beginFileTracking(sessionId)

  const ac = new AbortController()
  sessionAborts.set(sessionId, ac)
  const steps: Array<{ name: string; argsSummary: string; input?: string; output?: string }> = []
  // 停止后可见：累积流式已吐出的正文——abort 时 result.text 拿不到（Promise 被 reject），只能自己攒
  let streamedText = ""

  let r: AgentResult | null = null
  let aborted = false // 用户主动停止 → 不触发监工质检
  try {
    // 注意：重试计数只在 catch 里自增（原来 for 头的 attempt++ 会和 catch 里的重复自增，
    // 导致计数跳 1/3/5/7/9，实际只能重发 6 次却显示到 10——顺手修掉）
    for (let attempt = 0; ; ) {
      try {
        r = await runAgentStream(
          text,
          {
            model,
            history,
            cwd: meta.cwd,
            broker: brokerOf(sessionId),
            signal: ac.signal,
            images: imagesBase64?.length ? imagesBase64 : undefined,
            sessionId,
            systemSuffix: [envScanPrompt(meta.cwd), feedbackPrompt(messages)].filter(Boolean).join("\n\n"),
          },
          {
            onText: (d) => {
              streamedText += d
              broadcast({ type: "text", sessionId, delta: d })
            },
            onStatus: (s) => broadcast({ type: "status", sessionId, text: s }),
            // R1：压缩过程可见——开始广播「压缩中」，完成广播「压缩完成 N 条 → M 条」
            onCompact: (phase, info) =>
              broadcast({
                type: "status",
                sessionId,
                text: phase === "start" ? "压缩中：整理历史上下文…" : `压缩完成：${info?.before ?? "?"} 条 → ${info?.after ?? "?"} 条`,
              }),
            onToolEvent: (ev) => {
              if (ev.type === "call") {
                const input = ev.input ? JSON.stringify(ev.input, null, 2).slice(0, 3000) : undefined
                const argsSummary = ev.input
                  ? JSON.stringify(ev.input).replace(/["{}]/g, "").slice(0, 80)
                  : ""
                steps.push({ name: ev.name, argsSummary, input, output: undefined })
              } else {
                const output = (() => {
                  const o = ev.output
                  if (o == null) return "(无输出)"
                  if (typeof o === "string") return o
                  try {
                    return JSON.stringify(o, null, 2)
                  } catch {
                    return String(o)
                  }
                })().slice(0, 5000)
                const i = steps.findIndex((s) => s.name === ev.name && s.output === undefined)
                if (i >= 0) steps[i] = { ...steps[i], output }
              }
              broadcast({ type: "tool", sessionId, kind: ev.type, toolCallId: ev.toolCallId, name: ev.name, input: ev.input, output: ev.output })
            },
          },
        )
        break
      } catch (e) {
        const info = describeFailure(e)
        // 用户主动停止 / 引擎收敛：不重发，直接上抛交给下面统一落库
        if (info.kind === "abort") throw e
        attempt++
        // T74：不再用 /rate/ 猜限流——"gene·rate·d" 正好命中它，导致 401/402/404 这类
        // 绝不该重试的错误被白重发 10 次、每次还等十几秒，用户干等到天荒地老。
        // 现在按 statusCode + 网络错误码分类，预算 0 的立刻把真实原因摆出来。
        const budget = retryBudget(info.kind)
        if (budget === 0 || attempt > budget) throw e
        const waitMs = Math.min(20_000, 1500 * Math.pow(2, attempt - 1))
        const text = `⚠ API 出错，自动重发中 (${attempt}/${budget})：${info.message.slice(0, 110)}`
        broadcast({ type: "retry", sessionId, attempt, maxRetry: budget, info: text, waitMs })
        await new Promise((res) => setTimeout(res, waitMs))
      }
    }
    const pct = calcCtxPct([...msgsAfterUser, { content: r?.text ?? "" }])
    meta.ctxPct = pct
    meta.updatedAt = Date.now()
    // token 消耗累计（deepseek 风格：输入/输出/缓存命中 + 轮数/步数），随 meta 落库
    const u = meta.usage ?? { in: 0, out: 0, cached: 0, turns: 0, steps: 0 }
    meta.usage = {
      in: u.in + (r?.usage?.in ?? 0),
      out: u.out + (r?.usage?.out ?? 0),
      cached: u.cached + (r?.usage?.cached ?? 0),
      turns: u.turns + 1,
      steps: u.steps + (r?.steps ?? 0),
    }
    // T45：同一轮同时落一份明细到用量账本（用本轮**实际**模型，不是会话默认模型——
    // 会话中途换过模型时，环形图必须按真实使用归因）
    appendUsage({
      ts: Date.now(),
      sessionId,
      model: r?.model ?? model ?? "（未知模型）",
      in: r?.usage?.in ?? 0,
      out: r?.usage?.out ?? 0,
      cached: r?.usage?.cached ?? 0,
      steps: r?.steps ?? 0,
    })
    const assistantMsg: StoredMessage = {
      role: "assistant",
      // abort 早返回时 r.text 为空——用 streamedText 兜底（用户已看到的流式正文不能丢）
      content: (r?.text || streamedText || "").trim() || "（已停止，未输出内容）",
      ts: Date.now(),
      model: r?.model ?? model,
      steps: steps.map((s) => ({ ...s })),
    }
    // D6：本轮模型实际改动的文件（含快照）挂到 assistant 消息上——前端显示「修改 N 个文件 + 撤销」
    const fileEdits = takeFileEdits(sessionId)
    if (fileEdits.length) {
      assistantMsg.fileEdits = fileEdits.map((f) => ({ path: f.path, kind: f.kind }))
      // 快照留在内存供撤销（key = assistant 消息 ts；每会话最多留 10 轮，防止无限膨胀）
      const per = undoSnapshots.get(sessionId) ?? new Map<number, typeof fileEdits>()
      per.set(assistantMsg.ts, fileEdits)
      while (per.size > 10) per.delete(Math.min(...per.keys()))
      undoSnapshots.set(sessionId, per)
    }
    const finalMsgs = [...msgsAfterUser, assistantMsg]
    persist(meta, finalMsgs)
    broadcast({ type: "message", sessionId, message: assistantMsg, ctxPct: pct, usage: meta.usage })
  } catch (e) {
    const err = e as Error
    const dinfo = describeFailure(e)
    // T74：判「是否用户主动停止」不再靠 message 里有没有 "abort"/"No output generated"。
    // 现在真实错误会带着真是原因上来（HTTP 401 / 余额不足 / 连接被拒绝…），
    // 再拿文案去猜，就会把「key 错了」也当「已停止」静默吞掉。
    aborted = dinfo.kind === "abort"
    if (!aborted) {
      // T66：上游一张口都没开（没有状态码、没有根因、也没有任何已流出内容）——
      // 给它一句人话，而不是把 AI SDK 的英文抛栈甩给用户
      const silent = dinfo.kind === "unknown" && !streamedText.trim() && !steps.length
      // T74：若是「吐了一半才崩」，已流出的正文只存在于即将被销毁的流式气泡里，
      // 不带上就等于白等一场——所以把半截正文一起落库，后面跟真实原因。
      const partial = streamedText.trim()
      const content = silent
        ? "思考失败：模型没有返回任何内容。可点击重新生成，或换个说法重试。"
        : partial
          ? `${partial}\n\n---\n[出错] 输出中断：${err.message}`
          : `[出错] ${err.message}`
      const errMsg: StoredMessage = { role: "assistant", content, ts: Date.now(), model }
      persist(meta, [...msgsAfterUser, errMsg])
      broadcast({ type: "message", sessionId, message: errMsg })
      broadcast({ type: "error", sessionId, message: err.message })
      takeFileEdits(sessionId) // 出错丢弃快照（abort 也走这里）
    } else {
      broadcast({ type: "notice", sessionId, text: "已停止" })
      // 停止也落库：已流出的正文 + 已执行的工具步骤都保留（原来正文丢失只剩「（已停止）」，纯思考无步骤时甚至整条不落库）
      const stopText = (r?.text || streamedText || "").trim()
      const stopMsg: StoredMessage = {
        role: "assistant",
        content: stopText || "（已停止，未输出内容）",
        ts: Date.now(),
        model,
        steps: steps.map((s) => ({ ...s })),
      }
      persist(meta, [...msgsAfterUser, stopMsg])
      broadcast({ type: "message", sessionId, message: stopMsg, ctxPct: meta.ctxPct, usage: meta.usage })
    }
  } finally {
    // R4 会话独立：只清理本会话的状态，其他会话照常跑
    sessionBusy.delete(sessionId)
    sessionAborts.delete(sessionId)
    broadcast({ type: "busy", busy: false, sessionId }) // F4：带 sessionId，前端收掉对应会话的转圈
    broadcast({ type: "status", sessionId, text: "" })
    // 监工模式（config.watch，与 TUI 一致）：主任务完成后自动调辅助对话检查，    // 辅助发现的遗漏/新需求经 SEND 协议自动回主对话队列执行
    if (!aborted && r?.text && loadConfig().watch) void assistReviewTurn(text, r.text, sessionId)
  }
}

// 主任务完成后 → 辅助对话质检（只读）；发现问题输出 SEND 行，enqueueFromAssist 自动回主对话
// T14：监工聊天以「主对话 ↔ 辅助对话」形式直接呈现在辅助对话输出框里——
// 监工先拿到主对话的任务与报告（role="monitor" = 主对话侧的发言），辅助对话的检查结论紧随其后
async function assistReviewTurn(userTask: string, report: string, sessionId?: string): Promise<void> {
  try {
    const sid = sessionId ?? lastSessionId()
    if (!sid) return
    // 监工聊天开头：主对话侧发言（任务 + 完成报告摘要）进入辅助对话输出框
    const mainMsg: AssistMsg = { role: "monitor", content: `[主对话] 任务：${userTask.slice(0, 300)}\n完成报告：${report.slice(0, 600)}`, ts: Date.now() }
    const h0 = assistHistoryOf(sid)
    h0.push(mainMsg)
    broadcast({ type: "assist", kind: "message", sessionId: sid, message: mainMsg })
    const { runAgent } = await import("./agent/loop.js")
    const res = await runAgent(
      `你是任务质检员（只读检查，不要修改任何文件）。上面是主对话刚完成的任务与报告。\n\n检查：1) 需求是否完整完成 2) 有无遗漏或错误 3) 用户接下来可能需要什么。若发现问题或有明确的后续步骤，输出一行以 "SEND: " 开头的消息（将自动发给主对话执行）；一切正常无需跟进则只输出 OK。`,
      {
        model: loadConfig().model,
        cwd: loadSession(sid)?.meta.cwd ?? lastSessionCwd(),
        system: "你是 Yy Sustainer 的监工/质检子智能体。只读检查，绝不修改文件。发现遗漏或后续需求时，输出一行以 SEND: 开头的精简指令（将自动发给主对话执行）；无问题只输出 OK。",
        maxSteps: 12,
      },
    )
    // 质检结论显示在该会话的辅助对话面板（含 SEND 指令的解析入队）
    const aMsg: AssistMsg = { role: "assistant", content: `[监工质检] ${res.text}`, ts: Date.now() }
    const h = assistHistoryOf(sid)
    h.push(aMsg)
    if (h.length > 60) assistHistories.set(sid!, h.slice(-60))
    broadcast({ type: "assist", kind: "message", sessionId: sid, message: aMsg })
    enqueueFromAssist(res.text, sid)
  } catch {
    /* 监工失败静默 */
  }
}

function lastSessionCwd(): string | undefined {
  return listSessions().find((x) => !isConfigSession(x.title))?.cwd
}

// ---- T14 环境扫描：聊天一开始模型就要掌握工作环境（父目录 + 子目录结构、工具路径）----
// 结果按 cwd 缓存（60s 刷新），拼进主对话 system prompt，模型无需自己浪费步骤去 ls
const envScanCache = new Map<string, { at: number; text: string }>()
const ENV_SCAN_TTL = 60_000
// Python 环境探测结果缓存（10 分钟，机器级信息不常变）
const pythonEnvCache = new Map<string, { at: number; text: string }>()

function scanDirSummary(dir: string, depth: number, maxEntries: number): string {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return "（不可读）"
  }
  const skip = /^(node_modules|\.git|logs|\.workbuddy|__pycache__|\.venv|dist|\.next)$/
  const visible = entries.filter((e) => !skip.test(e.name)).slice(0, maxEntries)
  const lines: string[] = []
  for (const e of visible) {
    const isDir = e.isDirectory()
    lines.push(`${isDir ? "📁" : "📄"} ${e.name}`)
    if (isDir && depth > 0) {
      const sub = scanDirSummary(path.join(dir, e.name), depth - 1, 8)
      for (const l of sub.split("\n")) lines.push(`  ${l}`)
    }
  }
  if (entries.length > maxEntries) lines.push(`（…共 ${entries.length} 项）`)
  return lines.join("\n") || "（空目录）"
}

/** 探测本机 Python 环境（有缓存，10 分钟过期）：Python 装没装、什么版本、怎么调用 */
function detectPythonEnv(): string {
  const cached = pythonEnvCache.get("py")
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.text
  let text = "（未检测到 Python）"
  const probes: Array<[string, string[]]> = [
    ["python", ["--version"]],
    ["py", ["--version"]],
    ["python3", ["--version"]],
  ]
  for (const [bin, args] of probes) {
    try {
      const out = childProcess.execFileSync(bin, args, { encoding: "utf8", timeout: 5000, windowsHide: true })
      const ver = (out + "").trim()
      if (/Python \d/.test(ver)) {
        text = `${bin} 可用（${ver}）；调用方式：${bin}（Windows 下若需脚本执行建议先确认 pip 可用：${bin} -m pip --version）`
        break
      }
    } catch { /* 尝试下一个 */ }
  }
  pythonEnvCache.set("py", { at: Date.now(), text })
  return text
}

function envScanPrompt(cwd?: string): string {
  if (!cwd || !fs.existsSync(cwd)) return ""
  const cached = envScanCache.get(cwd)
  if (cached && Date.now() - cached.at < ENV_SCAN_TTL) return cached.text
  let text = ""
  try {
    const parent = path.dirname(cwd)
    const parentName = path.basename(cwd)
    let parentSiblings = ""
    try {
      parentSiblings = fs.readdirSync(parent, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== parentName && !/^(node_modules|\.git|\..*)$/.test(e.name))
        .slice(0, 15)
        .map((e) => e.name)
        .join("、")
    } catch { /* ignore */ }
    const child = scanDirSummary(cwd, 1, 30)
    const cfg = loadConfig()
    const mcpNames = Object.keys(cfg.mcpServers ?? {})
    const mcpDesc = mcpNames.length
      ? mcpNames.map((n) => `mcp_${n}_*`).join("、") + "（含浏览器自动化：导航/点击/填表/截图/画面操控）"
      : "（未配置——可在设置里添加 MCP server）"
    text = [
      "【工作环境扫描】（系统已自动扫描，直接利用，不必重复探索）：",
      `- 当前工作区：${cwd}`,
      `- Python 环境：${detectPythonEnv()}`,
      `- 父目录 ${parent} 下的其他项目/文件夹：${parentSiblings || "（无）"}`,
      "- 当前工作区结构（一层展开，目录下带一层子项）：",
      child,
      "- 可用工具路径：bash（PowerShell）、read/write/edit（文件读写）、glob/grep（检索）、websearch/webfetch（联网）、memory_save/memory_search/memory_read（记忆分层）、todo_write、delegate（子代理）、db_save/db_query（结构化库）、xlsx/docx/imggen/videogen（文档图像视频）、task_create 等（定时自动化）",
      `- MCP 服务工具：${mcpDesc}`,
      "- 记忆库：memory_search 可查公共记忆库（用户习惯、历史结论）；本会话的对话与需求即会话记忆，不要与其他会话混淆",
      "- **路径纪律**：上面扫描出的文件路径必须严格遵守——引用/读写文件一律用扫描出的真实路径，绝不臆造或改写路径；扫描没列出的文件先 glob/grep 确认存在再操作",
    ].join("\n")
  } catch { /* 扫描失败不影响对话 */ }
  envScanCache.set(cwd, { at: Date.now(), text })
  return text
}

// 回复评分反馈：把本会话最近的点赞/点踩摘要 + 「回答会被评分」规则注入 system prompt。
// 模型由此知道每次回答都会被用户评分，并具体知道哪些回答被赞/被踩，调整后续输出。
function feedbackPrompt(messages: { role: string; feedback?: "up" | "down"; content: string }[]): string {
  const rated = messages.filter((m) => m.role === "assistant" && m.feedback).slice(-10)
  const rules = [
    "【回答评分机制】",
    "- 你在这个会话中的每一次回答都会被用户即时评分（点赞/点踩），评分结果会反馈给你并影响后续回答",
    "- 收到点赞的回答：保持该类回答的风格、详略与交付方式",
    "- 收到点踩的回答：反思其问题（太啰嗦/跑题/不准确/格式差等），后续回答主动规避",
    "- 用户评分后重新生成时，要针对评分原因做出实质改进，不是简单换个说法",
  ]
  if (!rated.length) return rules.join("\n")
  const lines = rated.map((m) => {
    const preview = m.content.replace(/\s+/g, " ").slice(0, 80)
    return `- ${m.feedback === "up" ? "👍 点赞" : "👎 点踩"}：「${preview}…」`
  })
  return [...rules, "- 本会话最近的评分记录：", ...lines].join("\n")
}

// 队列驱动（R4 会话独立）：所有会话的排队消息放在 sessionQueues；pump 找一个「空闲且有排队」的会话跑下一条
function queueOf(sessionId: string): QueueItem[] {
  let q = sessionQueues.get(sessionId)
  if (!q) { q = []; sessionQueues.set(sessionId, q) }
  return q
}
function allQueued(): QueueItem[] {
  const out: QueueItem[] = []
  for (const q of sessionQueues.values()) out.push(...q)
  return out
}
function broadcastQueue(): void {
  broadcast({ type: "queue", items: allQueued().map((q) => ({ id: q.id, sessionId: q.sessionId, text: q.text })) })
}
function pumpQueue(): void {
  // 同一会话必须串行；不同会话可以并行——每个空闲会话从自己的队列取一条
  for (const [sid, q] of sessionQueues) {
    if (!q.length || sessionBusy.has(sid)) continue
    const next = q.shift()!
    broadcastQueue()
    void runTurn(next.sessionId, next.text, next.imagesBase64, next.imagesDataUrl).finally(pumpQueue)
  }
}

// ---- P1-3 辅助对话（子代理）：后台并行，不打断主对话 ----
// 每个会话独立的辅助对话（当前会话的子代理）：历史按 sessionId 隔离（内存态）、
// 独立 AbortController、无 QuestionBroker（不弹权限问题）；只读工具集，防止和主对话并行写文件打架。
// T14 监工模式：监工对主对话的质检聊天也写进辅助对话输出框，以「主对话 ↔ 辅助对话」的聊天形式呈现（role="monitor" = 主对话侧发言）
type AssistMsg = { role: "user" | "assistant" | "monitor"; content: string; ts: number }
const assistHistories = new Map<string, AssistMsg[]>() // sessionId → 该会话的辅助对话历史
let assistBusy = false
let assistAbort: AbortController | null = null
let assistBusySessionId: string | null = null // 正在回复的辅助对话所属会话
// T24 辅助对话排队：busy 时发送的消息按会话入队，回答完自动依次发送（对齐主对话排队体验）
type AssistQueueItem = { id: number; sessionId: string; text: string }
const assistQueues = new Map<string, AssistQueueItem[]>()
let assistQueueSeq = 0
function assistQueueOf(sessionId: string): AssistQueueItem[] {
  let q = assistQueues.get(sessionId)
  if (!q) { q = []; assistQueues.set(sessionId, q) }
  return q
}
function allAssistQueued(): AssistQueueItem[] {
  const out: AssistQueueItem[] = []
  for (const q of assistQueues.values()) out.push(...q)
  return out
}
function broadcastAssistQueue(): void {
  broadcast({ type: "assist-queue", items: allAssistQueued().map((q) => ({ id: q.id, sessionId: q.sessionId, text: q.text })) })
}
function pumpAssistQueue(): void {
  // 辅助对话全局串行（单个子代理）：空闲时从队列取下一条（优先取正在回复会话的队头，保持各会话公平则按入队顺序）
  if (assistBusy) return
  const all = allAssistQueued()
  if (!all.length) return
  const next = all[0]
  const q = assistQueueOf(next.sessionId)
  q.splice(q.findIndex((x) => x.id === next.id), 1)
  broadcastAssistQueue()
  void runAssistTurn(next.text, next.sessionId).finally(pumpAssistQueue)
}

// 当前 Web 端选中的会话 = 正在跑主任务的会话，否则取最近更新的普通会话（排除模型配置功能会话）
function activeAssistSessionId(): string | null {
  const busySid = anyBusySessionId()
  if (busySid) return busySid
  const s = listSessions().find((x) => x.title !== "⚙ 模型配置")
  return s?.id ?? null
}
function assistHistoryOf(sessionId: string | null): AssistMsg[] {
  if (!sessionId) return []
  let h = assistHistories.get(sessionId)
  if (!h) { h = []; assistHistories.set(sessionId, h) }
  return h
}

function assistSystemPrompt(cwd?: string): string {
  let proj = ""
  try {
    proj = fs.readdirSync(cwd ?? process.cwd())
      .filter((f) => !/^(node_modules|\.git|logs|\.workbuddy)$/.test(f))
      .slice(0, 40)
      .join("、")
  } catch { /* ignore */ }
  return [
    "你是辅助对话（子代理），在旁边协助用户。核心职责：提炼用户需求——用户描述模糊或目标多样时，帮你把需求拆解、澄清、结构化成主对话可执行的任务清单（之后用户会配置更细的提炼规则）。",
    "其他职责：审查项目、讨论下一步计划、检查主对话任务完成质量。你与主对话相互独立、并行运行，不要试图代替主对话执行任务；给出分析、建议、审查结论即可。",
    "SEND 协议：当你需要主对话执行某个动作时（继续任务/修正遗漏/新需求），在回复中输出一行以 `SEND: ` 开头的精简指令，它会被自动放入主对话队列执行。",
    "回答保持精炼（通常 200 字内），重点突出。",
    `当前项目根目录主要内容：${proj || "（未知）"}`,
  ].join("\n")
}

// SEND 协议：辅助对话回复里的 `SEND: xxx` 行 → 自动入主对话队列（空闲则立即执行）
function enqueueFromAssist(reply: string, targetSid?: string): number {
  const sends = reply.match(/^SEND:\s*(.+)$/gm)
  if (!sends?.length) return 0
  const target = targetSid ?? lastSessionId()
  if (!target) return 0
  for (const line of sends) {
    const task = line.replace(/^SEND:\s*/, "").trim()
    if (!task) continue
    queueOf(target).push({ id: ++queueSeq, sessionId: target, text: task })
  }
  broadcastQueue()
  void pumpQueue()
  return sends.length
}

// 最近活动的普通会话 id（SEND 指令的目的地）：正在跑的 → 最近更新的（排除模型配置功能会话）
function lastSessionId(): string | null {
  const busySid = anyBusySessionId()
  if (busySid) return busySid
  const s = listSessions().find((x) => !isConfigSession(x.title))
  return s?.id ?? null
}

// ---- R2 多项目诉求自动拆分 ----
// 一条消息同时涉及 ≥2 个已知项目工作区时，自动拆成每个项目一个独立会话任务，避免相互干扰。
// 两道闸：① 启发式预筛（文本命中 ≥2 个已知工作区文件夹名才继续，绝大多数消息零开销）；
// ② LLM 结构化拆分（输出 JSON [{cwd, task}]，拆不出 ≥2 个独立子任务则回落原流程）。
function knownCwds(): Array<{ path: string; name: string }> {
  const seen = new Set<string>()
  const list: Array<{ path: string; name: string }> = []
  const push = (p: string) => {
    try {
      const resolved = path.resolve(p)
      if (seen.has(resolved) || !fs.existsSync(resolved)) return
      seen.add(resolved)
      list.push({ path: resolved, name: path.basename(resolved) })
    } catch { /* ignore */ }
  }
  for (const s of listSessions()) push(s.cwd)
  return list
}
function heuristicMultiProject(text: string): boolean {
  const cwds = knownCwds()
  if (cwds.length < 2) return false
  const lower = text.toLowerCase()
  let hits = 0
  for (const c of cwds) {
    if (c.name.length >= 2 && lower.includes(c.name.toLowerCase())) hits++
  }
  return hits >= 2
}
async function trySplitMultiProject(text: string, sourceSessionId?: string): Promise<Array<{ sessionId: string; title: string; task: string }> | null> {
  if (!text.trim() || !heuristicMultiProject(text)) return null
  const cwds = knownCwds()
  try {
    const { runAgent } = await import("./agent/loop.js")
    const cfg = loadConfig()
    const cwdList = cwds.map((c) => `- ${c.name} → ${c.path}`).join("\n")
    // 超时熔断：拆分器是一次独立的小 LLM 调用，挂太久会阻塞 /api/chat 响应（慢模型实测 10 token 要 56 秒）
    const timeoutMs = cfg.splitterTimeoutMs ?? 120_000
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error(`拆分器超时（${timeoutMs}ms）`)), timeoutMs)
    ;(globalThis as Record<string, unknown>).__yyagentSplitter = true // 拆分器标志：跳过无 broker 场景的 bash 权限拒绝
    let r
    try {
      r = await runAgent(
        `把这条用户诉求拆分成按项目独立的子任务。用户诉求原文：\n${text.slice(0, 2000)}\n\n已知项目工作区（cwd 只能从这里选）：\n${cwdList}\n\n` +
        `规则：1) 只拆「确实要分别在不同项目里执行」的独立任务；跨项目的关联部分归入最相关的那个子任务说明里；2) 每个子任务一段自包含的清晰指令（不引用其他子任务的上下文）；3) 拆不出 ≥2 个独立子任务、或诉求不属于任何已知项目时，输出 {"tasks":[]}；4) 只输出 JSON：{"tasks":[{"cwd":"完整路径","task":"子任务指令"}]}`,
        // T73：拆分器同样注入基础层（无例外）；「只输出 JSON」的契约靠 composeSystem 的作用域声明
        // （基础层格式条款让位于专用指令）+ 下方解析侧容错（剥 thinking、取最后一个 JSON 块）双重保障。
        { maxSteps: 1, disableInjection: true, system: "你是任务拆分器。只输出 JSON，不要输出任何其他内容。", model: cfg.splitterModel || cfg.model, signal: ac.signal },
      )
    } finally {
      clearTimeout(timer)
      delete (globalThis as Record<string, unknown>).__yyagentSplitter
    }
    // 有些模型（如本地 mimo）把 reasoning 泄漏进 content：先剥 <thinking>/<think> 块再提取 JSON；
    // 取最后一个 {…} 块——reasoning 里可能引用过示例 JSON，真正的输出在最后
    const clean = r.text.replace(/<(thinking|think)>[\s\S]*?<\/\1>/gi, "")
    const m = clean.match(/\{[\s\S]*\}(?!\s*\{)/g)
    const raw = m ? m[m.length - 1] : clean.match(/\{[\s\S]*\}/)?.[0] ?? ""
    if (!raw) return null
    const parsed = JSON.parse(raw) as { tasks?: Array<{ cwd?: string; task?: string }> }
    const tasks = (parsed.tasks ?? [])
      .filter((t) => t.cwd && t.task && cwds.some((c) => path.resolve(c.path) === path.resolve(t.cwd!)))
      .slice(0, 5)
    if (tasks.length < 2) return null
    const out: Array<{ sessionId: string; title: string; task: string }> = []
    for (const t of tasks) {
      const cwdResolved = path.resolve(t.cwd!)
      // 优先复用该工作区已有的空闲会话；没有则新建
      const existing = listSessions().find((s) => path.resolve(s.cwd) === cwdResolved && !sessionBusy.has(s.id))
      const sid = existing?.id ?? createSession(cwdResolved).id
      const taskText = t.task!.trim()
      queueOf(sid).push({ id: ++queueSeq, sessionId: sid, text: taskText })
      out.push({ sessionId: sid, title: existing?.title ?? taskText.replace(/\s+/g, " ").slice(0, 30), task: taskText })
    }
    broadcastQueue()
    void pumpQueue()
    broadcast({ type: "notice", text: `已拆分 ${out.length} 个项目任务到各自会话执行` })
    return out
  } catch {
    return null // 拆分失败不阻塞消息，回落原流程
  }
}

// 辅助对话按会话隔离：sid=null 时落到「当前活动会话」（子代理始终归属某个主会话）
async function runAssistTurn(text: string, sid?: string): Promise<void> {
  const sessionId = sid || activeAssistSessionId()
  assistBusy = true
  assistBusySessionId = sessionId
  assistAbort = new AbortController()
  broadcast({ type: "assist", kind: "busy", busy: true, sessionId })
  const history = assistHistoryOf(sessionId)
  const userMsg: AssistMsg = { role: "user", content: text, ts: Date.now() }
  history.push(userMsg)
  broadcast({ type: "assist", kind: "message", sessionId, message: userMsg })
  try {
    const { runAgent } = await import("./agent/loop.js")
    const { makeTools } = await import("./agent/tools.js")
    const cfg = loadConfig()
    // P1-5 cwd 污染：辅助对话跟随所属主会话的工作区，而不是网关启动目录
    const activeCwd = sessionId ? loadSession(sessionId)?.meta.cwd : undefined
    const r = await runAgent(text, {
      system: assistSystemPrompt(activeCwd),
      tools: makeTools({ readonly: true }),
      maxSteps: 15,
      cwd: activeCwd ?? process.cwd(),
      signal: assistAbort.signal,
      disableInjection: true,
      model: cfg.model,
      // T14：monitor 角色（主对话侧发言）映射为 user 消息传给子代理——它需要看到主对话的任务与报告上下文
      history: history.slice(0, -1).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }) as { role: "user" | "assistant"; content: string }),
    })
    const aMsg: AssistMsg = { role: "assistant", content: r.text, ts: Date.now() }
    history.push(aMsg)
    if (history.length > 60) assistHistories.set(sessionId!, history.slice(-60))
    broadcast({ type: "assist", kind: "message", sessionId, message: aMsg })
    // SEND 协议：辅助回复里的 `SEND: 指令` 自动进主对话队列
    const n = enqueueFromAssist(r.text)
    if (n > 0) broadcast({ type: "notice", text: `⟡ 辅助对话已向主对话入队 ${n} 条指令` })
  } catch (e) {
    const err = e as Error
    const aborted = err.name === "AbortError" || /abort/i.test(err.message ?? "")
    const aMsg: AssistMsg = { role: "assistant", content: aborted ? "（已停止）" : `[出错] ${err.message}`, ts: Date.now() }
    history.push(aMsg)
    broadcast({ type: "assist", kind: "message", sessionId, message: aMsg })
  } finally {
    assistBusy = false
    assistBusySessionId = null
    assistAbort = null
    broadcast({ type: "assist", kind: "busy", busy: false, sessionId })
  }
}

// ---- REST + 静态 ----
function json(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(data))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
}

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  let p = urlPath === "/" ? "/index.html" : urlPath
  const full = path.join(WEB_DIR, p)
  if (!full.startsWith(WEB_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    // 单页应用兜底：未命中路径回 index.html
    const index = path.join(WEB_DIR, "index.html")
    if (fs.existsSync(index)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(fs.readFileSync(index))
      return
    }
    res.writeHead(404).end("not found")
    return
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream" })
  res.end(fs.readFileSync(full))
}

// 会话当前生效模型：override > 会话 meta.model > 全局默认（与 runTurn 取值逻辑一致）
function effectiveModelOf(sessionId: string): string {
  const meta = listSessions().find((s) => s.id === sessionId)
  return sessionsModelOverride.get(sessionId) ?? meta?.model ?? loadConfig().model
}

function statePayload(): Record<string, unknown> {
  const cfg = loadConfig()
  const models: Array<{ spec: string; provider: string; modelId: string }> = []
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (/REPLACE_ME/i.test(p.apiKey)) continue
    for (const m of p.models ?? []) models.push({ spec: `${name}/${m}`, provider: name, modelId: m })
  }
  return {
    model: cfg.model,
    // F1 会话级模型：activeSessionId = 前端当前打开的会话（跟随其 ?sid 查询）；busy 会话兜底
    activeSessionId: stateActiveSid ?? anyBusySessionId(),
    sessionModel: stateActiveSid ? effectiveModelOf(stateActiveSid) : cfg.model,
    permission: cfg.permission,
    sessionPermission: stateActiveSid ? (getSessionPermission(stateActiveSid) ?? cfg.permission) : cfg.permission,
    visionModel: cfg.visionModel ?? "",
    imageModel: cfg.imageModel ?? "",
    searchEngine: cfg.searchEngine ?? "bing",
    watch: cfg.watch === true,
    mcpServers: Object.keys(cfg.mcpServers ?? {}),
    visionDirect: (() => {
      try {
        const name = cfg.model.split("/")[0]
        return cfg.providers[name]?.supportsImages === true
      } catch {
        return false
      }
    })(),
    models,
    // R4 会话独立：busy 集合 + 当前上报会话是否 busy（前端按钮按 activeId 判断），兼容字段 busy/busySessionId 保留
    busy: sessionBusy.size > 0,
    busySessionId: anyBusySessionId(),
    busySessions: [...sessionBusy],
    activeBusy: stateActiveSid ? sessionBusy.has(stateActiveSid) : false,
    assistBusy,
    queue: allQueued().map((q) => ({ id: q.id, sessionId: q.sessionId, text: q.text })),
    question: stateActiveSid ? brokerOf(stateActiveSid).pending : null,
    // P2-4：todo 按会话隔离——只返回当前会话的清单，新对话不再看到旧任务残留
    todo: stateActiveSid ? readTodo(stateActiveSid) : [],
  }
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const m = req.method ?? "GET"
  const p = url.pathname
  if (m === "GET" && p === "/api/sessions") return json(res, 200, listSessions())
  // T45 使用统计两张图的数据源（只读）：都从 ~/.yyagent/usage.jsonl 现算，零额外落盘
  if (m === "GET" && p === "/api/usage/daily") return json(res, 200, usageDaily())
  if (m === "GET" && p === "/api/usage/models") return json(res, 200, usageByModel())

  // ================= P-1 发行版首启动引导 =================
  // 安装包里不塞模型权重，改成「一键下载本地免费模型」：这里只做检测/拉取/写 provider，
  // 前端 overlay 负责交互。全部路由都跟 Ollama 的本地 11434 打交道（走 no_proxy，见 ollama.ts 头注释）。
  if (m === "GET" && p === "/api/onboard/state") {
    const cfg = loadConfig()
    const providerCount = Object.keys(cfg.providers ?? {}).length
    // 「已完成引导」标记存在 ui 里（跟主题等个人设置同一份，跨入口/重启共用）
    const done = cfg.ui?.onboardDone === "1"
    return json(res, 200, {
      needsOnboarding: providerCount === 0 && !done,
      providerCount,
      model: cfg.model ?? "",
      // 引导页要用，顺手带上省一次往返
      ollama: await ollamaStatus(1200),
      choices: MODEL_CHOICES,
    })
  }
  if (m === "GET" && p === "/api/ollama/status") {
    return json(res, 200, { ...(await ollamaStatus()), choices: MODEL_CHOICES })
  }
  if (m === "POST" && p === "/api/ollama/start") {
    // 「我已经装好 Ollama 了，但它是关着的」——帮用户把服务拉起来再回状态
    const st = await ensureOllamaRunning()
    return json(res, 200, { ...st, choices: MODEL_CHOICES })
  }
  if (m === "POST" && p === "/api/ollama/pull") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const model = String(body.model ?? "").trim()
    if (!/^[\w.\-]+(:[\w.\-]+)?$/.test(model)) return json(res, 400, { error: `模型名不合法: ${model}` })
    // NDJSON 流式转发拉取进度（不是 SSE：没有 "data: " 前缀，一行一个 JSON）
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    })
    const aborted = new AbortController()
    // 用户关页面/点取消 → 中断到 Ollama 的流（但已下载的分片会留在本地，下次续传）
    req.on("close", () => aborted.abort())
    let last = ""
    try {
      await pullModel(
        model,
        (e) => {
          last = e.status ?? last
          res.write(`${JSON.stringify({ type: "progress", status: e.status ?? "", completed: e.completed ?? 0, total: e.total ?? 0 })}\n`)
        },
        aborted.signal,
      )
      // 拉完立刻写 provider + 切默认模型，前端就不用再发一次请求
      const already = (await ollamaStatus(1500)).models
      const wired = wireOllamaProvider(model, already)
      broadcast({ type: "reload" })
      res.write(`${JSON.stringify({ type: "done", status: last, spec: wired.spec })}\n`)
    } catch (e) {
      res.write(`${JSON.stringify({ type: "error", error: (e as Error).message })}\n`)
    }
    res.end()
    return
  }
  if (m === "POST" && p === "/api/onboard/local") {
    // 引导页「本机已有模型，直接接入」：不重新下载，只写 provider
    const body = JSON.parse((await readBody(req)) || "{}")
    const model = String(body.model ?? "").trim()
    if (!model) return json(res, 400, { error: "缺少 model" })
    const st = await ollamaStatus(1500)
    if (!st.running) return json(res, 400, { error: `连不上 Ollama（${st.base}）` })
    const wired = wireOllamaProvider(model, st.models)
    broadcast({ type: "reload" })
    return json(res, 200, { ok: true, ...wired })
  }
  if (m === "POST" && p === "/api/onboard/done") {
    // 用户选择「我自己配 API Key」或「稍后再说」→ 打个标记，之后不再弹
    const cfg = loadConfig()
    cfg.ui = { ...(cfg.ui ?? {}), onboardDone: "1" }
    saveConfig(cfg)
    return json(res, 200, { ok: true })
  }
  if (m === "POST" && p === "/api/sessions") {
    const body = JSON.parse((await readBody(req)) || "{}")
    // P1-5 工作区：新建会话必须选定工作目录（生成文件放这里），创建后不可改
    const cwd = String(body.cwd ?? process.cwd())
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return json(res, 400, { error: `工作目录不存在: ${cwd}` })
    }
    const meta = createSession(cwd, body.model, body.title)
    if (body.model) sessionsModelOverride.set(meta.id, body.model)
    return json(res, 200, meta)
  }
  // P1-5 工作区：候选目录 = 进程 cwd + 历史会话用过的目录（去重、存在性过滤），供新建会话选择
  if (m === "GET" && p === "/api/cwds") {
    const seen = new Set<string>()
    const list: Array<{ path: string; name: string }> = []
    const push = (p: string) => {
      try {
        const resolved = path.resolve(p)
        if (seen.has(resolved) || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return
        seen.add(resolved)
        list.push({ path: resolved, name: path.basename(resolved) || resolved })
      } catch { /* ignore */ }
    }
    push(process.cwd())
    for (const s of listSessions()) push(s.cwd)
    return json(res, 200, { cwds: list })
  }
  // P1-5 目录浏览器：列举某目录下的子文件夹（?p=路径，缺省=盘符根列表），供工作区可视化选择
  if (m === "GET" && p === "/api/browse") {
    const target = url.searchParams.get("p")?.trim() ?? ""
    if (!target) {
      // 根：列出所有盘符（Windows）或 /
      if (process.platform === "win32") {
        const drives: string[] = []
        for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
          const d = `${letter}:\\`
          try { if (fs.existsSync(d)) drives.push(d) } catch { /* ignore */ }
        }
        return json(res, 200, { parent: "", dirs: drives.map((d) => ({ path: d, name: d })) })
      }
      return json(res, 200, { parent: "", dirs: [{ path: "/", name: "/" }] })
    }
    try {
      const resolved = path.resolve(target)
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return json(res, 400, { error: `目录不存在: ${resolved}` })
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
      const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({ path: path.join(resolved, e.name), name: e.name }))
        .sort((a, b) => a.name.localeCompare(b.name, "zh"))
      // parent：上一级（根的 parent 为空）
      const parent = path.dirname(resolved)
      return json(res, 200, { current: resolved, parent: parent === resolved ? "" : parent, dirs })
    } catch (e) {
      return json(res, 400, { error: `无法读取目录: ${(e as Error).message}` })
    }
  }
  // 右栏文件管理：列当前工作区目录（?p=子路径相对 cwd，缺省=工作区根），返回文件+子目录（含大小/修改时间）
  // T29 ?sid= 指定会话（前端始终传当前打开的会话，切会话文件管理自动跟随）；缺省=正在跑任务的会话，否则最近更新的普通会话
  if (m === "GET" && p === "/api/workspace/files") {
    const sessions = listSessions()
    const sid = url.searchParams.get("sid")?.trim() ?? ""
    const cur = sid ? sessions.find((s) => s.id === sid)
      : anyBusySessionId() ? sessions.find((s) => s.id === anyBusySessionId())
      : sessions.find((s) => !isConfigSession(s.title))
    const base = cur?.cwd
    if (!base) return json(res, 400, { error: "无活动会话/工作区" })
    const sub = url.searchParams.get("p")?.trim() ?? ""
    const target = path.resolve(base, sub)
    if (!target.startsWith(path.resolve(base))) return json(res, 403, { error: "越出工作区范围" })
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return json(res, 400, { error: `目录不存在: ${target}` })
    try {
      const entries = fs.readdirSync(target, { withFileTypes: true })
      const items = entries.filter((e) => ![".git", "node_modules"].includes(e.name) && !e.name.startsWith("."))
        .map((e) => {
          const fp = path.join(target, e.name)
          let size = 0, mtime = 0
          try { const st = fs.statSync(fp); size = st.size; mtime = st.mtimeMs } catch { /* 可能刚被删 */ }
          return { name: e.name, dir: e.isDirectory(), size, mtime }
        })
        .sort((a, b) => ((b.dir ? 1 : 0) - (a.dir ? 1 : 0)) || a.name.localeCompare(b.name, "zh"))
      return json(res, 200, { cwd: base, current: target, parent: target === path.resolve(base) ? null : path.dirname(target), items })
    } catch (e) {
      return json(res, 400, { error: `无法读取目录: ${(e as Error).message}` })
    }
  }
  let mt = p.match(/^\/api\/sessions\/([\w-]+)$/)
  if (mt) {
    const id = mt[1]
    if (m === "GET") {
      const f = loadSession(id)
      return f ? json(res, 200, f) : json(res, 404, { error: "not found" })
    }
    if (m === "DELETE") {
      // 模型配置会话是 TUI 的功能会话（注入配置上下文），默认删不掉
      const f = loadSession(id)
      if (isConfigSession(f?.meta.title)) return json(res, 403, { error: "模型配置会话是功能会话，不可删除" })
      // R4：正在跑任务的会话先停止
      if (sessionBusy.has(id)) {
        sessionAborts.get(id)?.abort()
        for (let i = 0; i < 50 && sessionBusy.has(id); i++) await new Promise((r) => setTimeout(r, 100))
      }
      deleteSession(id)
      deleteTodo(id) // P2-4：todo 按会话隔离，会话删了清单也跟着删
      assistHistories.delete(id) // 辅助对话按会话隔离：主会话删了，子代理对话一并清理
      sessionQueues.delete(id) // R4：排队消息一并清理
      brokers.delete(id)
      deleteSessionPermission(id) // T14：会话级权限一并清理
      pruneUsage(new Set(listSessions().map((m) => m.id))) // T66：会话删了，它的账本行一并剪掉（守「账本总额===会话累计」）
      broadcast({ type: "reload", sessionId: id })
      return json(res, 200, { ok: true })
    }
  }
  // 完整历史（P0-3）：?before=<ts>&limit=<n> 从指定时间戳向前取 n 条；不传 before = 从最新往前取
  mt = p.match(/^\/api\/sessions\/([\w-]+)\/messages$/)
  if (mt && m === "GET") {
    const f = loadSession(mt[1])
    if (!f) return json(res, 404, { error: "not found" })
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 100)))
    const before = url.searchParams.get("before")
    let list = f.messages
    if (before) list = list.filter((x) => x.ts < Number(before))
    const total = f.messages.length
    const slice = list.slice(-limit)
    return json(res, 200, {
      total,
      returned: slice.length,
      hasMore: slice.length > 0 && (before ? f.messages.some((x) => x.ts < Number(before)) && list.length > slice.length : total > slice.length),
      oldestTs: slice[0]?.ts ?? null,
      messages: slice,
    })
  }
  // 一键压缩（P0-2）：把当前会话历史压成滚动摘要 + 最近几条，落盘并广播
  mt = p.match(/^\/api\/sessions\/([\w-]+)\/compact$/)
  if (mt && m === "POST") {
    const f = loadSession(mt[1])
    if (!f) return json(res, 404, { error: "not found" })
    if (sessionBusy.has(mt[1])) return json(res, 409, { error: "任务进行中，稍后再压缩" })
    broadcast({ type: "status", sessionId: mt[1], text: "压缩中" })
    try {
      const model = sessionsModelOverride.get(mt[1]) ?? f.meta.model ?? loadConfig().model
      // T55：system 提示（模型切换）不进压缩摘要的 LLM 上下文（类型守卫让 TS 确认过滤后无 system）
      const compacted = await compactNow(f.messages.filter((m): m is StoredMessage & { role: "user" | "assistant" } => m.role !== "system"), model)
      f.meta.updatedAt = Date.now()
      f.meta.ctxPct = calcCtxPct(compacted)
      persist(f.meta, compacted)
      broadcast({ type: "compacted", sessionId: mt[1], ctxPct: f.meta.ctxPct })
      broadcast({ type: "notice", text: `已压缩：${f.messages.length} 条 → ${compacted.length} 条` })
      return json(res, 200, { ok: true, ctxPct: f.meta.ctxPct, before: f.messages.length, after: compacted.length })
    } catch (e) {
      broadcast({ type: "status", sessionId: mt[1], text: "" })
      return json(res, 500, { error: String((e as Error).message ?? e) })
    }
  }
  mt = p.match(/^\/api\/sessions\/([\w-]+)\/rename$/)
  if (mt && m === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const f = loadSession(mt[1])
    if (!f) return json(res, 404, { error: "not found" })
    f.meta.title = String(body.title ?? f.meta.title).slice(0, 60)
    persist(f.meta, f.messages)
    return json(res, 200, f.meta)
  }
  if (m === "GET" && p === "/api/state") {
    // F1：前端上报当前打开的会话，statePayload 据此返回该会话的生效模型（sessionModel）
    const sid = url.searchParams.get("sid")?.trim() ?? ""
    stateActiveSid = sid || null
    return json(res, 200, statePayload())
  }
  // P1-2 会话全文搜索：?q= 搜标题+所有消息内容，返回命中会话与片段；带首个命中消息的索引供前端跳转定位
  if (m === "GET" && p === "/api/search") {
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase()
    const cat = (url.searchParams.get("cat") ?? "all").toLowerCase()
    if (!q) return json(res, 200, { hits: [] })
    // T65 分类搜索：task = 定时任务名/cron（独立返回，type:"task"，点击进自动化页）
    if (cat === "task") {
      const hits = taskListPayload()
        .filter((t) => t.name.toLowerCase().includes(q) || t.cron.toLowerCase().includes(q))
        .slice(0, 30)
        .map((t) => ({ sessionId: "", title: t.name, updatedAt: 0, count: 1, snippets: [`定时任务 · ${t.cron || "手动"}${t.enabled ? "" : " · 已停用"}`], msgIndex: -1, type: "task" }))
      return json(res, 200, { hits })
    }
    // T65 分类：ops = 工具步骤（name+args）；file = 文件路径（fileEdits + 正文里的路径串）；all = 标题+消息+步骤+文件
    // 路径串允许空格（Windows 路径常含空格），以反引号/引号/中文标点为界（模型输出路径惯例是反引号包裹）
    const pathRe = /([A-Za-z]:[\\/][^`"'，。；）]{4,})/g
    const hits: Array<{ sessionId: string; title: string; updatedAt: number; count: number; snippets: string[]; msgIndex: number }> = []
    for (const meta of listSessions()) {
      const f = loadSession(meta.id)
      if (!f) continue
      const snippets: string[] = []
      let count = 0
      let msgIndex = -1
      const pushHit = (text: string, tag: string, idx: number) => {
        count++
        if (msgIndex < 0) msgIndex = idx
        if (snippets.length < 3) {
          const i = text.toLowerCase().indexOf(q)
          const start = Math.max(0, i - 30)
          snippets.push(`${tag}: ${start > 0 ? "…" : ""}${text.slice(start, i + q.length + 60).replace(/\s+/g, " ")}`)
        }
      }
      if (cat !== "ops" && cat !== "file" && meta.title.toLowerCase().includes(q)) {
        count++
        snippets.push(`标题: ${meta.title}`)
      }
      f.messages.forEach((msg, idx) => {
        if (cat !== "ops" && cat !== "file" && msg.content.toLowerCase().includes(q)) pushHit(msg.content, msg.role === "user" ? "你" : "AI", idx)
        if ((cat === "ops" || cat === "all") && msg.steps?.length) {
          for (const st of msg.steps) {
            const t = `${st.name} ${st.argsSummary ?? ""}`
            if (t.toLowerCase().includes(q)) pushHit(t, "⚙", idx)
          }
        }
        if (cat === "file" || cat === "all") {
          const paths = new Set<string>()
          for (const fe of msg.fileEdits ?? []) if (fe.path.toLowerCase().includes(q)) paths.add(fe.path)
          let pm: RegExpExecArray | null
          pathRe.lastIndex = 0
          while ((pm = pathRe.exec(msg.content))) if (pm[1].toLowerCase().includes(q)) paths.add(pm[1])
          for (const p of paths) pushHit(p, "📄", idx)
        }
      })
      if (count > 0) hits.push({ sessionId: meta.id, title: meta.title, updatedAt: meta.updatedAt, count, snippets, msgIndex })
    }
    hits.sort((a, b) => b.updatedAt - a.updatedAt)
    return json(res, 200, { hits: hits.slice(0, 30) })
  }
  // P1-1 定时任务：列表（含最近一次结果）+ 立即运行（网关进程内跑，完成/失败弹 Windows toast + 广播）
  if (m === "GET" && p === "/api/tasks") return json(res, 200, taskListPayload())
  // 自动化界面：新建 / 修改 / 删除 / 启停（写回 yyagentd.config.json + 即时调整调度）
  if (m === "POST" && p === "/api/tasks/create") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const name = String(body.name ?? "").trim()
    const cronExpr = String(body.cron ?? "").trim()
    const prompt = String(body.prompt ?? "").trim()
    if (!name || !prompt) return json(res, 400, { error: "name / prompt 必填" })
    if (!cronLib.validate(cronExpr)) return json(res, 400, { error: `无效的 cron 表达式: ${cronExpr}` })
    const tasks = loadDaemonTasks()
    if (tasks.some((t) => t.name === name)) return json(res, 409, { error: `任务名已存在: ${name}` })
    const t: DaemonTask = {
      name, cron: cronExpr, prompt,
      cwd: body.cwd ? String(body.cwd) : undefined,
      timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : undefined,
      enabled: true,
    }
    tasks.push(t)
    saveDaemonTasks(tasks)
    scheduleTask(t)
    broadcast({ type: "tasks", tasks: taskListPayload() })
    return json(res, 200, { ok: true, task: { name: t.name, cron: t.cron } })
  }
  if (m === "POST" && p === "/api/tasks/update") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const name = String(body.name ?? "")
    const tasks = loadDaemonTasks()
    const t = tasks.find((x) => x.name === name)
    if (!t) return json(res, 404, { error: `无此任务: ${name}` })
    if (body.cron != null) {
      const cronExpr = String(body.cron).trim()
      if (!cronLib.validate(cronExpr)) return json(res, 400, { error: `无效的 cron 表达式: ${cronExpr}` })
      t.cron = cronExpr
    }
    if (body.prompt != null) t.prompt = String(body.prompt).trim() || t.prompt
    if (body.cwd != null) t.cwd = String(body.cwd).trim() || undefined
    if (body.timeoutMs != null && Number(body.timeoutMs) > 0) t.timeoutMs = Number(body.timeoutMs)
    saveDaemonTasks(tasks)
    scheduleTask(t)
    broadcast({ type: "tasks", tasks: taskListPayload() })
    return json(res, 200, { ok: true })
  }
  if (m === "POST" && p === "/api/tasks/delete") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const name = String(body.name ?? "")
    const tasks = loadDaemonTasks()
    const idx = tasks.findIndex((x) => x.name === name)
    if (idx < 0) return json(res, 404, { error: `无此任务: ${name}` })
    tasks.splice(idx, 1)
    saveDaemonTasks(tasks)
    unscheduleTask(name)
    broadcast({ type: "tasks", tasks: taskListPayload() })
    return json(res, 200, { ok: true })
  }
  if (m === "POST" && p === "/api/tasks/toggle") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const name = String(body.name ?? "")
    const tasks = loadDaemonTasks()
    const t = tasks.find((x) => x.name === name)
    if (!t) return json(res, 404, { error: `无此任务: ${name}` })
    t.enabled = t.enabled === false
    saveDaemonTasks(tasks)
    scheduleTask(t) // enabled=false 时内部会直接 unschedule
    broadcast({ type: "tasks", tasks: taskListPayload() })
    return json(res, 200, { ok: true, enabled: t.enabled !== false })
  }
  if (m === "POST" && p === "/api/tasks/run") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const t = loadDaemonTasks().find((x) => x.name === String(body.name ?? ""))
    if (!t) return json(res, 404, { error: `无此任务: ${body.name}` })
    if (taskRunning.has(t.name)) return json(res, 409, { error: "该任务正在运行" })
    void runDaemonTask(t)
    return json(res, 200, { ok: true, started: t.name })
  }
  if (m === "POST" && p === "/api/model") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const spec = String(body.model ?? "")
    try {
      resolveModel(loadConfig(), spec) // 校验存在性
    } catch {
      return json(res, 400, { error: `模型不可用: ${spec}` })
    }
    // 会话级模型：带 sessionId → 只改该会话（一个会话选 A，另一个可选 B，互不影响）；
    // 不带 sessionId → 改全局默认模型。会话 override 优先级最高（runTurn 已按此取模型）
    const sid = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null
    if (sid) {
      if (!loadSession(sid)) return json(res, 404, { error: `会话不存在: ${sid}` })
      const oldModel = effectiveModelOf(sid)
      sessionsModelOverride.set(sid, spec)
      if (loadConfig().model === spec) sessionsModelOverride.delete(sid) // 与默认一致就回落默认，语义更干净
      // T55/T56 模型切换提示：会话内实际生效模型变化 → 落一条 system 提示消息（切换瞬间即广播渲染、
      // 刷新后仍在；role "system" 只入库展示，toCoreMessages 已过滤、绝不进 LLM 上下文）。
      // T56 连续切换合并：上一条已是模型切换提示就原地替换（只保留最后一条，不再堆叠灰字横线）
      if (oldModel && oldModel !== spec) {
        const short = (s: string) => String(s).split("/").pop() || s
        const content = `模型已从 ${short(oldModel)} 更改为 ${short(spec)}`
        const session = loadSession(sid)!
        const last = session.messages[session.messages.length - 1]
        let notice: StoredMessage
        if (last && last.role === "system" && last.content.startsWith("模型已从")) {
          last.content = content
          last.ts = Date.now()
          notice = last
        } else {
          notice = { ts: Date.now(), role: "system", content }
          session.messages.push(notice)
        }
        persist(session.meta, session.messages)
        broadcast({ type: "message", sessionId: sid, message: notice })
      }
      broadcast({ type: "model", model: effectiveModelOf(sid), sessionId: sid })
    } else {
      setDefaultModel(spec)
      broadcast({ type: "model", model: spec, sessionId: null })
    }
    return json(res, 200, { ok: true, model: spec, sessionId: sid })
  }
  // P1-4 识图模型设置：{model: "provider/id"} 设默认识图模型；{model: ""} 取消（回落到只支持直传/报错）
  if (m === "POST" && p === "/api/vision-model") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const spec = String(body.model ?? "").trim()
    if (spec) {
      try {
        resolveModel(loadConfig(), spec)
      } catch {
        return json(res, 400, { error: `模型不可用: ${spec}` })
      }
    }
    const cfg = loadConfig()
    cfg.visionModel = spec || undefined
    saveConfig(cfg)
    return json(res, 200, { ok: true, visionModel: spec })
  }
  // T15 默认生图模型设置：{model: "provider/id"} 指定；{model: ""} 取消（imggen 自动遍历猜测）
  if (m === "POST" && p === "/api/image-model") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const spec = String(body.model ?? "").trim()
    if (spec) {
      try {
        resolveModel(loadConfig(), spec)
      } catch {
        return json(res, 400, { error: `模型不可用: ${spec}` })
      }
    }
    const cfg = loadConfig()
    cfg.imageModel = spec || undefined
    saveConfig(cfg)
    return json(res, 200, { ok: true, imageModel: spec })
  }
  // T66 钩子管理：列表 / 开关 / 新建 / 删除（内置钩子可开关不可删；配置即时生效，loadConfig 无陈旧缓存问题——saveConfig 会刷新 cached）
  if (m === "GET" && p === "/api/hooks") return json(res, 200, { hooks: loadConfig().hooks ?? [] })
  if (m === "POST" && p === "/api/hooks/toggle") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const h = (loadConfig().hooks ?? []).find((x) => x.id === body.id)
    if (!h) return json(res, 404, { error: "钩子不存在" })
    h.enabled = !!body.enabled
    saveConfig(loadConfig())
    return json(res, 200, { ok: true, hook: h })
  }
  if (m === "POST" && p === "/api/hooks/create") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const name = String(body.name ?? "").trim()
    const prompt = String(body.prompt ?? "").trim()
    if (!name || !prompt) return json(res, 400, { error: "名称与检查要求不能为空" })
    const cfg = loadConfig()
    cfg.hooks = cfg.hooks ?? []
    const hook = { id: "hook-" + Date.now().toString(36), name, builtin: false, enabled: true, prompt }
    cfg.hooks.push(hook)
    saveConfig(cfg)
    return json(res, 200, { ok: true, hook })
  }
  if (m === "POST" && p === "/api/hooks/delete") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const cfg = loadConfig()
    const h = (cfg.hooks ?? []).find((x) => x.id === body.id)
    if (!h) return json(res, 404, { error: "钩子不存在" })
    if (h.builtin) return json(res, 400, { error: "内置钩子不可删除，可关闭" })
    cfg.hooks = (cfg.hooks ?? []).filter((x) => x.id !== body.id)
    saveConfig(cfg)
    return json(res, 200, { ok: true })
  }
  // T68 个人化设置服务端化：GET 拉全部 config.ui；POST 合并写回（浅合并，值均为字符串）
  if (m === "GET" && p === "/api/ui") return json(res, 200, { ui: loadConfig().ui ?? {} })
  if (m === "POST" && p === "/api/ui") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const patch = body && typeof body === "object" && body.ui && typeof body.ui === "object" ? body.ui : body
    const cfg = loadConfig()
    const ui: Record<string, string> = { ...(cfg.ui ?? {}) }
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (typeof v === "string") ui[k] = v
      else if (v === null) delete ui[k]
    }
    cfg.ui = ui
    saveConfig(cfg)
    return json(res, 200, { ok: true, ui })
  }
  // P1-9 搜索引擎设置：bing（默认）/ duckduckgo / baidu
  if (m === "POST" && p === "/api/search-engine") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const engine = String(body.engine ?? "bing")
    if (!["bing", "duckduckgo", "baidu"].includes(engine)) return json(res, 400, { error: `不支持的引擎: ${engine}` })
    const cfg = loadConfig()
    cfg.searchEngine = engine as "bing" | "duckduckgo" | "baidu"
    saveConfig(cfg)
    broadcast({ type: "notice", text: `搜索引擎已切换为 ${engine}` })
    return json(res, 200, { ok: true, searchEngine: engine })
  }
  // 监工模式开关：主任务完成后辅助对话自动质检 + SEND 回传
  if (m === "POST" && p === "/api/watch") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const cfg = loadConfig()
    cfg.watch = body.watch === true
    saveConfig(cfg)
    broadcast({ type: "notice", text: cfg.watch ? "监工模式已开启：任务完成后辅助对话自动检查" : "监工模式已关闭" })
    return json(res, 200, { ok: true, watch: cfg.watch })
  }
  // P1-8 MCP 管理：列出 / 新增 / 删除 / 连接测试（列出工具）
  if (m === "GET" && p === "/api/mcp") {
    const cfg = loadConfig()
    return json(res, 200, { servers: cfg.mcpServers ?? {} })
  }
  // 添加模型：写入 provider（存在则追加模型，不存在则新建通道），前端模型选择器即刻可用
  if (m === "POST" && p === "/api/models/add") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const provider = String(body.provider ?? "").trim()
    const baseURL = String(body.baseURL ?? "").trim().replace(/\/+$/, "")
    const apiKey = String(body.apiKey ?? "").trim()
    const modelId = String(body.modelId ?? "").trim()
    if (!provider || !modelId) return json(res, 400, { error: "通道名 / 模型 ID 必填" })
    if (!/^[a-zA-Z0-9_-]+$/.test(provider)) return json(res, 400, { error: "通道名只能用字母数字-_（用作模型前缀，如 myapi/gpt-4o）" })
    const cfg = loadConfig()
    const isNew = !cfg.providers[provider]
    if (isNew && !baseURL) return json(res, 400, { error: "新通道必须填写 API Base URL" })
    if (baseURL && !/^https?:\/\//.test(baseURL)) return json(res, 400, { error: "Base URL 必须以 http(s):// 开头" })
    addModelToProvider(provider, baseURL || cfg.providers[provider].baseURL, apiKey || (isNew ? "REPLACE_ME" : cfg.providers[provider].apiKey), modelId, body.supportsImages === true ? true : undefined)
    // 如果当前没有可用默认模型，自动设为默认
    let autoDefault = false
    if (!cfg.model) {
      setDefaultModel(`${provider}/${modelId}`)
      autoDefault = true
    }
    broadcast({ type: "notice", text: `模型 ${provider}/${modelId} 已添加` })
    return json(res, 200, { ok: true, spec: `${provider}/${modelId}`, isNewProvider: isNew, autoDefault })
  }
  if (m === "POST" && p === "/api/mcp/add") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const name = String(body.name ?? "").trim()
    const command = String(body.command ?? "").trim()
    if (!name || !command) return json(res, 400, { error: "name/command 必填" })
    const cfg = loadConfig()
    cfg.mcpServers = cfg.mcpServers ?? {}
    cfg.mcpServers[name] = {
      command,
      args: Array.isArray(body.args) ? body.args.map(String) : [],
      env: body.env && typeof body.env === "object" ? Object.fromEntries(Object.entries(body.env).map(([k, v]) => [k, String(v)])) : undefined,
    }
    saveConfig(cfg)
    const { closeMcpTools } = await import("./mcp/client.js")
    await closeMcpTools() // 下次对话重新加载
    broadcast({ type: "notice", text: `MCP「${name}」已添加，下次对话生效` })
    return json(res, 200, { ok: true })
  }
  if (m === "POST" && p === "/api/mcp/delete") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const name = String(body.name ?? "").trim()
    const cfg = loadConfig()
    if (!cfg.mcpServers?.[name]) return json(res, 404, { error: `未找到 MCP: ${name}` })
    delete cfg.mcpServers[name]
    saveConfig(cfg)
    const { closeMcpTools } = await import("./mcp/client.js")
    await closeMcpTools()
    broadcast({ type: "notice", text: `MCP「${name}」已删除，下次对话生效` })
    return json(res, 200, { ok: true })
  }
  if (m === "POST" && p === "/api/mcp/test") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const name = String(body.name ?? "").trim()
    const cfg = loadConfig()
    const serverCfg = cfg.mcpServers?.[name]
    if (!serverCfg) return json(res, 404, { error: `未找到 MCP: ${name}` })
    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js")
      const transport = new StdioClientTransport({
        command: serverCfg.command,
        args: serverCfg.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(serverCfg.env ?? {}) },
      })
      const client = new Client({ name: "yyagent-test", version: "1.0.0" })
      await client.connect(transport)
      const list = await client.listTools()
      const toolNames = list.tools.map((t) => t.name)
      await client.close().catch(() => {})
      return json(res, 200, { ok: true, tools: toolNames })
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message })
    }
  }
  // P0-7 权限三档：T14 起按会话独立——带 sessionId 只改该会话的档位；不带 = 全局默认
  if (m === "POST" && p === "/api/permission") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const mode = String(body.mode ?? "")
    if (mode !== "confirm-all" && mode !== "danger-confirm" && mode !== "full-auto") {
      return json(res, 400, { error: `无效档位: ${mode}` })
    }
    const sid = body.sessionId ? String(body.sessionId) : null
    if (sid) {
      setSessionPermission(sid, mode)
      broadcast({ type: "permission", mode, sessionId: sid })
      return json(res, 200, { ok: true, mode, sessionId: sid })
    }
    const cfg = loadConfig()
    cfg.permission = mode
    saveConfig(cfg)
    broadcast({ type: "permission", mode })
    return json(res, 200, { ok: true, mode })
  }
  // P1-3 辅助对话：发送（并行运行，不打断主对话）/ 停止 / 清空 / 历史 —— 按会话隔离（?sid= 缺省取当前活动会话）
  if (m === "GET" && p === "/api/assist") {
    const sid = url.searchParams.get("sid") || activeAssistSessionId()
    return json(res, 200, { busy: assistBusy, busySessionId: assistBusySessionId, sessionId: sid, messages: assistHistoryOf(sid), queue: allAssistQueued().filter((q) => q.sessionId === sid) })
  }
  if (m === "POST" && p === "/api/assist") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const text = String(body.text ?? "").trim()
    const sid = body.sessionId ? String(body.sessionId) : activeAssistSessionId()
    if (!text) return json(res, 400, { error: "text 必填" })
    if (!sid) return json(res, 400, { error: "没有可用的主会话，先新建一个会话" })
    // T24 排队：busy 时入队（202），回答完 pumpAssistQueue 自动发出
    if (assistBusy) {
      const item: AssistQueueItem = { id: ++assistQueueSeq, sessionId: sid, text }
      assistQueueOf(sid).push(item)
      broadcastAssistQueue()
      return json(res, 202, { queued: true, position: assistQueueOf(sid).length, id: item.id })
    }
    void runAssistTurn(text, sid).finally(pumpAssistQueue)
    return json(res, 200, { started: true, sessionId: sid })
  }
  // T24 排队管理：立即发送 / 取回编辑 / 删除单条 / 清空（对齐主对话 /api/queue/*）
  if (m === "POST" && p === "/api/assist-queue/send") {
    const { id } = JSON.parse((await readBody(req)) || "{}")
    let target: AssistQueueItem | undefined
    for (const q of assistQueues.values()) {
      const i = q.findIndex((x) => x.id === id)
      if (i >= 0) { target = q.splice(i, 1)[0]; break }
    }
    if (!target) return json(res, 404, { error: "排队消息不存在" })
    broadcastAssistQueue()
    if (assistBusy) {
      assistQueueOf(target.sessionId).unshift(target) // 回复中：插回该会话队首优先发
      broadcastAssistQueue()
      return json(res, 200, { ok: true, prioritized: true })
    }
    void runAssistTurn(target.text, target.sessionId).finally(pumpAssistQueue)
    return json(res, 200, { ok: true, started: true })
  }
  if (m === "POST" && p === "/api/assist-queue/edit") {
    // content 缺省 = 仅出队取回（前端放回输入框）
    const { id, content } = JSON.parse((await readBody(req)) || "{}")
    let target: AssistQueueItem | undefined
    for (const q of assistQueues.values()) {
      const i = q.findIndex((x) => x.id === id)
      if (i >= 0) { target = q.splice(i, 1)[0]; break }
    }
    if (!target) return json(res, 404, { error: "排队消息不存在" })
    if (typeof content === "string" && content.trim()) target.text = content.trim()
    if (typeof content === "string" && content.trim()) {
      assistQueueOf(target.sessionId).unshift(target)
    }
    broadcastAssistQueue()
    return json(res, 200, { ok: true, text: target.text })
  }
  if (m === "DELETE" && p === "/api/assist-queue/item") {
    const { id } = JSON.parse((await readBody(req)) || "{}")
    for (const [sid, q] of assistQueues) {
      const i = q.findIndex((x) => x.id === id)
      if (i >= 0) { q.splice(i, 1); if (!q.length) assistQueues.delete(sid); break }
    }
    broadcastAssistQueue()
    return json(res, 200, { ok: true })
  }
  if (m === "DELETE" && p === "/api/assist-queue") {
    const sid = url.searchParams.get("sid")?.trim() ?? ""
    if (sid) assistQueues.delete(sid)
    else assistQueues.clear()
    broadcastAssistQueue()
    return json(res, 200, { ok: true })
  }
  if (m === "POST" && p === "/api/assist/stop") {
    assistAbort?.abort()
    return json(res, 200, { ok: true })
  }
  if (m === "DELETE" && p === "/api/assist") {
    const sid = url.searchParams.get("sid") || activeAssistSessionId()
    if (sid) assistHistories.delete(sid)
    if (sid) { assistQueues.delete(sid); broadcastAssistQueue() } // T24 清空时连排队一起清
    broadcast({ type: "assist", kind: "cleared", sessionId: sid ?? undefined })
    return json(res, 200, { ok: true })
  }
  if (m === "POST" && p === "/api/chat") {
    const body = JSON.parse((await readBody(req)) || "{}") as QueueItem & {
      contentParts?: Array<{ type: "text" | "image"; text?: string; b64?: string }>
    }
    // 纯图发送：text 可为空，但必须至少带一张图
    const hasImgPart = body.contentParts?.some((p) => p.type === "image" && p.b64)
    if (!body.sessionId || (!body.text?.trim() && !hasImgPart && !body.imagesBase64?.length)) return json(res, 400, { error: "sessionId 必填；text 与图片至少一项" })
    // P1-8 图文混排：contentParts 有值时把图片以 [IMG:n] 标记嵌回 text 原位置
    let text = body.text
    let images: string[] | undefined
    let imagesDataUrl: string[] | undefined // 落库用（前端气泡渲染）
    if (body.contentParts?.length) {
      const imgs: string[] = []
      const durls: string[] = []
      let acc = ""
      for (const part of body.contentParts) {
        if (part.type === "text") acc += part.text ?? ""
        else if (part.b64) {
          imgs.push(part.b64)
          durls.push(`data:image/png;base64,${part.b64}`)
          acc += `[IMG:${imgs.length - 1}]`
        }
      }
      text = acc.trim() || body.text
      if (imgs.length) { images = imgs; imagesDataUrl = durls }
    }
    // 纯图：无文字时给个占位标题/提示词，标题截断用
    if (!text.trim() && images?.length) text = "（用户发送了图片）"
    const item: QueueItem = { id: ++queueSeq, sessionId: body.sessionId, text, imagesBase64: images ?? body.imagesBase64, imagesDataUrl }
    // R2 多项目拆分：任务文本提及 ≥2 个已知项目工作区时，先经 LLM 拆分成每个项目一个独立会话任务
    const split = await trySplitMultiProject(String(text ?? ""))
    if (split) return json(res, 200, { started: true, split: true, tasks: split })
    // R4 会话独立：只有本会话在跑才排队；其他会话的 busy 不影响本会话立即执行
    if (sessionBusy.has(body.sessionId)) {
      queueOf(body.sessionId).push(item)
      broadcastQueue()
      return json(res, 202, { queued: true, position: queueOf(body.sessionId).length, id: item.id })
    }
    json(res, 200, { started: true })
    void runTurn(item.sessionId, item.text, item.imagesBase64, item.imagesDataUrl).finally(pumpQueue)
    return
  }
  if (m === "POST" && p === "/api/stop") {
    // R4 会话独立：{sessionId} 停指定会话；不带则停当前打开的（兜底：停任意一个跑着的）
    // 停止时若该会话有挂起的提问/权限确认，一并按默认项放行——否则 abort 后 runTurn 收尾仍可能卡在 broker.ask 的 await 上，前端输入框像"锁死"
    const body = JSON.parse((await readBody(req)) || "{}")
    const sid = String(body.sessionId ?? "") || stateActiveSid || anyBusySessionId()
    if (sid) {
      sessionAborts.get(sid)?.abort()
      brokers.get(sid)?.cancel()
    }
    return json(res, 200, { ok: true, sessionId: sid })
  }
  if (m === "DELETE" && p === "/api/queue") {
    // R4：?sid= 只清该会话队列；不传清全部
    const sid = url.searchParams.get("sid")?.trim() ?? ""
    if (sid) sessionQueues.delete(sid)
    else sessionQueues.clear()
    broadcastQueue()
    return json(res, 200, { ok: true })
  }
  // Batch G 排队消息操作：{id} 立即发送（提前出队执行）；{id, content?} 编辑（content 有值则替换文本，content 为 null/缺省 = 仅取回，由前端放回输入框）
  if (m === "POST" && p === "/api/queue/send") {
    const body = JSON.parse((await readBody(req)) || "{}")
    let item: QueueItem | undefined
    for (const q of sessionQueues.values()) {
      const idx = q.findIndex((x) => x.id === Number(body.id))
      if (idx >= 0) { [item] = q.splice(idx, 1); break }
    }
    if (!item) return json(res, 404, { error: "队列中找不到该消息" })
    broadcastQueue()
    if (sessionBusy.has(item.sessionId)) {
      // 本会话仍在跑：把这条提前到队首（下一轮优先执行）
      queueOf(item.sessionId).unshift(item)
      broadcastQueue()
      return json(res, 200, { ok: true, prioritized: true })
    }
    json(res, 200, { ok: true, started: true })
    void runTurn(item.sessionId, item.text, item.imagesBase64, item.imagesDataUrl).finally(pumpQueue)
    return
  }
  if (m === "POST" && p === "/api/queue/edit") {
    const body = JSON.parse((await readBody(req)) || "{}")
    let target: QueueItem | undefined
    let targetQ: QueueItem[] | undefined
    for (const q of sessionQueues.values()) {
      const found = q.find((x) => x.id === Number(body.id))
      if (found) { target = found; targetQ = q; break }
    }
    if (!target || !targetQ) return json(res, 404, { error: "队列中找不到该消息" })
    if (body.content != null) {
      const content = String(body.content).trim()
      if (!content) return json(res, 400, { error: "编辑内容不能为空" })
      target.text = content
    } else {
      // 取回模式：从队列移除（前端放回输入框编辑后重新发送）
      targetQ.splice(targetQ.indexOf(target), 1)
    }
    broadcastQueue()
    return json(res, 200, { ok: true, text: body.content != null ? target.text : String(body.content ?? "") })
  }
  if (m === "DELETE" && p === "/api/queue/item") {
    const body = JSON.parse((await readBody(req)) || "{}")
    let removed = false
    for (const q of sessionQueues.values()) {
      const idx = q.findIndex((x) => x.id === Number(body.id))
      if (idx >= 0) { q.splice(idx, 1); removed = true; break }
    }
    if (!removed) return json(res, 404, { error: "队列中找不到该消息" })
    broadcastQueue()
    return json(res, 200, { ok: true })
  }
  // P2-2 消息撤回/编辑：停止模型（若在跑）→ 截掉 ts 及之后全部消息 → （编辑则替换内容重新入列，撤回直接删）
  const recallEdit = async (mode: "recall" | "edit"): Promise<void> => {
    const body = JSON.parse((await readBody(req)) || "{}")
    const sessionId = String(body.sessionId ?? "")
    const ts = Number(body.ts)
    const file = loadSession(sessionId)
    if (!file) return json(res, 404, { error: "会话不存在" })
    if (!Number.isFinite(ts)) return json(res, 400, { error: "ts 非法" })
    // 该会话正在跑 → 先停止模型思考（撤回的语义就是"取回来重说"）；挂起的提问/权限确认一并放行，防卡在 await
    if (sessionBusy.has(sessionId)) {
      sessionAborts.get(sessionId)?.abort()
      brokers.get(sessionId)?.cancel()
      // 等 runTurn 收尾（busy 翻回 false，最多 5s）
      for (let i = 0; i < 50 && sessionBusy.has(sessionId); i++) await new Promise((r) => setTimeout(r, 100))
    }
    // 重新加载（runTurn 收尾可能已落盘新消息）
    const fresh = loadSession(sessionId)
    if (!fresh) return json(res, 404, { error: "会话不存在" })
    const before = truncateFrom(fresh.messages, ts)
    if (!before) return json(res, 404, { error: "消息不存在（可能已被清理）" })
    let newContent = ""
    let editImagesDataUrl: string[] | undefined
    if (mode === "edit") {
      newContent = String(body.content ?? "").trim()
      if (!newContent) return json(res, 400, { error: "编辑内容不能为空" })
      // 只取原消息的图片透传给 runTurn；user 消息本身由 runTurn 统一落库（这里再 push 会重复）
      const target = fresh.messages.find((m) => m.ts === ts)
      editImagesDataUrl = target?.images
    }
    fresh.meta.updatedAt = Date.now()
    fresh.meta.ctxPct = calcCtxPct(before)
    persist(fresh.meta, before)
    broadcast({ type: "reload", sessionId })
    // notice 带 sessionId：只有对应会话的界面显示这条提示（撤回 A 会话不该在 B 会话界面弹「消息已撤回」）
    broadcast({ type: "notice", sessionId, text: mode === "recall" ? "消息已撤回" : "消息已更新，重新发送中" })
    if (mode === "edit") {
      // 编辑 = 取回修改后立即重新发送（user 消息 + assistant 回复都由 runTurn 走正常流程）
      json(res, 200, { ok: true, resent: true })
      const imagesBase64 = (editImagesDataUrl ?? [])
        .map((d) => /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(d)?.[1])
        .filter((b): b is string => !!b)
      void runTurn(sessionId, newContent, imagesBase64.length ? imagesBase64 : undefined, editImagesDataUrl).finally(pumpQueue)
      return
    }
    return json(res, 200, { ok: true })
  }
  // Batch G 消息「取回编辑」：立即停止模型思考 + 截断该消息及之后 + 原文返回给前端放回输入框。
  // 与旧 /api/messages/edit 的区别：截断发生在点击「编辑」时（用户改完自己决定何时发送，发送走普通 /api/chat）
  if (m === "POST" && p === "/api/messages/takeback") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const sessionId = String(body.sessionId ?? "")
    const ts = Number(body.ts)
    const file = loadSession(sessionId)
    if (!file) return json(res, 404, { error: "会话不存在" })
    if (!Number.isFinite(ts)) return json(res, 400, { error: "ts 非法" })
    // 该会话正在跑 → 先停止模型思考（取回的语义就是"停下来重说"）；挂起的提问/权限确认一并放行
    if (sessionBusy.has(sessionId)) {
      sessionAborts.get(sessionId)?.abort()
      brokers.get(sessionId)?.cancel()
      for (let i = 0; i < 50 && sessionBusy.has(sessionId); i++) await new Promise((r) => setTimeout(r, 100))
    }
    const fresh = loadSession(sessionId)
    if (!fresh) return json(res, 404, { error: "会话不存在" })
    const target = fresh.messages.find((x) => x.ts === ts && x.role === "user")
    if (!target) return json(res, 404, { error: "消息不存在（仅支持取回用户消息）" })
    const before = truncateFrom(fresh.messages, ts)
    if (!before) return json(res, 404, { error: "消息不存在（可能已被清理）" })
    fresh.meta.updatedAt = Date.now()
    fresh.meta.ctxPct = calcCtxPct(before)
    persist(fresh.meta, before)
    broadcast({ type: "reload", sessionId })
    broadcast({ type: "notice", sessionId, text: "已停止模型并取回消息，可在输入框重新编辑" })
    return json(res, 200, { ok: true, content: target.content, images: target.images ?? [] })
  }
  if (m === "POST" && p === "/api/messages/recall") { await recallEdit("recall"); return }
  if (m === "POST" && p === "/api/messages/edit") { await recallEdit("edit"); return }
  // D6 撤销某轮模型对文件的修改：{sessionId, ts}。按内存快照逐文件恢复原内容（write 新建且原本不存在 → 删除）。
  // 撤销后清除该轮快照（不可重复撤）；会话 busy 时拒绝（模型可能正改同一批文件）。
  if (m === "POST" && p === "/api/sessions/undo-files") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const sessionId = String(body.sessionId ?? "")
    const ts = Number(body.ts)
    const per = undoSnapshots.get(sessionId)
    if (!per || !per.has(ts)) return json(res, 404, { error: "没有该轮的文件快照（可能已撤销或来自更早的会话进程）" })
    if (sessionBusy.has(sessionId)) return json(res, 409, { error: "任务进行中，请先停止再撤销" })
    const edits = per.get(ts)!
    const restored: string[] = []
    const failed: string[] = []
    for (const f of edits) {
      try {
        if (f.snapshot == null) {
          // 原本不存在的文件（本轮新建）→ 删除
          if (fs.existsSync(f.path)) fs.unlinkSync(f.path)
          restored.push(`${f.path}（删除新建）`)
        } else {
          fs.mkdirSync(path.dirname(f.path), { recursive: true })
          fs.writeFileSync(f.path, f.snapshot, "utf8")
          restored.push(f.path)
        }
      } catch {
        failed.push(f.path)
      }
    }
    per.delete(ts)
    broadcast({ type: "notice", text: `已撤销 ${restored.length} 个文件的修改${failed.length ? `，${failed.length} 个失败` : ""}` })
    return json(res, 200, { ok: true, restored: restored.length, failed })
  }
  // 回复评分：{sessionId, ts, feedback: "up"|"down"|null}。点赞/点踩落在消息上并进入会话记忆，
  // 模型每次生成都会被提醒「回答会被用户评分」，评分反馈注入 systemSuffix。
  if (m === "POST" && p === "/api/messages/feedback") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const sessionId = String(body.sessionId ?? "")
    const ts = Number(body.ts)
    const fb = body.feedback === "up" || body.feedback === "down" ? body.feedback : null
    const file = loadSession(sessionId)
    if (!file) return json(res, 404, { error: "会话不存在" })
    if (!Number.isFinite(ts)) return json(res, 400, { error: "ts 非法" })
    const target = file.messages.find((x) => x.ts === ts && x.role === "assistant")
    if (!target) return json(res, 404, { error: "消息不存在" })
    if (fb) target.feedback = fb
    else delete target.feedback
    file.meta.updatedAt = Date.now()
    persist(file.meta, file.messages)
    broadcast({ type: "reload", sessionId })
    return json(res, 200, { ok: true, feedback: fb })
  }
  // 重新生成：{sessionId, ts}（ts = assistant 消息）。截掉该回复及其后内容，用原 user 消息（含图片）重跑一轮。
  if (m === "POST" && p === "/api/messages/regenerate") {
    const body = JSON.parse((await readBody(req)) || "{}")
    const sessionId = String(body.sessionId ?? "")
    const ts = Number(body.ts)
    if (!Number.isFinite(ts)) return json(res, 400, { error: "ts 非法" })
    if (sessionBusy.has(sessionId)) return json(res, 409, { error: "任务进行中，请先停止再重新生成" })
    const file = loadSession(sessionId)
    if (!file) return json(res, 404, { error: "会话不存在" })
    const idx = file.messages.findIndex((x) => x.ts === ts && x.role === "assistant")
    if (idx < 0) return json(res, 404, { error: "消息不存在" })
    // 找它前面的 user 提问；图片 dataUrl 原样透传给 runTurn
    let userIdx = -1
    for (let i = idx - 1; i >= 0; i--) {
      if (file.messages[i].role === "user") { userIdx = i; break }
    }
    if (userIdx < 0) return json(res, 400, { error: "找不到这条回复对应的提问" })
    const userMsg = file.messages[userIdx]
    // 消息体里的 [图片n] 占位换回 [IMG:n] 标记（runTurn 发给引擎的 text 需要内部标记）
    const text = userMsg.content.replace(/\[图片(\d+)\]/g, (_, n) => `[IMG:${Number(n) - 1}]`)
    const images = userMsg.images ?? []
    const before = file.messages.slice(0, userIdx)
    file.meta.updatedAt = Date.now()
    file.meta.ctxPct = calcCtxPct(before)
    persist(file.meta, before)
    broadcast({ type: "reload", sessionId })
    void runTurn(sessionId, text, images.length ? images : undefined, images.length ? images : undefined).finally(pumpQueue)
    return json(res, 200, { ok: true, regenerated: true })
  }
  // #29 本地文件读取（前端预览/下载用）：?p=绝对路径。仅允许常见媒体/文档扩展名，防任意文件读取
  if (m === "GET" && p === "/api/file") {
    const target = url.searchParams.get("p")?.trim() ?? ""
    if (!target) return json(res, 400, { error: "缺少 p 参数" })
    const ext = path.extname(target).toLowerCase()
    const ALLOWED = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".csv", ".xlsx", ".xls", ".docx", ".doc", ".pdf", ".mp4", ".zip", ".txt", ".json", ".md", ".html", ".htm", ".log", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".py", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".hpp", ".cs", ".sh", ".bat", ".ps1", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".xml", ".sql", ".env", ".gitignore"])
    if (!ALLOWED.has(ext)) return json(res, 403, { error: `不允许读取该类型文件: ${ext || "(无扩展名)"}` })
    try {
      const resolved = path.resolve(target)
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return json(res, 404, { error: "文件不存在" })
      const MIME: Record<string, string> = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
        ".bmp": "image/bmp", ".svg": "image/svg+xml", ".csv": "text/csv", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls": "application/vnd.ms-excel", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".doc": "application/msword", ".pdf": "application/pdf", ".mp4": "video/mp4", ".zip": "application/zip",
        ".txt": "text/plain", ".json": "application/json", ".md": "text/markdown",
        ".html": "text/html", ".htm": "text/html", ".log": "text/plain", ".xml": "text/xml",
        ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript", ".ts": "text/plain", ".tsx": "text/plain", ".jsx": "text/plain",
        ".css": "text/css", ".py": "text/plain", ".java": "text/plain", ".go": "text/plain", ".rs": "text/plain", ".c": "text/plain", ".cpp": "text/plain", ".h": "text/plain", ".hpp": "text/plain", ".cs": "text/plain",
        ".sh": "text/plain", ".bat": "text/plain", ".ps1": "text/plain", ".yml": "text/plain", ".yaml": "text/plain", ".toml": "text/plain", ".ini": "text/plain", ".cfg": "text/plain", ".conf": "text/plain", ".sql": "text/plain",
      }
      const data = fs.readFileSync(resolved)
      res.writeHead(200, {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Content-Length": data.length,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(resolved))}`,
      })
      res.end(data)
      return // 已完整响应，绝不能再落到底部 404 json()（否则二次写头崩溃）
    } catch (e) {
      return json(res, 500, { error: `读取失败: ${(e as Error).message}` })
    }
  }
  // #30 P1-10 场景数据库：列表 / 读取（?q=&tag=）/ 写入（upsert）/ 删除
  if (m === "GET" && p === "/api/db") {
    return json(res, 200, { dbs: listDbs(), builtin: BUILTIN_DBS })
  }
  mt = p.match(/^\/api\/db\/([a-zA-Z][a-zA-Z0-9_-]{0,31})$/)
  if (mt && m === "GET") {
    const name = mt[1]
    if (!isValidDbName(name)) return json(res, 400, { error: "库名非法" })
    const q = url.searchParams.get("q") ?? undefined
    const tag = url.searchParams.get("tag") ?? undefined
    return json(res, 200, { name, label: BUILTIN_DBS[name]?.label, records: queryDb(name, q, tag) })
  }
  if (mt && m === "POST") {
    const name = mt[1]
    if (!isValidDbName(name)) return json(res, 400, { error: "库名非法" })
    const body = JSON.parse((await readBody(req)) || "{}")
    const saved = upsertDbRecord(name, body.record ?? {})
    return json(res, 200, { ok: true, record: saved })
  }
  mt = p.match(/^\/api\/db\/([a-zA-Z][a-zA-Z0-9_-]{0,31})\/([\w-]+)$/)
  if (mt && m === "DELETE") {
    const ok = deleteDbRecord(mt[1], mt[2])
    return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "记录不存在" })
  }
  // T43 表格导出 xlsx：前端把渲染出的 <table> 抓成二维数组 POST 过来，服务端用 exceljs 生成后直接回二进制。
  // 与 /api/file 同理——writeHead + end 之后必须 return，绝不能落到底部 404 的 json()（二次写头会崩）。
  if (m === "POST" && p === "/api/export/xlsx") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}") as { name?: string; sheet?: string; rows?: unknown[][] }
      const rows: unknown[][] = Array.isArray(body.rows) ? body.rows : []
      if (!rows.length) return json(res, 400, { error: "rows 为空" })
      const mod: any = await import("exceljs")
      const ExcelJS: any = mod.default ?? mod
      const WorkbookCtor = ExcelJS.Workbook ?? mod.Workbook
      const wb = new WorkbookCtor()
      const ws = wb.addWorksheet(String(body.sheet || "Sheet1").slice(0, 31) || "Sheet1")
      // 单元格取值：前端送过来的是 DOM 文本，纯数字要还原成数字类型，否则 Excel 里没法直接求和/排序。
      // 但要避开「看起来像数字的编号」——前导零（007 / 0755）和超过 15 位的长数字（订单号/身份证）保持文本。
      const cellOf = (c: unknown): string | number => {
        if (c == null) return ""
        const s = String(c)
        if (s.length <= 15 && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(s)) return Number(s)
        return s
      }
      for (const r of rows) ws.addRow((Array.isArray(r) ? r : [r]).map(cellOf))
      ws.getRow(1).font = { bold: true } // 前端把表头放在第 1 行，这里顺带加粗
      // 列宽按内容自适应：中日韩全角字符按 2 个宽度计，上限 60 防止超宽列
      let cols = 1
      for (const r of rows) cols = Math.max(cols, Array.isArray(r) ? r.length : 1)
      for (let c = 1; c <= cols; c++) {
        let w = 8
        for (const r of rows) {
          const s = String(cellOf(Array.isArray(r) ? r[c - 1] : undefined))
          let len = 0
          for (const ch of s) len += /[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1
          if (len + 2 > w) w = len + 2
        }
        ws.getColumn(c).width = Math.min(w, 60)
      }
      const buf = await wb.xlsx.writeBuffer()
      const data = Buffer.from(buf as ArrayBuffer)
      const name = String(body.name || "表格").replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 60) || "表格"
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Length": data.length,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name + ".xlsx")}`,
      })
      res.end(data)
      return
    } catch (e) {
      return json(res, 500, { error: `导出 xlsx 失败: ${(e as Error).message}` })
    }
  }
  json(res, 404, { error: `no route: ${m} ${p}` })
}

export function startGateway(port = PORT): void {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}`)
    if (url.pathname.startsWith("/api/")) {
      handleApi(req, res, url).catch((e) => json(res, 500, { error: String(e) }))
      return
    }
    serveStatic(res, url.pathname)
  })
  const wss = new WebSocketServer({ server, path: "/ws" })
  wss.on("connection", (ws) => {
    wsClients.add(ws)
    ws.send(JSON.stringify({ type: "state", ...statePayload() }))
    ws.on("close", () => wsClients.delete(ws))
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw))
        // R4 会话独立 broker：answer 带 sessionId 路由到对应会话的提问桥；不带则发给任一有 pending 的
        if (msg.type === "answer") {
          const sid = String(msg.sessionId ?? "")
          if (sid && brokers.has(sid)) brokers.get(sid)!.answer(String(msg.answer ?? ""))
          else {
            for (const b of brokers.values()) {
              if (b.pending) { b.answer(String(msg.answer ?? "")); break }
            }
          }
        }
      } catch {
        /* 忽略非法帧 */
      }
    })
  })
  // 权限问题轮询推送（broker 是同步状态，300ms 轮询足够）；R4：返回第一个有 pending 的会话的问题，带 sessionId
  let lastQ: string | null = null
  setInterval(() => {
    let pendingSid: string | null = null
    let q: { question: string; options?: string[]; defaultOption?: string } | null = null
    for (const [sid, b] of brokers) {
      if (b.pending) { pendingSid = sid; q = b.pending; break }
    }
    const key = q ? `${pendingSid}|${q.question}|${q.options?.join(",") ?? ""}` : null
    if (key !== lastQ) {
      lastQ = key
      broadcast({ type: "question", sessionId: pendingSid, q })
    }
  }, 300)

  // P2-4 成果分享：HOST 默认 0.0.0.0，局域网设备能直接打开 /api/file 分享链接
  server.listen(port, HOST, () => {
    console.log(`[yyagent-gateway] http://127.0.0.1:${port} （监听 ${HOST}；0.0.0.0 = 局域网可访问分享链接）`)
    // P1-8 默认 MCP 接入（Edge + Tabbit），仅首次且无配置时预置
    import("./agent/config.js").then(({ ensureDefaultMcpServers }) => ensureDefaultMcpServers()).catch(() => {})
    // T45 用量账本一次性回填：把账本上线前各会话的累计 usage 摊到消息所在的天（幂等，见 usage.ts）
    try {
      const n = backfillUsage()
      if (n > 0) console.log(`[yyagent-gateway] 用量账本回填完成：${n} 个历史会话（近似摊分，标记 approx）`)
    } catch {
      /* 回填失败不影响网关启动 */
    }
    // T66 启动清理账本孤儿行：会话已删但账本还留着的行（删除会话未剪枝的历史遗留）——
    // 保证不变量「账本总额 === 会话累计总额」恒成立（check-t45 F4 活体断言）
    try {
      pruneUsage(new Set(listSessions().map((m) => m.id)))
    } catch {
      /* 剪枝失败不影响启动 */
    }
    scheduleAllTasks()
  })
}

// 直接运行本文件 = 启动网关（Electron/浏览器共用入口）
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startGateway()
}
