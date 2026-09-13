import React, { useCallback, useEffect, useRef, useState } from "react"
import { Box, Text, render, useApp, useInput, useCursor } from "ink"
import { createRequire } from "node:module"
// ink 未公开导出 getAbsoluteContentPosition（Yoga 布局绝对坐标），从包内路径直取。
// 用它替代手算列偏移：侧栏是 flex 布局会被挤压（实测 width=30 在 100 列下只渲染 23 列），
// 任何"侧栏宽 + 常数"公式都会偏，只有布局引擎自己的坐标是准的。
const __inkRoot = createRequire(import.meta.url).resolve("ink").replace(/[\\/]build[\\/]index\.js$/, "")
const getAbsoluteContentPosition: (n: any) => { x: number; y: number } | undefined =
  await import("file://" + __inkRoot + "/build/layout.js").then((m: any) => m.getAbsoluteContentPosition)
import { runAgentStream, compactNow } from "../agent/loop.js"
import { loadConfig, addProvider, setDefaultModel, saveConfig } from "../agent/config.js"
import { loadPlugins, type LoadedPlugin } from "../plugins/loader.js"
import { loadMcpTools } from "../mcp/client.js"
import { broker } from "../agent/ask.js"
import { SIDE_PROTOCOL } from "../agent/side-protocol.js"
import { readTodo, type TodoItem } from "../agent/todo.js"
import { isImageFile, describeImage, readTextAttachment, attachmentExists, mainModelSupportsImages } from "../agent/vision.js"
import {
  createSession,
  listSessions,
  loadSession,
  persist,
  deleteSession,
  toCoreMessages,
  type SessionMeta,
  type StoredMessage,
} from "../session/store.js"
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs"
import { countTokens } from "gpt-tokenizer"
import stringWidth from "string-width"
import { homedir } from "node:os"
import { spawn } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { attachMouse, setMouseEnabled, isMouseEnabled, mouseEventCount, type MouseEvent } from "./mouse.js"
import { createFilteredStdin } from "./filtered-stdin.js"
import { tlog } from "./debug-log.js"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const CONFIG_TITLE = "⚙ 模型配置"

/** 鼠标事件队列：过滤 stdin 层推入，App 按帧消费 */
const mouseEventsQueue: MouseEvent[] = []

const CONFIG_CONTEXT = `【本会话专用上下文：帮用户配置模型通道】
配置文件：~/.yyagent/config.json（Windows: C:\\Users\\<用户>\\.yyagent\\config.json），用 read/edit 工具直接修改。
结构：
{
  "providers": { "<通道名>": { "baseURL": "https://.../v1", "apiKey": "sk-..." } },
  "model": "<通道名>/<模型ID>",
  "visionModel": "<通道名>/<识图模型ID>"
}
规则：
- baseURL 必须是 OpenAI 兼容端点（/v1 结尾）
- 新增通道 = providers 加一项；设默认模型 = 改 model 字段；识图模型 = visionModel
- 用户一句话给出（通道名/baseURL/key/模型ID）就要一次完成全部修改，改完 read 读回校验 JSON 合法，并告知重启 TUI 生效（配置有内存缓存）
- TUI 内用户也可以用 /model add <通道> <baseURL> <key> <模型ID> 命令
- 绝不回显完整 apiKey，只显示前 8 位`

interface StepRecord {
  id: string
  name: string
  argsSummary: string
  input?: string
  output?: string
  pending: boolean
}

function relTime(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return "刚刚"
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return new Date(ts).toLocaleDateString("zh-CN")
}

function displayWidth(s: string): number {
  // 精确宽度：emoji/全角符号按终端实际渲染计算（string-width）
  return stringWidth(s)
}

function truncateLines(s: string, maxLines: number): { text: string; clipped: boolean } {
  const lines = s.split(/\r?\n/)
  if (lines.length <= maxLines) return { text: lines.join("\n"), clipped: false }
  return { text: lines.slice(0, maxLines).join("\n"), clipped: true }
}

/** 按显示宽度把文本包裹成物理行（行级滚动：长消息按行切片显示的基础） */
function wrapText(text: string, width: number): string[] {
  const w = Math.max(20, width)
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) {
      out.push("")
      continue
    }
    let cur = ""
    let curW = 0
    for (const ch of raw) {
      const cw = displayWidth(ch)
      if (curW + cw > w && cur) {
        out.push(cur)
        cur = ch
        curW = cw
      } else {
        cur += ch
        curW += cw
      }
    }
    out.push(cur)
  }
  return out
}

const PERM_LABEL: Record<string, string> = {
  "confirm-all": "全部更改前确认",
  "danger-confirm": "危险权限确认",
  "full-auto": "完全允许",
}

export function renderTui(): void {
  // 鼠标解析器：直接消费原始流；键盘数据经过滤（摘除鼠标序列）后喂给 Ink
  const mouseHandler = attachMouse((e) => mouseEventsQueue.push(e))
  const stdin = createFilteredStdin((raw) => mouseHandler(raw))
  tlog("=== tui-start", `pid=${process.pid}`, `isTTY=${process.stdin.isTTY}`)
  process.on("uncaughtException", (e) => tlog("UNCAUGHT", e.stack ?? e.message))
  process.on("unhandledRejection", (e) => tlog("UNHANDLED", String(e)))
  render(<App />, { stdin: stdin as unknown as NodeJS.ReadStream, exitOnCtrlC: false })
  tlog("=== tui-rendered")
}

export function App(): React.ReactElement {
  const { exit } = useApp()
  // IME 候选框定位：每帧把终端逻辑光标放到输入行光标处（Windows Terminal 按逻辑光标弹输入法选字框）
  const { setCursorPosition } = useCursor()
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [active, setActive] = useState<SessionMeta | null>(null)
  const [messages, setMessages] = useState<StoredMessage[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [busyStatus, setBusyStatus] = useState("思考中")
  const [streaming, setStreaming] = useState<string | null>(null)
  const [sidebar, setSidebar] = useState(true)
  const [focusSidebar, setFocusSidebar] = useState(false)
  const [selected, setSelected] = useState(0)
  const [search, setSearch] = useState("")
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([])
  const [mcpInfo, setMcpInfo] = useState<string>("")
  const [notice, setNotice] = useState("")
  const [tick, setTick] = useState(0)
  const [todo, setTodo] = useState<TodoItem[]>([])
  const [queue, setQueue] = useState<string[]>([])
  const [queueSel, setQueueSel] = useState(0)
  const [attachments, setAttachments] = useState<string[]>([])
  const [scrollOffset, setScrollOffset] = useState(0)
  const [retryInfo, setRetryInfo] = useState<string | null>(null)
  const [tokenStats, setTokenStats] = useState({ in: 0, out: 0, cached: 0 })
  const [ctxPct, setCtxPct] = useState(0)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [inputReady, setInputReady] = useState(true)
  const [sideOpen, setSideOpen] = useState(false)
  const [sideTab, setSideTab] = useState<"chat" | "tasks">("chat")
  const [sideFocus, setSideFocus] = useState(false)
  const [sideSel, setSideSel] = useState(0)
  const [sideInput, setSideInput] = useState("")
  const [sideBusy, setSideBusy] = useState(false)
  const [sideStreaming, setSideStreaming] = useState<string | null>(null)
  const [sideMsgs, setSideMsgs] = useState<StoredMessage[]>([])
  const [sideTargetId, setSideTargetId] = useState<string | null>(null)
  const [sideSendHover, setSideSendHover] = useState(false)
  const sideSendHoverRef = useRef(false)
  const [sidebarHover, setSidebarHover] = useState(-1)
  const sidebarHoverRef = useRef(-1)
  const [visionHover, setVisionHover] = useState(-1)
  const visionHoverRef = useRef(-1)
  const [showModelPanel, setShowModelPanel] = useState(false)
  const [pickerSel, setPickerSel] = useState(0)
  /** 鼠标 hover 的高亮行（只改显示，不影响滚动锚点 pickerSel） */
  const [hoverModelIdx, setHoverModelIdx] = useState(-1)
  const hoverModelIdxRef = useRef(-1)
  const [sendHover, setSendHover] = useState(false)
  const sendHoverRef = useRef(false)
  const [runSteps, setRunSteps] = useState<StepRecord[]>([])
  const [stepSel, setStepSel] = useState(0)
  const [stepMode, setStepMode] = useState<"collapsed" | "list" | "card">("collapsed")
  const [cardOffset, setCardOffset] = useState(0)
  const queueRef = useRef<string[]>([])
  const sendRef = useRef<((text: string) => Promise<void>) | null>(null)
  const handleCommandRef = useRef<((text: string) => Promise<void>) | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollDraggingRef = useRef(false)
  const messagesLenRef = useRef(0)
  useEffect(() => {
    messagesLenRef.current = messages.length
  }, [messages])
  /** 行级滚动：可滚动行数上限（渲染期同步，供鼠标点击/拖动闭包读取） */
  const totalScrollRowsRef = useRef(0)
  const filteredRef = useRef<SessionMeta[]>([])
  useEffect(() => {
    filteredRef.current = filtered
  })
  const runStepsRef = useRef<StepRecord[]>([])
  const busyRef = useRef(false)
  const watchRef = useRef(false)
  const [, setAskTick] = useState(0)

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    runStepsRef.current = runSteps
  }, [runSteps])

  useEffect(() => {
    const t = setInterval(() => {
      setTick((x) => x + 1)
      setTodo(readTodo())
      // 辅助对话信箱：SEND 消息自动入主对话队列（空闲则立即执行）
      try {
        const p = join(homedir(), ".yyagent", "inbox.json")
        if (existsSync(p)) {
          const raw = readFileSync(p, "utf8").trim()
          if (raw) {
            const arr = JSON.parse(raw) as Array<{ task: string; ts: number }>
            if (Array.isArray(arr) && arr.length) {
              writeFileSync(p, "[]")
              for (const it of arr) {
                queueRef.current = [...queueRef.current, it.task]
              }
              setQueue(queueRef.current)
              setQueueSel(Math.max(0, queueRef.current.length - 1))
              pushNotice(`⟡ 辅助对话发来 ${arr.length} 条消息，已入队`)
              if (!busyRef.current) {
                const [next, ...rest] = queueRef.current
                queueRef.current = rest
                setQueue(rest)
                if (next) void sendRef.current?.(next)
              }
            }
          }
        }
      } catch {
        /* 信箱读取失败忽略 */
      }
    }, 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const t = setInterval(() => setAskTick((x) => x + 1), 200)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    void loadPlugins().then((r) => setPlugins(r.loaded))
    void loadMcpTools().then((r) =>
      setMcpInfo(r.servers.length ? r.servers.join(" ") : r.errors.length ? `错误:${r.errors.length}` : ""),
    )
  }, [])

  const openSession = useCallback((meta: SessionMeta) => {
    const file = loadSession(meta.id)
    setActive(meta)
    setMessages(file?.messages ?? [])
    setScrollOffset(0)
    setCtxPct(meta.ctxPct ?? calcCtxPct(file?.messages ?? []))
    // 载入该会话最后一条 assistant 消息的步骤记录供回看
    const last = [...(file?.messages ?? [])].reverse().find((m) => m.role === "assistant" && m.steps?.length)
    setRunSteps(
      (last?.steps ?? []).map((s, i) => ({ ...s, id: `hist-${i}`, pending: false })),
    )
    setStepMode("collapsed")
    setStepSel(0)
  }, [])

  useEffect(() => {
    watchRef.current = loadConfig().watch ?? false
    let list = listSessions()
    if (!list.some((s) => s.title === CONFIG_TITLE)) {
      createSession(process.cwd(), undefined, CONFIG_TITLE)
      list = listSessions()
    }
    setSessions(list)
    const cwd = process.cwd()
    const target = list.find((s) => s.title !== CONFIG_TITLE) ?? list[0]
    if (target) {
      openSession(target)
    } else {
      const meta = createSession(cwd)
      setSessions([meta])
      setActive(meta)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = sessions.filter((s) =>
    search ? s.title.toLowerCase().includes(search.toLowerCase()) : true,
  )

  const pushNotice = useCallback((msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(""), 8000)
  }, [])

  const updateActive = useCallback((mut: (m: SessionMeta) => void, msgs: StoredMessage[]) => {
    setActive((prev) => {
      if (!prev) return prev
      const next = { ...prev, updatedAt: Date.now() }
      mut(next)
      persist(next, msgs)
      setSessions(listSessions())
      return next
    })
  }, [])

  const setSessionModel = useCallback((spec: string) => {
    setActive((prev) => {
      if (!prev) return prev
      const next = { ...prev, model: spec, updatedAt: Date.now() }
      const file = loadSession(prev.id)
      persist(next, file?.messages ?? [])
      return next
    })
    setSessions(listSessions())
  }, [])

  const handleCommand = useCallback(
    async (raw: string): Promise<void> => {
      tlog("cmd:", raw.slice(0, 80))
      const [cmd, ...args] = raw.slice(1).split(/\s+/)
      const cfg = loadConfig()
      switch (cmd) {
        case "help":
          pushNotice(
            "/new 新对话 · /del 删除当前会话 · /perm 权限档 · /watch [off] 监工模式（任务完成自动检查+回传） · /long 长任务压缩 · /model [spec|default spec|add ...] · /models · /vision 识图模型 · /attach 附件 · /cwd 目录 · /mcp · /tasks · /task run · /search 全文搜索 · /side <任务> 辅助对话 · /plugins · /wp 白皮书 · /open · /export · /exit",
          )
          break
        case "new": {
          const meta = createSession(active?.cwd ?? process.cwd(), active?.model)
          setSessions(listSessions())
          setActive(meta)
          setMessages([])
          setSelected(0)
          setScrollOffset(0)
          break
        }
        case "del": {
          if (!active) break
          deleteSession(active.id)
          const rest = listSessions()
          setSessions(rest)
          if (rest.length) openSession(rest[0])
          else {
            const meta = createSession(active.cwd, active.model)
            setSessions([meta])
            setActive(meta)
            setMessages([])
          }
          pushNotice("会话已删除")
          break
        }
        case "plan": {
          pushNotice("计划模式已下线：需求提炼内置在辅助对话中（默认开启）")
          break
        }
        case "go": {
          void send("按计划执行，每完成一步用 todo_write 更新进度")
          break
        }
        case "long": {
          const on = !cfg.longTask
          saveConfig({ ...cfg, longTask: on })
          pushNotice(on ? "长任务模式已开启：上下文超 60% 自动滚动压缩（保留结论，剔除过程细节）" : "长任务模式已关闭：90% 兜底压缩")
          break
        }
        case "watch": {
          const on = args[0] !== "off"
          watchRef.current = on
          saveConfig({ ...cfg, watch: on })
          pushNotice(
            on
              ? "监工模式已开启：主对话任务完成后自动调辅助对话检查；有遗漏/新需求时自动发回主对话执行"
              : "监工模式已关闭",
          )
          break
        }
        case "perm": {
          if (!args[0]) {
            pushNotice(`当前权限档: ${cfg.permission ?? "danger-confirm"}（/perm confirm-all | danger-confirm | full-auto）`)
            break
          }
          if (!["confirm-all", "danger-confirm", "full-auto"].includes(args[0])) {
            pushNotice("档位: confirm-all(全部更改前确认) / danger-confirm(危险权限确认) / full-auto(完全允许)")
            break
          }
          saveConfig({ ...cfg, permission: args[0] as typeof cfg.permission })
          pushNotice(`权限档已设为 ${PERM_LABEL[args[0]]}`)
          break
        }
        case "vision": {
          if (!args[0]) {
            pushNotice(`识图模型: ${cfg.visionModel ?? "（未设置）"}（/vision <provider/model>）`)
            break
          }
          saveConfig({ ...cfg, visionModel: args[0] })
          pushNotice(`识图模型已设为 ${args[0]}（回答仍由默认模型思考）`)
          break
        }
        case "attach": {
          if (!args[0]) {
            pushNotice(attachments.length ? `附件: ${attachments.join(", ")}` : "无附件 · 用法: /attach <文件路径> | /attach clear")
            break
          }
          if (args[0] === "clear") {
            setAttachments([])
            pushNotice("附件已清空")
            break
          }
          const abs = resolve(active?.cwd ?? process.cwd(), args.join(" "))
          if (!attachmentExists(abs)) {
            pushNotice(`文件不存在: ${abs}`)
            break
          }
          setAttachments((a) => [...a, abs])
          pushNotice(`已附加: ${abs}${isImageFile(abs) ? "（图片，发送时自动识图）" : ""}`)
          break
        }
        case "cwd": {
          if (!args[0]) {
            pushNotice(`工作目录: ${active?.cwd ?? process.cwd()}`)
            break
          }
          const target = resolve(active?.cwd ?? process.cwd(), args[0])
          if (!existsSync(target) || !statIsDir(target)) {
            pushNotice(`目录不存在: ${target}`)
            break
          }
          updateActive((m) => (m.cwd = target), messages)
          pushNotice(`工作目录: ${target}`)
          break
        }
        case "engine": {
          if (!args[0]) {
            pushNotice(`搜索引擎: ${cfg.searchEngine ?? "bing"}（/engine bing | duckduckgo，默认必应）`)
            break
          }
          if (!["bing", "duckduckgo"].includes(args[0])) {
            pushNotice("引擎: bing（默认，直连）| duckduckgo（需 HTTPS_PROXY 出海）")
            break
          }
          saveConfig({ ...cfg, searchEngine: args[0] as typeof cfg.searchEngine })
          pushNotice(`搜索引擎已设为 ${args[0]}`)
          break
        }
        case "wp": {
          const wpPath = join(active?.cwd ?? process.cwd(), "AGENT-WHITEPAPER.md")
          if (existsSync(wpPath)) {
            spawn("cmd", ["/c", "start", "", wpPath], { detached: true, stdio: "ignore" }).unref()
            pushNotice(`已打开 ${wpPath}（agent 会实时维护；/wp 再打开）`)
          } else {
            pushNotice("正在让 agent 生成项目技术白皮书…")
            void send("请为当前项目生成技术白皮书 AGENT-WHITEPAPER.md：按系统提示里的白皮书结构（定位/文件清单/设计决策与理由/踩坑/交接指南），扫描项目目录，梳理每个文件的作用和每项设计的理由。")
          }
          break
        }
        case "mcp":
          pushNotice(mcpInfo ? `MCP: ${mcpInfo} · 配置: ~/.yyagent/config.json 的 mcpServers` : "无 MCP server · 配置 mcpServers: { 名: { command, args } }")
          break
        case "mousedbg": {
          const stdin = process.stdin as unknown as { isTTY?: boolean; isRaw?: boolean; listenerCount: (e: string) => number }
          pushNotice(
            `mouseOn=${isMouseEnabled()} isTTY=${stdin.isTTY} isRaw=${stdin.isRaw} dataListeners=${stdin.listenerCount("data")} 收到鼠标事件=${mouseEventCount()} —— 点几下按钮栏再跑一次 /mousedbg，看事件数是否增长`,
          )
          break
        }
        case "model": {
          if (!args[0]) {
            pushNotice(`本会话模型: ${active?.model ?? "(默认)"} · 默认: ${cfg.model}`)
            break
          }
          if (args[0] === "add") {
            const [, name, baseURL, key, modelId] = args
            if (!name || !baseURL || !key || !modelId) {
              pushNotice("用法: /model add <通道名> <baseURL> <apiKey> <模型ID>")
              break
            }
            addProvider(name, baseURL, key, modelId)
            setDefaultModel(`${name}/${modelId}`)
            pushNotice(`已添加通道 ${name}，默认模型 ${name}/${modelId}`)
            break
          }
          if (args[0] === "default") {
            if (!args[1]) {
              pushNotice(`默认模型: ${cfg.model}`)
              break
            }
            setDefaultModel(args[1])
            pushNotice(`默认模型已设为 ${args[1]}`)
            break
          }
          updateActive((m) => (m.model = args[0]), messages)
          pushNotice(`本会话模型: ${args[0]}`)
          break
        }
        case "models": {
          pushNotice(
            `通道: ${Object.keys(cfg.providers).join(", ") || "（无）"} · 默认模型: ${cfg.model} · 添加: /model add <名> <baseURL> <key> <模型ID>`,
          )
          break
        }
        case "side": {
          const task = args.join(" ").trim()
          setSideOpen(true)
          setSideTab("chat")
          setSideFocus(true)
          let t = sessions.find((s) => s.title.startsWith("⟡"))
          if (!t) {
            t = createSession(active?.cwd ?? process.cwd(), active?.model, "⟡ 辅助对话")
            setSessions(listSessions())
          }
          setSideTargetId(t.id)
          loadSideMsgs(t)
          if (!loadConfig().watch) {
            saveConfig({ ...loadConfig(), watch: true })
            watchRef.current = true
            pushNotice("已自动开启监工模式：主任务完成后辅助对话自动检查并发回下一步")
          }
          if (task) setTimeout(() => void sendSideRef.current?.(task), 100)
          break
        }
        case "tasks":
        case "task": {
          const cfgFile = join(PKG_ROOT, "yyagentd.config.json")
          let tasks: Array<{ name: string; cron: string; enabled?: boolean }> = []
          if (existsSync(cfgFile)) {
            tasks = (JSON.parse(readFileSync(cfgFile, "utf8")).tasks ?? []) as typeof tasks
          }
          if (cmd === "tasks") {
            pushNotice(
              tasks.length
                ? tasks.map((t) => `${t.enabled === false ? "○" : "●"} ${t.name}  ${t.cron}`).join("  |  ")
                : "无定时任务（编辑 yyagentd.config.json）",
            )
          } else if (args[0] === "run" && args[1]) {
            const name = args[1]
            if (!tasks.some((t) => t.name === name)) {
              pushNotice(`未找到任务: ${name}`)
              break
            }
            pushNotice(`后台执行任务 ${name}，结果见 logs/`)
            spawn(
              process.execPath,
              [join(PKG_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(PKG_ROOT, "src", "main.ts"), "run", name],
              { cwd: PKG_ROOT, detached: true, stdio: "ignore" },
            ).unref()
          }
          break
        }
        case "q": {
          const kw = args.join(" ").trim()
          if (!kw) {
            pushNotice("快速搜索：/q <关键词> —— 自动 websearch 并一句话总结")
            break
          }
          void send(
            `快速搜索任务（尽快完成，不要展开）：用 websearch 搜索「${kw}」，列出前 5 条结果（标题+链接）各配一句话要点，最后给一段 2-3 句的总结。不要用 webfetch 抓取网页。`,
          )
          break
        }
        case "search": {
          const kw = args.join(" ").trim()
          setSearch(kw)
          if (!kw) {
            pushNotice("已清除过滤（输入 /search <词> 可全文搜索）")
            break
          }
          // 标题过滤 + 全部会话内容全文搜索
          const hits: Array<{ title: string; snippet: string }> = []
          for (const s of listSessions().slice(0, 50)) {
            const f = loadSession(s.id)
            if (!f) continue
            for (const m of f.messages) {
              const i = m.content.toLowerCase().indexOf(kw.toLowerCase())
              if (i >= 0) {
                hits.push({ title: s.title, snippet: `…${m.content.slice(Math.max(0, i - 30), i + 60).replace(/\r?\n/g, " ")}…` })
                break
              }
            }
            if (hits.length >= 5) break
          }
          pushNotice(
            hits.length
              ? `全文命中 ${hits.length} 条：${hits.map((h) => `【${h.title}】${h.snippet}`).join("  ||  ")}`
              : `无内容命中（标题过滤: ${kw}）`,
          )
          break
        }
        case "plugins": {
          const list = plugins.map((p) => `${p.name}(${p.tools.join(",")})`).join("  ") || "无插件"
          pushNotice(`插件: ${list}`)
          break
        }
        case "open": {
          const p = args[0]
          if (!p) {
            pushNotice("用法: /open <文件路径>")
            break
          }
          const abs = resolve(active?.cwd ?? process.cwd(), p)
          if (!existsSync(abs)) {
            pushNotice(`文件不存在: ${abs}`)
            break
          }
          spawn("cmd", ["/c", "start", "", abs], { detached: true, stdio: "ignore" }).unref()
          pushNotice(`已打开: ${abs}`)
          break
        }
        case "export": {
          if (!active) break
          const target = args[0] ?? join(homedir(), "Desktop", `yyagent-${active.id}.md`)
          try {
            const md = [
              `# ${active.title}`,
              "",
              `> 导出自 Yy Sustainer · ${new Date().toLocaleString("zh-CN")} · cwd: ${active.cwd}`,
              "",
              ...messages.map(
                (m) => `## ${m.role === "user" ? "用户" : "Yy Sustainer"} · ${new Date(m.ts).toLocaleString("zh-CN")}\n\n${m.content}`,
              ),
            ].join("\n\n")
            mkdirSync(dirname(target), { recursive: true })
            writeFileSync(target, md, "utf8")
            pushNotice(`会话已导出: ${target}`)
          } catch (e) {
            pushNotice(`导出失败: ${(e as Error).message}`)
          }
          break
        }
        case "exit":
          exit()
          break
        default:
          pushNotice(`未知命令: ${cmd}（/help 查看全部）`)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, messages, plugins, mcpInfo, attachments, pushNotice, updateActive, exit],
  )
  handleCommandRef.current = handleCommand

  const send = useCallback(
    async (text: string) => {
      if (busy || !active) return
      let finalText = text
      const directImages: string[] = []
      if (attachments.length) {
        const parts: string[] = []
        const visionOk = mainModelSupportsImages(active.model)
        for (const abs of attachments) {
          try {
            if (isImageFile(abs)) {
              if (visionOk) {
                // 主模型有视觉：直传
                directImages.push(readFileSync(abs).toString("base64"))
                parts.push(`[图片已直传: ${abs.split(/[\\/]/).pop()}]`)
              } else {
                parts.push(`[图片: ${abs}]\n${await describeImage(abs)}`)
              }
            } else if (existsSync(abs)) {
              parts.push(`[附件文件: ${abs}]\n${readTextAttachment(abs)}`)
            } else {
              parts.push(`[附件不存在: ${abs}]`)
            }
          } catch (e) {
            parts.push(`[附件处理失败 ${abs}: ${(e as Error).message}]`)
          }
        }
        finalText = `${text}\n\n${parts.join("\n\n")}`
        setAttachments([])
      }
      const userMsg: StoredMessage = { role: "user", content: finalText, ts: Date.now() }
      let msgs = [...messages, userMsg]
      setMessages(msgs)
      const metaMut = (m: SessionMeta) => {
        if (m.title === "新对话") m.title = text.slice(0, 30)
      }
      updateActive(metaMut, msgs)
      setBusy(true)
      setBusyStatus("思考中")
      setStreaming("")
      setScrollOffset(0)
      setRunSteps([])
      setStepMode("collapsed")
      setStepSel(0)
      const ac = new AbortController()
      abortRef.current = ac
      const injected = active.title === CONFIG_TITLE ? `${CONFIG_CONTEXT}\n\n---\n用户说：${text}` : text
      let r: import("../agent/loop.js").AgentResult | null = null
      try {
        const history = toCoreMessages(messages)
        // API 失败自动重发：上限 10 次，指数退避，显示重试中
        const MAX_RETRY = 10
        for (let attempt = 0; ; attempt++) {
          try {
            r = await runAgentStream(
              injected,
              {
                model: active.model,
                history,
                broker,
                cwd: active.cwd,
                signal: ac.signal,
                images: directImages.length ? directImages : undefined,
              },
              {
                onText: (d) => setStreaming((s) => (s ?? "") + d),
                onStatus: (s) => setBusyStatus(s),
                onToolEvent: (ev) => {
                  setRunSteps((prev) => {
                    if (ev.type === "call") {
                      const input = ev.input ? JSON.stringify(ev.input, null, 2).slice(0, 3000) : undefined
                      const argsSummary = ev.input
                        ? JSON.stringify(ev.input).replace(/["{}]/g, "").slice(0, 80)
                        : ""
                      return [...prev, { id: ev.toolCallId, name: ev.name, argsSummary, input, pending: true }]
                    }
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
                    const i = prev.findIndex((s) => s.id === ev.toolCallId)
                    if (i < 0) return prev
                    const next = [...prev]
                    next[i] = { ...next[i], output, pending: false }
                    return next
                  })
                },
              },
            )
            break
          } catch (e) {
            const err = e as Error
            if (err.name === "AbortError" || /abort/i.test(err.message ?? "")) throw err
            attempt++
            if (attempt >= MAX_RETRY) throw err
            const retryable = /ECONNREFUSED|ETIMEDOUT|timeout|timed out|429|5\d\d|fetch failed|rpm|rate|socket/i.test(err.message ?? "")
            if (!retryable) throw err
            setRetryInfo(`⚠ API 出错，重试中 (${attempt}/${MAX_RETRY})：${(err.message ?? "").slice(0, 80)}`)
            await new Promise((res) => setTimeout(res, Math.min(20_000, 1500 * Math.pow(2, attempt - 1))))
          }
        }
        setRetryInfo(null)
        if (!r) throw new Error("no result")
        const usage = r.usage
        if (usage) {
          setTokenStats((s) => ({ in: s.in + usage.in, out: s.out + usage.out, cached: s.cached + usage.cached }))
        }
        msgs = [...msgs, {
          role: "assistant",
          content: r.text,
          ts: Date.now(),
          steps: runStepsRef.current.map((s) => ({ name: s.name, argsSummary: s.argsSummary, input: s.input, output: s.output })),
        }]
        setMessages(msgs)
        const pct = calcCtxPct(msgs)
        setCtxPct(pct)
        updateActive((m) => (m.ctxPct = pct), msgs)
        setCtxPct(calcCtxPct(msgs))
      } catch (e) {
        setRetryInfo(null)
        const err = e as Error
        tlog("send-error:", err.message?.slice(0, 120))
        const aborted = err.name === "AbortError" || /abort/i.test(err.message ?? "")
        if (!aborted) {
          const errMsg: StoredMessage = { role: "assistant", content: `[出错] ${err.message}`, ts: Date.now() }
          msgs = [...msgs, errMsg]
          setMessages(msgs)
          updateActive(metaMut, msgs)
        }
      } finally {
        abortRef.current = null
        setStreaming(null)
        setBusy(false)
        setBusyStatus("思考中")
        // 监工模式：主任务完成后自动调辅助对话检查；SEND 消息经信箱/队列回主对话
        if (watchRef.current && r && r.text) {
          const userTask = text
          const report = r.text
          void (async () => {
            try {
              const { runAgent } = await import("../agent/loop.js")
              const res = await runAgent(
                `你是任务质检员（只读检查，不要修改任何文件）。用户原始需求：${userTask}\n\n主 agent 完成报告：\n${report.slice(0, 2000)}\n\n检查：1) 需求是否完整完成 2) 有无遗漏或错误 3) 用户接下来可能需要什么。若发现问题或有明确的后续步骤，输出一行以 "SEND: " 开头的消息（将自动发给主对话执行）；一切正常无需跟进则只输出 OK。`,
                {
                  model: active?.model,
                  cwd: active?.cwd,
                  system: "你是 Yy Sustainer 的监工/质检子智能体。只读检查，绝不修改文件。发现遗漏或后续需求时，输出一行以 SEND: 开头的精简指令（将自动发给主对话执行）；无问题只输出 OK。",
                  maxSteps: 12,
                },
              )
              const m = res.text.match(/SEND:\s*(.+)/)
              if (m) {
                const msg = m[1].trim()
                queueRef.current = [...queueRef.current, msg]
                setQueue(queueRef.current)
                pushNotice(`⟡ 辅助对话检查后已向主对话入队：${msg.slice(0, 40)}`)
                if (!busyRef.current) {
                  const [next, ...rest] = queueRef.current
                  queueRef.current = rest
                  setQueue(rest)
                  if (next) void sendRef.current?.(next)
                }
              }
            } catch {
              /* 监工失败静默 */
            }
          })()
        }
        // 辅助对话（⟡ 会话）里 agent 输出 SEND 行 → 写信箱发给主对话
        if (r && active?.title.startsWith("⟡")) {
          const sends = r.text.match(/^SEND:\s*(.+)$/gm)
          if (sends?.length) {
            try {
              const p = join(homedir(), ".yyagent", "inbox.json")
              const arr = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Array<{ task: string; ts: number }>) : []
              for (const line of sends) arr.push({ task: line.replace(/^SEND:\s*/, "").trim(), ts: Date.now() })
              writeFileSync(p, JSON.stringify(arr, null, 2))
            } catch {
              /* 忽略 */
            }
          }
        }
        if (queueRef.current.length) {
          const [next, ...rest] = queueRef.current
          queueRef.current = rest
          setQueue(rest)
          setQueueSel(0)
          if (next.startsWith("/")) {
            setTimeout(() => void handleCommandRef.current?.(next), 50)
          } else {
            setTimeout(() => void sendRef.current?.(next), 100)
          }
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, active, messages, updateActive, attachments],
  )
  sendRef.current = send

  // ---------- 底部按钮栏（鼠标 hover/点击 + 等价快捷键） ----------
  const [hoverBtn, setHoverBtn] = useState(-1)
  const hoverRef = useRef(-1)
  const buttonsRef = useRef<Array<{ act: string; x0: number; x1: number }>>([])
  const visibleButtonsRef = useRef<Array<{ label: string; act: string; desc: string }>>([])
  const modelRowsRef = useRef<Array<{ spec: string; provider: string; modelId: string }>>([])
  const pickerListBottomRef = useRef(0)
  const pickerDisplayRowsRef = useRef<Array<PickerRow>>([])
  const pickerWindowRef = useRef<{ start: number; rows: PickerRow[] }>({ start: 0, rows: [] })
  const showModelPanelRef = useRef(false)
  const bodyHRef = useRef(20)
  const inputRowRef = useRef<any>(null) // 输入行 Box：IME 光标用 Yoga 绝对坐标定位
  useEffect(() => {
    showModelPanelRef.current = showModelPanel
  }, [showModelPanel])
  const actRef = useRef<((name: string) => void) | null>(null)

  const act = useCallback(
    (name: string) => {
      tlog("act:", name, `busy=${busy}`)
      switch (name) {
        case "send": {
          const t = input.trim()
          if (!t) return
          setInput("")
          if (t.startsWith("/")) void handleCommandRef.current?.(t)
          else void sendRef.current?.(t)
          break
        }
        case "stop":
          if (!busy) return
          queueRef.current = []
          setQueue([])
          abortRef.current?.abort()
          break
        case "sidebar":
          setSidebar((s) => !s)
          break
        case "new":
          void handleCommandRef.current?.("/new")
          break
        case "sidepanel":
          setSideOpen((s) => {
            if (!s) setSideFocus(true)
            else setSideFocus(false)
            return !s
          })
          break
        case "model": {
          // 打开/关闭模型选择器（选中位置重置放到 useEffect，避免嵌套 setState 失效）
          setShowModelPanel((v) => !v)
          break
        }
        case "queue":
          if (queueRef.current.length) pushNotice(`排队 ${queueRef.current.length} 条：${queueRef.current.map((q) => q.slice(0, 20)).join(" | ")}（Ctrl+J/K 选 · Ctrl+E 编辑 · Ctrl+S 立即发送）`)
          else pushNotice("无排队消息（任务执行中输入并回车即可排队）")
          break
        case "perm": {
          const c = loadConfig()
          const order: Array<"danger-confirm" | "confirm-all" | "full-auto"> = ["danger-confirm", "confirm-all", "full-auto"]
          const cur = order.indexOf(c.permission ?? "danger-confirm")
          const next = order[(cur + 1) % order.length]
          saveConfig({ ...c, permission: next })
          pushNotice(`权限档 → ${PERM_LABEL[next]}`)
          break
        }
        case "compact": {
          if (busy || !active || !messages.length) {
            pushNotice("空闲且有对话内容时才能压缩")
            break
          }
          pushNotice("正在压缩上下文…")
          void (async () => {
            try {
              // T55：system 提示（模型切换）不进压缩摘要的 LLM 上下文（类型守卫让 TS 确认过滤后无 system）
              const compacted = await compactNow(messages.filter((m): m is StoredMessage & { role: "user" | "assistant" } => m.role !== "system"), active.model)
              setMessages(compacted)
              updateActive(() => {}, compacted)
              setCtxPct(calcCtxPct(compacted))
              pushNotice(`压缩完成：${messages.length} 条 → ${compacted.length} 条`)
            } catch (e) {
              pushNotice(`压缩失败: ${(e as Error).message}`)
            }
          })()
          break
        }
        case "rename": {
          if (!active) break
          setRenaming(active.id)
          setInput(active.title)
          pushNotice("重命名模式：修改后回车确认，Esc 取消")
          break
        }
        case "search":
          setInput("/q ")
          break
        case "side": {
          // 子代理 = 右侧栏常驻辅助对话（不再开新进程/新界面）
          setSideOpen(true)
          setSideTab("chat")
          setSideFocus(true)
          if (!loadConfig().watch) {
            saveConfig({ ...loadConfig(), watch: true })
            watchRef.current = true
            pushNotice("已自动开启监工模式（/watch off 关闭）：主任务完成后辅助对话自动检查并发回下一步")
          } else {
            pushNotice("右侧栏辅助对话已打开——直接输入需求，SEND: 行会自动发给主对话执行")
          }
          break
        }
        case "help":
          void handleCommandRef.current?.("/help")
          break
        case "exit":
          exit()
          break
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, input, exit, pushNotice, sessions, active, openSession],
  )
  actRef.current = act

  const longTaskOn = loadConfig().longTask ?? false
  const mouseOn = isMouseEnabled()
  const ctxLabel = `${ctxPct >= 75 ? "🔴" : ctxPct >= 40 ? "🟡" : "🟢"} ${ctxPct}%`
  const ctxDesc = `上下文占用 ${ctxPct}%，点击一键压缩 · 本会话 ↑${fmtK(tokenStats.in)} ↓${fmtK(tokenStats.out)} tok · 缓存命中 ${tokenStats.in ? Math.round((tokenStats.cached / tokenStats.in) * 100) : 0}%`
  const buttons: Array<{ label: string; act: string; desc: string }> = busy
    ? [
        { label: "■ 停止", act: "stop", desc: "停止当前任务（Ctrl+Q）" },
        { label: ctxLabel, act: "compact", desc: ctxDesc },
        { label: "⇋ 侧栏", act: "sidebar", desc: "切换左侧边栏（Ctrl+B）" },
        { label: "▭ 右栏", act: "sidepanel", desc: "右侧栏：辅助对话/任务管理（Ctrl+R）" },
        { label: "☰ 队列", act: "queue", desc: "查看排队消息（Ctrl+J/K 浏览 · Ctrl+E 编辑）" },
        { label: mouseOn ? "🖱 鼠标✓" : "🖱 鼠标✗", act: "mouse", desc: "鼠标模式开关（Ctrl+M）：开=点按钮/提示（Shift拖选复制），关=终端原生选择" },
        { label: longTaskOn ? "⏳ 长任务✓" : "⏳ 长任务✗", act: "long", desc: "长任务模式（/long）：上下文超 60% 自动滚动压缩" },
        { label: "⊕ 权限", act: "perm", desc: "循环切换权限档位（/perm）" },
        { label: "? 帮助", act: "help", desc: "全部命令说明（/help）" },
        { label: "✕ 退出", act: "exit", desc: "退出 Yy Sustainer（Ctrl+C）" },
      ]
    : [
        { label: ctxLabel, act: "compact", desc: ctxDesc },
        { label: "⇋ 侧栏", act: "sidebar", desc: "切换左侧边栏（Ctrl+B）" },
        { label: "✚ 新建", act: "new", desc: "新建对话（/new）" },
        { label: "✎ 重命名", act: "rename", desc: "重命名当前会话（改完回车确认）" },
        { label: "⚙ 模型", act: "model", desc: "查看/设置当前模型（/model）" },
        { label: "🔍 搜索", act: "search", desc: "全文搜索所有会话（/search <词>）" },
        { label: "⟡ 辅助", act: "side", desc: "后台辅助对话/子代理（/side <任务>），不打断当前对话" },
        { label: "▭ 右栏", act: "sidepanel", desc: "右侧栏：辅助对话/任务管理（Ctrl+R）" },
        { label: mouseOn ? "🖱 鼠标✓" : "🖱 鼠标✗", act: "mouse", desc: "鼠标模式开关（Ctrl+M）" },
        { label: longTaskOn ? "⏳ 长任务✓" : "⏳ 长任务✗", act: "long", desc: "长任务模式（/long）：上下文超 60% 自动滚动压缩" },
        { label: "⊕ 权限", act: "perm", desc: "循环切换权限档位（/perm）" },
        { label: "? 帮助", act: "help", desc: "全部命令说明（/help）" },
        { label: "✕ 退出", act: "exit", desc: "退出 Yy Sustainer（Ctrl+C）" },
      ]
  {
    // 动态截断：按钮总宽超过终端列数时，从中间开始隐藏（保底：首 2 个 + 帮助/退出）
    const maxW = (process.stdout.columns ?? 100) - 4
    const tail = buttons.slice(-2) // 帮助 + 退出保底
    const mid = buttons.slice(0, -2)
    let acc = tail.reduce((n, b) => n + displayWidth(b.label) + 1, 0)
    const visibleMid: typeof buttons = []
    for (const b of [...mid].reverse()) {
      const w = displayWidth(b.label) + 1
      if (acc + w > maxW) break
      visibleMid.unshift(b)
      acc += w
    }
    visibleButtonsRef.current = [...visibleMid, ...tail]
    let bx = 0
    buttonsRef.current = visibleButtonsRef.current.map((b) => {
      const w = displayWidth(b.label)
      const r = { act: b.act, x0: bx, x1: bx + w + 1 }
      bx += w + 1
      return r
    })
  }

  useEffect(() => {
    // stdin 自检：raw mode 异常会导致"完全无法输入"
    const sin = process.stdin as unknown as { isTTY?: boolean; isRaw?: boolean; setRawMode?: (v: boolean) => unknown }
    if (sin.isTTY && sin.isRaw === false && sin.setRawMode) {
      try {
        sin.setRawMode(true)
      } catch {
        /* 忽略 */
      }
    }
    setInputReady(!!sin.isTTY)
    setMouseEnabled(true)
    const sideOpenRef = { get current() { return sideOpen } }
    const consume = () => {
      while (mouseEventsQueue.length) {
        const e = mouseEventsQueue.shift()!
        const rows = process.stdout.rows ?? 32
        const columns = process.stdout.columns ?? 100
        const btnY = rows - 2
        // 滚动条拖动结束
        if (e.kind === "up") {
          scrollDraggingRef.current = false
          continue
        }
        tlog("mouse:", `x=${e.x} y=${e.y} kind=${e.kind} rows=${rows} btnY=${btnY} buttons=${buttonsRef.current.length}`)
        // 滚轮：上下滚动消息视口（按行，长消息可逐行查看），不参与按钮/点击命中
        if (e.kind === "wheel-up" || e.kind === "wheel-down") {
          const delta = e.kind === "wheel-up" ? 3 : -3
          setScrollOffset((o) => Math.max(0, o + delta))
          continue
        }
        let hit = -1
        if (e.y === btnY) {
          hit = buttonsRef.current.findIndex((b) => e.x >= b.x0 && e.x < b.x1)
        }
        if (e.kind === "down") {
          if (hit >= 0) {
            tlog("mouse-hit:", `btn=${buttonsRef.current[hit]?.act}`)
            actRef.current?.(buttonsRef.current[hit].act)
            continue
          }
          // 模型选择器：点击模型行直接切换（列表底部锚定）
          const mrLen = modelRowsRef.current.length
          const listBottom = pickerListBottomRef.current
          if (showModelPanelRef.current && mrLen && e.x < columns - (sideOpenRef.current ? 38 : 0) - 2 && e.y <= listBottom && e.y > listBottom - mrLen) {
            const idx = e.y - (listBottom - mrLen + 1)
            const pick = modelRowsRef.current[idx]
            if (pick) {
              tlog("mouse-hit:", `model-pick ${pick.spec}`)
              setDefaultModel(pick.spec)
              pushNotice(`默认模型 → ${pick.spec}`)
              setShowModelPanel(false)
            }
            continue
          }
          const sideW = sideOpenRef.current ? 38 : 0
          const inSideArea = sideW > 0 && e.x >= columns - sideW
          // 滚动条轨道列（聊天区右缘 2 列内）：点击跳转 + 开始拖动（行级映射）
          const inScrollbar = !inSideArea && e.x >= columns - 2
          if (inScrollbar) {
            scrollDraggingRef.current = true
            const ratio = Math.min(1, Math.max(0, (e.y - 4) / Math.max(1, bodyHRef.current - 4)))
            setScrollOffset(Math.round((1 - ratio) * totalScrollRowsRef.current))
            continue
          }
          // 右栏发送按钮（右栏底部 5 行内）
          if (inSideArea && e.y >= rows - 5) {
            tlog("mouse-hit:", "side-send")
            const t = sideInputRef.current.trim()
            setSideInput("")
            if (t) void sendSideRef.current?.(t)
            continue
          }
          // 输入框右下角：发送/停止按钮（输入行区域，右下角 24 列内；question 提问时让位键盘应答）
          const isSendArea = !inSideArea && e.y >= rows - 6 && e.y <= rows - 3 && e.x >= columns - 24
          if (isSendArea && !broker.pending) {
            tlog("mouse-hit:", `send-area y=${e.y} busy=${busy}`)
            actRef.current?.(busy ? "stop" : "send")
            continue
          }
          tlog("mouse-focus-area:", `x=${e.x} sideW=${sideW}`)
          if (inSideArea) {
            setSideFocus(true)
          } else if (e.x < 32) {
            // 左侧栏区域：模型选择器开时 hover 高亮 + 点击执行；关闭后侧栏内容自动刷新回来
            if (showModelPanelRef.current) {
              const win = pickerWindowRef.current
              const row = win.rows[e.y - 4]
              if (!row) continue
              if (e.kind === "down") {
                if (row.type === "model") {
                  const spec = `${row.provider}/${row.modelId}`
                  tlog("mouse-hit:", `model-pick ${spec}`)
                  setDefaultModel(spec)
                  setSessionModel(spec)
                  pushNotice(`默认模型 → ${spec}`)
                } else if (row.type === "vision" && row.spec) {
                  tlog("mouse-hit:", `vision-pick ${row.spec}`)
                  saveConfig({ ...loadConfig(), visionModel: row.spec })
                  pushNotice(`识图模型 → ${row.spec}`)
                } else if (e.y === 4) {
                  // 点了过滤框行：提示直接打字（光标已在此）
                  pushNotice("已聚焦过滤框——直接打字即可过滤模型")
                }
                // 面板保持打开（点击标题/分组/空白无操作；行数不变无残影）
                continue
              }
              // move：模型行 hover 高亮（只改显示，不动 pickerSel 锚点）
              if (row.type === "model") {
                const gi = win.start + (e.y - 4)
                if (hoverModelIdxRef.current !== gi) {
                  hoverModelIdxRef.current = gi
                  setHoverModelIdx(gi)
                }
              } else if (hoverModelIdxRef.current !== -1) {
                hoverModelIdxRef.current = -1
                setHoverModelIdx(-1)
              }
              const vh = row.type === "vision" ? row.visionIdx : -1
              if (vh !== visionHoverRef.current) {
                visionHoverRef.current = vh
                setVisionHover(vh)
              }
              continue
            }
            setFocusSidebar(true)
            setSideFocus(false)
            const idx = Math.floor((e.y - 6) / 2)
            if (idx >= 0 && idx < filteredRef.current.length) {
              const target = filteredRef.current[idx]
              tlog("sidebar-click:", `idx=${idx} id=${target.id}`)
              openSession(target)
              setFocusSidebar(false)
              setSelected(idx)
            }
          } else {
            setFocusSidebar(false)
            setSideFocus(false)
            setStepMode("collapsed")
            // 点消息区/空白：若模型面板开着则关闭归还焦点（否则焦点卡在 picker，打字被吞）
            if (showModelPanelRef.current) {
              setShowModelPanel(false)
            }
          }
          continue
        }
        // move：发送按钮 hover 反色 + 侧栏行 hover 反色
        const sideWMove = sideOpenRef.current ? 38 : 0
        const inSideAreaMove = sideWMove > 0 && e.x >= columns - sideWMove
        const inSend = !inSideAreaMove && e.y >= rows - 6 && e.y <= rows - 3 && e.x >= columns - 24
        if (inSend !== sendHoverRef.current) {
          sendHoverRef.current = inSend
          setSendHover(inSend)
        }
        const inSideSend = inSideAreaMove && e.y >= rows - 5
        if (inSideSend !== sideSendHoverRef.current) {
          sideSendHoverRef.current = inSideSend
          setSideSendHover(inSideSend)
        }
        // 侧栏 hover：x<32 区域按行命中（标题 y=4 + 空 1，条目从 y=6 起每条 2 行）
        let sidebarIdx = -1
        if (e.x < 32 && e.y >= 6) {
          const idx = Math.floor((e.y - 6) / 2)
          if (idx < filteredRef.current.length) sidebarIdx = idx
        }
        if (sidebarIdx !== sidebarHoverRef.current) {
          sidebarHoverRef.current = sidebarIdx
          setSidebarHover(sidebarIdx)
        }
        if (hit !== hoverRef.current) {
          hoverRef.current = hit
          setHoverBtn(hit)
        }
        // move：滚动条拖动（按住轨道持续滚动）优先；其次模型选择器行 hover
        if (scrollDraggingRef.current) {
          const ratio = Math.min(1, Math.max(0, (e.y - 4) / Math.max(1, bodyHRef.current - 4)))
          setScrollOffset(Math.round((1 - ratio) * totalScrollRowsRef.current))
          continue
        }
        if (showModelPanelRef.current && e.x < 32) {
          const win = pickerWindowRef.current
          const row = win.rows[e.y - 4]
          if (!row) continue
          if (row.type === "model") {
            const gi = win.start + (e.y - 4)
            if (hoverModelIdxRef.current !== gi) {
              hoverModelIdxRef.current = gi
              setHoverModelIdx(gi)
            }
          } else if (hoverModelIdxRef.current !== -1) {
            hoverModelIdxRef.current = -1
            setHoverModelIdx(-1)
          }
          const vh = row.type === "vision" ? row.visionIdx : -1
          if (vh !== visionHoverRef.current) {
            visionHoverRef.current = vh
            setVisionHover(vh)
          }
        }
      }
    }
    const t = setInterval(consume, 60)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideOpen])

  const activeButton = hoverBtn >= 0 && hoverBtn < visibleButtonsRef.current.length ? visibleButtonsRef.current[hoverBtn] : null

  // ---------- 键盘焦点状态机 ----------
  // 焦点优先级：question > rename > steps-card > steps-list > side-chat/side-tasks > sidebar > chat
  // 全局键（Ctrl 组合 / Tab / PgUp/PgDn / Esc 层级）在分发前处理
  type Focus = "question" | "model-picker" | "rename" | "steps-card" | "steps-list" | "side-chat" | "side-tasks" | "sidebar" | "chat"
  const focus: Focus = broker.pending
    ? "question"
    : showModelPanel
      ? "model-picker"
      : renaming
          ? "rename"
          : stepMode === "card"
            ? "steps-card"
            : stepMode === "list"
              ? "steps-list"
              : sideOpen && sideFocus
                ? sideTab === "chat"
                  ? "side-chat"
                  : "side-tasks"
                : focusSidebar && sidebar && !busy
                  ? "sidebar"
                  : "chat"

  // ---------- 右侧栏：辅助对话（常驻子代理，实时监控主对话）与任务管理 ----------
  const loadSideMsgs = useCallback((meta: SessionMeta) => {
    const file = loadSession(meta.id)
    setSideMsgs(file?.messages ?? [])
  }, [])

  useEffect(() => {
    if (!sideOpen || !sideTargetId) return
    const t = sessions.find((s) => s.id === sideTargetId)
    if (t) loadSideMsgs(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideTargetId, sideOpen])

  const sendSide = useCallback(
    async (text: string) => {
      if (sideBusy) return
      let target = sessions.find((s) => s.id === sideTargetId) ?? sessions.find((s) => s.title.startsWith("⟡"))
      if (!target) {
        target = createSession(active?.cwd ?? process.cwd(), active?.model, "⟡ 辅助对话")
        setSideTargetId(target.id)
        setSessions(listSessions())
      }
      const file = loadSession(target.id)
      const prev = file?.messages ?? []
      const userMsg: StoredMessage = { role: "user", content: text, ts: Date.now() }
      let msgs = [...prev, userMsg]
      setSideMsgs(msgs)
      persist({ ...target, updatedAt: Date.now() }, msgs)
      setSideBusy(true)
      setSideStreaming("")
      const ac = new AbortController()
      // 主对话实时快照（辅助 agent 每轮自动监控主输出）
      const lastMain = messages[messages.length - 1]
      const snapshot = [
        `主对话状态：${busyRef.current ? "执行中" : "空闲"}`,
        `当前会话：${active?.title ?? "-"}`,
        `排队消息：${queueRef.current.length} 条`,
        lastMain ? `主对话最近输出片段：${lastMain.content.slice(0, 400).replace(/\r?\n/g, " ")}` : "",
      ]
        .filter(Boolean)
        .join("\n")
      const injected = `${SIDE_PROTOCOL.trim()}\n\n【主对话实时监控快照】\n${snapshot}\n\n---\n用户对辅助对话说：${text}`
      const ac2 = ac
      try {
        const r = await runAgentStream(
          text,
          {
            model: target.model,
            cwd: target.cwd,
            history: toCoreMessages(prev),
            system: injected,
            signal: ac2.signal,
          },
          { onText: (d) => setSideStreaming((s) => (s ?? "") + d) },
        )
        msgs = [...msgs, { role: "assistant", content: r.text, ts: Date.now() }]
        setSideMsgs(msgs)
        persist({ ...target, updatedAt: Date.now() }, msgs)
        const sends = r.text.match(/^SEND:\s*(.+)$/gm)
        if (sends?.length) {
          try {
            const p = join(homedir(), ".yyagent", "inbox.json")
            const arr = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Array<{ task: string; ts: number }>) : []
            for (const line of sends) arr.push({ task: line.replace(/^SEND:\s*/, "").trim(), ts: Date.now() })
            writeFileSync(p, JSON.stringify(arr, null, 2))
            pushNotice(`⟡ 辅助对话已发 ${sends.length} 条消息给主对话`)
          } catch {
            /* 忽略 */
          }
        }
        setSessions(listSessions())
      } catch (e) {
        msgs = [...msgs, { role: "assistant", content: `[出错] ${(e as Error).message}`, ts: Date.now() }]
        setSideMsgs(msgs)
        persist({ ...target, updatedAt: Date.now() }, msgs)
      } finally {
        setSideBusy(false)
        setSideStreaming(null)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sideBusy, sessions, sideTargetId, active, messages, pushNotice],
  )
  const sendSideRef = useRef<(t: string) => Promise<void>>((t) => Promise.resolve())
  sendSideRef.current = sendSide
  const sideInputRef = useRef("")
  useEffect(() => {
    sideInputRef.current = sideInput
  }, [sideInput])

  useInput((value, key) => {
    // 输入问题排查开关：YYAGENT_KEY_DEBUG=1 时记录每个键事件（含当前焦点）
    if (process.env.YYAGENT_KEY_DEBUG) {
      const focusNow: Focus = broker.pending ? "question" : showModelPanel ? "model-picker" : renaming ? "rename" : stepMode === "card" ? "steps-card" : stepMode === "list" ? "steps-list" : sideOpen && sideFocus ? (sideTab === "chat" ? "side-chat" : "side-tasks") : focusSidebar && sidebar && !busy ? "sidebar" : "chat"
      tlog("key:", `value=${JSON.stringify(value)} ctrl=${key.ctrl} tab=${key.tab} ret=${key.return} esc=${key.escape} bs=${key.backspace} arrows=${key.upArrow}/${key.downArrow} focus=${focusNow}`)
    }
    // ==== 全局键区（任何焦点下都生效） ====
    if (key.ctrl && value === "b") {
      setSidebar((s) => {
        // 关侧栏时必须同时清掉 sidebar 焦点，否则焦点卡在不可见的 "sidebar"，打字全被吞
        if (s) setFocusSidebar(false)
        return !s
      })
      return
    }
    if (key.tab) {
      if (sidebar) setFocusSidebar((f) => !f)
      return
    }
    if (key.ctrl && value === "c") {
      if (!busy) exit()
      return
    }
    if (key.ctrl && value === "j") {
      if (!runSteps.length) return
      setStepMode((m) => (m === "collapsed" ? "list" : m))
      setStepSel((s) => Math.min(runSteps.length - 1, s + 1))
      return
    }
    if (key.ctrl && value === "k") {
      if (!runSteps.length) return
      setStepMode((m) => (m === "collapsed" ? "list" : m))
      setStepSel((s) => Math.max(0, s - 1))
      return
    }
    if (key.ctrl && value === "o") {
      if (!runSteps.length) return
      setStepMode((m) => (m === "card" ? "list" : m === "list" ? "card" : "list"))
      setCardOffset(0)
      return
    }
    if (key.ctrl && value === "m") {
      actRef.current?.("mouse")
      return
    }
    if (key.ctrl && value === "r") {
      setSideOpen((s) => {
        if (!s) setSideFocus(true)
        else setSideFocus(false)
        return !s
      })
      return
    }
    if (key.ctrl && value === "i") {
      if (sideOpen) setSideFocus((f) => !f)
      return
    }
    if (key.ctrl && value === "t") {
      if (sideOpen && sideFocus) setSideTab((t) => (t === "chat" ? "tasks" : "chat"))
      return
    }
    if (key.ctrl && value === "q") {
      if (!busy) return
      queueRef.current = []
      setQueue([])
      abortRef.current?.abort()
      return
    }
    if (key.ctrl && value === "z") {
      let i = messages.length - 1
      while (i >= 0 && messages[i].role !== "user") i--
      if (i < 0) return
      const content = messages[i].content
      const kept = messages.slice(0, i)
      setMessages(kept)
      updateActive(() => {}, kept)
      queueRef.current = []
      setQueue([])
      setInput(content)
      if (busy) abortRef.current?.abort()
      return
    }
    if (key.ctrl && value === "s") {
      if (!busy) return
      const text = input.trim()
      if (!text && !queueRef.current.length) return
      setInput("")
      if (text) {
        queueRef.current = [text, ...queueRef.current]
        setQueue(queueRef.current)
      }
      abortRef.current?.abort()
      return
    }
    if (key.ctrl && value === "e") {
      const q = queueRef.current
      if (!q.length) return
      const idx = Math.min(queueSel, q.length - 1)
      const item = q[idx]
      queueRef.current = q.filter((_, i) => i !== idx)
      setQueue(queueRef.current)
      setQueueSel(0)
      setInput(item)
      return
    }
    if (key.ctrl && key.upArrow) {
      if (queueRef.current.length) setQueueSel((s) => Math.max(0, s - 1))
      return
    }
    if (key.ctrl && key.downArrow) {
      if (queueRef.current.length) setQueueSel((s) => Math.min(queueRef.current.length - 1, s + 1))
      return
    }
    if (key.pageUp) {
      setScrollOffset((s) => s + 10)
      return
    }
    if (key.pageDown) {
      setScrollOffset((s) => Math.max(0, s - 10))
      return
    }
    // Esc：层级收起（模型面板 → 步骤卡片 → 步骤列表 → 队列/附件 → 输入）
    if (key.escape) {
      if (showModelPanel) {
        setShowModelPanel(false)
        return
      }
      if (focus === "steps-card") {
        setStepMode("list")
        return
      }
      if (focus === "steps-list") {
        setStepMode("collapsed")
        return
      }
      if (focus === "rename") {
        setRenaming(null)
        setInput("")
        return
      }
      if (focus === "side-chat" || focus === "side-tasks") {
        setSideFocus(false)
        return
      }
      if (queueRef.current.length) {
        queueRef.current = []
        setQueue([])
        pushNotice("已清空排队消息")
      } else if (attachments.length) {
        setAttachments([])
        pushNotice("附件已清空")
      } else {
        setInput("")
      }
      return
    }

    // ==== Enter（应答/确认/发送，按焦点分发） ====
    if (key.return) {
      const text = input.trim()
      setInput("")
      const f: Focus = focus
      switch (f) {
        case "model-picker": {
          const rows = pickerDisplayRowsRef.current
          const row = rows[Math.min(pickerSel, rows.length - 1)]
          if (!row) return
          if (row.type === "model") {
            const spec = `${row.provider}/${row.modelId}`
            setDefaultModel(spec)
            setSessionModel(spec)
            pushNotice(`默认模型 → ${spec}`)
          } else if (row.type === "vision") {
            const spec = `${row.provider}/${row.modelId}`
            saveConfig({ ...loadConfig(), visionModel: spec })
            pushNotice(`识图模型 → ${spec}`)
          }
          return
        }
        case "rename":
          if (text) updateActive((m) => (m.title = text), messages)
          setRenaming(null)
          return
        case "question": {
          const q = broker.pending
          if (q && !text && q.defaultOption) {
            broker.answer(q.defaultOption)
            return
          }
          if (q && q.options && /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= q.options.length) {
            broker.answer(q.options[Number(text) - 1])
            return
          }
          if (text && q) broker.answer(text)
          return
        }
        case "sidebar": {
          const target = filtered[selected]
          if (target) openSession(target)
          setFocusSidebar(false)
          return
        }
        case "steps-card":
        case "steps-list":
          return
        case "chat": {
          if (!text) return
          if (busy) {
            queueRef.current = [...queueRef.current, text]
            setQueue(queueRef.current)
            setQueueSel(queueRef.current.length - 1)
            return
          }
          if (text.startsWith("/")) void handleCommand(text)
          else void send(text)
          return
        }
      }
    }

    // ==== 导航键，按焦点分发 ====
    if (focus === "model-picker") {
      // 字符键（含粘贴文本）：直接关闭面板并落入输入框——面板开着时打字/粘贴不应被静默吞掉
      if (!key.ctrl && !key.meta && value && !key.upArrow && !key.downArrow && !key.return && !key.escape && !key.tab && !key.backspace && !key.delete && !key.leftArrow && !key.rightArrow && !key.pageUp && !key.pageDown) {
        setShowModelPanel(false)
        setInput((v) => v + value)
        return
      }
      if (key.upArrow || key.downArrow) {
        const rows = pickerDisplayRowsRef.current
        const dir = key.upArrow ? -1 : 1
        let i = Math.min(pickerSel, rows.length - 1)
        // 在可选行（model/vision）间移动，跳过标题与分组行
        for (let step = 0; step < rows.length; step++) {
          i += dir
          if (i < 0 || i >= rows.length) return
          const t = rows[i].type
          if (t === "model" || t === "vision") {
            setPickerSel(i)
            return
          }
        }
        return
      }
      return
    }
    if (focus === "steps-card") {
      if (key.upArrow) {
        setCardOffset((o) => Math.max(0, o - 5))
        return
      }
      if (key.downArrow) {
        setCardOffset((o) => o + 5)
        return
      }
      return
    }
    if (focus === "steps-list") {
      if (key.upArrow) setStepSel((s) => Math.max(0, s - 1))
      else if (key.downArrow) setStepSel((s) => Math.min(runSteps.length - 1, s + 1))
      return
    }
    if (focus === "sidebar") {
      if (key.upArrow) setSelected((s) => Math.max(0, s - 1))
      else if (key.downArrow) setSelected((s) => Math.min(filtered.length - 1, s + 1))
      else if (key.delete || value === "d") {
        const target = filtered[selected]
        if (target) {
          deleteSession(target.id)
          const rest = listSessions()
          setSessions(rest)
          if (active?.id === target.id) {
            if (rest.length) openSession(rest[0])
            else {
              const meta = createSession(process.cwd(), active.model)
              setSessions([meta])
              setActive(meta)
              setMessages([])
            }
          }
          pushNotice("会话已删除")
        }
        return
      }
      return
    }

    // ==== 输入编辑，按焦点分发（side 聚焦进右侧栏输入框） ====
    if (focus === "side-chat" || focus === "side-tasks") {
      if (key.backspace || key.delete) {
        setSideInput((v) => v.slice(0, -1))
        return
      }
      if (key.leftArrow || key.rightArrow) return
      if (key.ctrl) return
      if (value) setSideInput((v) => v + value)
      return
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1))
      return
    }
    if (key.leftArrow || key.rightArrow) return
    if (key.ctrl) return
    if (value) setInput((v) => v + value)
  })

  // 视口与面板行数（布局硬约束：row 区固定高，任何面板/消息溢出只在消息视口内消化）
  const columns = (process.stdout.columns ?? 100) - (sideOpen ? 38 : 0) - (showModelPanel ? 14 : 0)
  const rows = process.stdout.rows ?? 32
  const pendingQuestion = broker.pending
  const cfgPanel = loadConfig()
  const bodyH = Math.max(10, rows - 5) // 5 = header(3) + 按钮行(1) + 说明行(1)
  bodyHRef.current = bodyH
  // IME 候选框定位：把逻辑光标放到输入行行内光标处
  // 实现：给输入行 Box 挂 ref，每帧用 ink 内部 getAbsoluteContentPosition 读 Yoga 计算出的
  // 输入行绝对坐标（渲染前 onComputeLayout 已跑完，坐标是当前帧真实值），不用手算列偏移。
  // 侧栏是 flex 布局会被挤压（width=30 在 100 列终端实测只渲染 23 列），手算公式必然漂移。
  // 光标 x = 输入行内容起点 + "› "(2 列前缀) + input 显示宽度；y = 输入行行号
  {
    const node = inputRowRef.current as any
    const pos = node ? getAbsoluteContentPosition(node) : undefined
    const inMainInput = !renaming && !showModelPanel && focus !== "side-chat" && focus !== "side-tasks" && focus !== "sidebar" && focus !== "rename"
    const cursorX = pos ? pos.x + 2 + displayWidth(input) : 0
    const cursorY = pos ? pos.y : 0
    setCursorPosition(pos && inMainInput ? { x: cursorX, y: cursorY } : undefined)
    if (process.env.YYAGENT_IME_DEBUG) tlog("ime-cursor:", `x=${cursorX} y=${cursorY} pos=${pos ? `${pos.x},${pos.y}` : "none"} input=${input.length}`)
  }
  useEffect(() => {
    // 打开选择器时重置过滤词与选中位置（定位到当前默认模型）
    if (showModelPanel) {
      const i = modelRowsRef.current.findIndex((mr) => mr.spec === loadConfig().model)
      setPickerSel(Math.max(0, i))
    }
  }, [showModelPanel])
  // 模型选择器：主模型行 + 视觉模型行，统一一套选择逻辑（pickerSel = 行索引）
  // 模型面板的可切换模型行（渲染时记录，点击命中按底部锚定）
  // 过滤掉 key 未配置的通道（占位符），避免列出用不了的模型
  const modelRows: Array<{ spec: string; provider: string; modelId: string }> = showModelPanel
    ? Object.entries(cfgPanel.providers)
        .filter(([n, p]) => !/REPLACE_ME/i.test(p.apiKey))
        .flatMap(([n, p]) => (p.models ?? []).map((m) => ({ spec: `${n}/${m}`, provider: n, modelId: m })))
    : []
  modelRowsRef.current = modelRows
  const cardRecPre = stepMode === "card" ? runSteps[Math.min(stepSel, Math.max(0, runSteps.length - 1))] : null
  const cardBodyPre = cardRecPre
    ? [cardRecPre.input ? `[输入]\n${cardRecPre.input}` : "", cardRecPre.output ? `[输出]\n${cardRecPre.output}` : cardRecPre.pending ? "（执行中…）" : ""]
        .filter(Boolean)
        .join("\n\n")
        .split(/\r?\n/)
    : []
  const cardShowRows = Math.max(4, Math.min(cardBodyPre.length, rows - 26))
  const stepPanelRows = runSteps.length
    ? stepMode === "card"
      ? cardShowRows + 4
      : Math.min(runSteps.length, stepMode === "list" ? 10 : 3) + 3
    : 0
  // opencode 式选择器：主模型区 + 视觉模型区（区块标题 + 缩进模型行）
  type PickerRow =
    | { type: "mt" }
    | { type: "vt" }
    | { type: "group"; provider: string }
    | { type: "model"; provider: string; modelId: string; modelIdx: number }
    | { type: "vision"; provider: string; modelId: string; spec: string; visionIdx: number }
  const pickerDisplayRows: PickerRow[] = []
  {
    pickerDisplayRows.push({ type: "mt" })
    let last = ""
    modelRows.forEach((mr, idx) => {
      if (mr.provider !== last) {
        pickerDisplayRows.push({ type: "group", provider: mr.provider })
        last = mr.provider
      }
      pickerDisplayRows.push({ type: "model", provider: mr.provider, modelId: mr.modelId, modelIdx: idx })
    })
    // 视觉模型区：supportsImages 通道的模型
    let vIdx = 0
    pickerDisplayRows.push({ type: "vt" })
    Object.entries(cfgPanel.providers).forEach(([n, p]) => {
      if (!p.supportsImages) return
      if (!pickerDisplayRows.some((r) => r.type === "group" && r.provider === n)) {
        pickerDisplayRows.push({ type: "group", provider: n })
      }
      ;(p.models ?? []).forEach((m) => {
        pickerDisplayRows.push({ type: "vision", provider: n, modelId: m, spec: `${n}/${m}`, visionIdx: vIdx++ })
      })
    })
  }
  pickerDisplayRowsRef.current = pickerDisplayRows
  // 可视窗口：以 pickerSel 为中心滚动（模型多时侧栏高度不够，滚动而非截断）
  const maxPickerRows = Math.max(6, bodyH - 8)
  let pickerStart = 0
  if (pickerDisplayRows.length > maxPickerRows) {
    pickerStart = Math.min(
      Math.max(0, pickerSel - Math.floor(maxPickerRows / 2)),
      pickerDisplayRows.length - maxPickerRows,
    )
  }
  const pickerVisibleRows = pickerDisplayRows.slice(pickerStart, pickerStart + maxPickerRows)
  pickerWindowRef.current = { start: pickerStart, rows: pickerVisibleRows }
  const chatChrome =
    2 + // 聊天区上下边框
    1 + // 分隔线
    1 + // clipped/atBottom 提示
    (todo.length ? Math.min(todo.length, 8) + (todo.length > 8 ? 1 : 0) + 3 : 0) +
    (retryInfo ? 1 : 0) +
    (attachments.length ? 1 : 0) +
    (queue.length ? Math.min(queue.length, 6) + (queue.length > 6 ? 1 : 0) + 3 : 0) +
    stepPanelRows +
    (pendingQuestion ? (pendingQuestion.options?.length ? pendingQuestion.options.length + 3 : 2) : 0) +
    (busy ? 1 : 0) + // 输出区底部的执行状态行
    (streaming !== null ? 3 : 0) // 流式输出块（头行+margin+缓冲）
  const avail = Math.max(4, bodyH - chatChrome - 3) // -2 聊天区边框 -1 输入行
  // ---- 行级滚动视图 ----
  // 把所有消息按显示宽度包裹成行序列：每条消息 = 头行 + 内容物理行 + 空行（+步骤提示行）
  // scrollOffset = 从底部往上数的行偏移；视口 = 行序列的尾部切片，长消息因此可逐行上滑
  const effW = Math.max(20, columns - (sidebar ? (showModelPanel ? 46 : 32) : 0) - (sideOpen ? 40 : 0) - 6)
  type Row = { kind: "head" | "body" | "spacer" | "steps"; m?: StoredMessage; text?: string; mIdx?: number }
  const allRows: Row[] = []
  messages.forEach((m, mi) => {
    if (m.role === "system") return // T55：模型切换等系统提示只在 Web 渲染为分隔线，TUI 跳过
    const isUser = m.role === "user"
    allRows.push({ kind: "head", m, mIdx: mi, text: `${isUser ? "你" : "Yy Sustainer"} · ${new Date(m.ts).toLocaleTimeString("zh-CN")}` })
    for (const l of wrapText(m.content, effW)) allRows.push({ kind: "body", m, mIdx: mi, text: l })
    if (m.role === "assistant" && m.steps?.length) {
      allRows.push({ kind: "steps", m, mIdx: mi, text: `⚙ 经 ${m.steps.length} 步工具调用完成 · 本会话步骤可 Ctrl+J/K 浏览` })
    }
    allRows.push({ kind: "spacer" })
  })
  const totalRows = allRows.length
  const maxScrollRows = Math.max(0, totalRows - Math.max(1, avail))
  const scrollRows = Math.min(scrollOffset, maxScrollRows) // 兼容旧状态残留（如切换会话后的条偏移）
  const startRow = Math.max(0, totalRows - avail - scrollRows)
  const visibleRows = allRows.slice(startRow, startRow + avail)
  const clippedTop = startRow > 0
  const atBottom = scrollRows === 0
  const totalLinesLabel = totalRows
  totalScrollRowsRef.current = maxScrollRows

  // 步骤面板数据
  const stepIcon = (s: StepRecord) => (s.pending ? "▸" : "⏺")
  const cardRec = cardRecPre
  const cardBody = cardBodyPre

  const currentModel = active?.model ?? loadConfig().model
  const permMode = loadConfig().permission ?? "danger-confirm"

  return (
    <Box flexDirection="column" height={rows}>
      <Box borderStyle="round" paddingX={1} justifyContent="space-between" flexShrink={0}>
        <Box flexShrink={0}>
          <Text bold color="cyan">⚡ Yy Sustainer</Text>
          {!inputReady ? <Text bold color="red"> [⚠ 输入未就绪]</Text> : null}
          <Text color="magenta" wrap="truncate-end"> [{PERM_LABEL[permMode] ?? permMode}]</Text>
        </Box>
        <Box flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {active?.cwd ?? ""} · {currentModel} · 插件{plugins.length}
            {mcpInfo ? ` · MCP✓` : ""} · Ctrl+B 侧栏 · Ctrl+R 右栏 · /help
          </Text>
        </Box>
      </Box>
      <Box flexDirection="row" height={bodyH}>
        {sidebar && (
          <Box flexDirection="column" width={showModelPanel ? 44 : 30} borderStyle="round" borderDimColor paddingX={1}>
            {showModelPanel ? (
                // 模型选择器覆盖左侧栏；关闭后侧栏内容自动刷新回来
                <>
                  {pickerVisibleRows.map((row, i) => {
                                        if (row.type === "mt") {
                      return (
                        <Text key={`mt${i}`} bold color="yellow" wrap="truncate-end">
                          主模型（对话）
                        </Text>
                      )
                    }
                    if (row.type === "vt") {
                      return (
                        <Text key={`vt${i}`} bold color="yellow" wrap="truncate-end">
                          视觉模型（识图）
                        </Text>
                      )
                    }
                    if (row.type === "group") {
                      return (
                        <Text key={`g${i}`} color="cyan" wrap="truncate-end">
                          
                          {"　"}
                          {row.provider}
                        </Text>
                      )
                    }
                    if (row.type === "vision") {
                      const vSpec = row.spec
                      const isCurV = cfgPanel.visionModel === vSpec
                      return (
                        <Text
                          key={`v:${vSpec}`}
                          color={isCurV ? "green" : visionHover === row.visionIdx ? "black" : undefined}
                          backgroundColor={visionHover === row.visionIdx ? "blue" : undefined}
                          wrap="truncate-end"
                        >
                          
                          {isCurV ? "✓ " : "  "}
                          {row.modelId}
                        </Text>
                      )
                    }
                  const spec = `${row.provider}/${row.modelId}`
                  const isCur = cfgPanel.model === spec
                  const hl = hoverModelIdx >= 0 ? hoverModelIdx : pickerSel
                  const isHl = hl === pickerStart + i
                  return (
                    <Text
                      key={`m:${spec}`}
                      color={isCur ? "green" : isHl ? "black" : undefined}
                      backgroundColor={isHl ? "cyan" : undefined}
                      bold={isCur}
                      wrap="truncate-end"
                    >
                      
                      {"　　"}
                      {isCur ? "✓ " : isHl ? "▸ " : "  "}
                      {row.modelId}
                    </Text>
                  )
                  })}
                <Text dimColor>↑↓ 选 · Enter 切换 · Esc 关</Text>
              </>
            ) : (
              <>
                <Box marginBottom={1}>
                  <Text bold underline>对话</Text>
                  {search ? <Text color="yellow"> 🔍{search}</Text> : null}
                </Box>
                {filtered.map((s, i) => (
                  <Box key={s.id} flexDirection="column">
                    <Text
                      color={focusSidebar && i === selected ? "black" : sidebarHover === i ? "black" : undefined}
                      backgroundColor={focusSidebar && i === selected ? "cyan" : sidebarHover === i ? "blue" : undefined}
                      bold={active?.id === s.id}
                      wrap="truncate-end"
                    >
                      {active?.id === s.id ? "▸ " : "  "}
                      {s.title}
                    </Text>
                    <Text dimColor wrap="truncate-end">
                      　{s.model ?? ""} {relTime(s.updatedAt)}
                    </Text>
                  </Box>
                ))}
                {focusSidebar ? (
                  <Text dimColor>↑↓ 选 · Enter 开 · d 删除 · Tab 回</Text>
                ) : (
                  <Text dimColor>Tab 进侧栏</Text>
                )}
              </>
            )}
          </Box>
        )}
        {/* 主列：消息区 + 附件/队列/步骤 + 输入行（缺失此开标签会导致根容器提前闭合、按钮栏成为第二个顶层元素） */}
        <Box flexDirection="column" flexGrow={1}>
          <Box flexDirection="row" flexGrow={1}>
            <Box flexDirection="column" flexGrow={1}>
            {clippedTop ? <Text dimColor>↑ PgUp 看更早</Text> : null}
            {totalLinesLabel === 0 ? (
              <Box>
                <Text dimColor>开始新对话：直接输入任务，或 /help 查看命令</Text>
              </Box>
            ) : (
              visibleRows.map((row, ri) => {
                if (row.kind === "spacer") return <Box key={`r${ri}`} height={1} />
                const isUser = row.m?.role === "user"
                if (row.kind === "head") {
                  return (
                    <Text key={`r${ri}`}>
                      <Text color={isUser ? "green" : "cyan"} bold>▎</Text>
                      <Text bold color={isUser ? "green" : "cyan"}>
                        {isUser ? "你" : "Yy Sustainer"}
                      </Text>
                      <Text dimColor> · {row.text?.split(" · ").slice(1).join(" ·")}</Text>
                    </Text>
                  )
                }
                if (row.kind === "steps") {
                  return <Text key={`r${ri}`} dimColor>{row.text}</Text>
                }
                return <Text key={`r${ri}`}>{row.text}</Text>
              })
            )}
            {streaming !== null && (
              <Box flexDirection="column" marginBottom={1}>
                <Text>
                  <Text color="cyan" bold>▎</Text>
                  <Text bold color="cyan">
                    Yy Sustainer
                  </Text>
                  <Text dimColor> · {busyStatus}…</Text>
                </Text>
                <Text wrap="wrap">
                  {streaming}
                  <Text dimColor>▌</Text>
                </Text>
              </Box>
            )}
            {!atBottom ? <Text dimColor>↓ PgDn 回到最新 (偏移 {scrollRows}/{maxScrollRows} 行)</Text> : null}
            {busy ? (
              <Text color="yellow">
                {SPINNER[tick % SPINNER.length]} {busyStatus}…
              </Text>
            ) : null}
            </Box>
            {/* 滚动条轨道列（点击跳转 + 按住拖动 + 滚轮）：行级映射，滑块高度按可见占比伸缩 */}
            <Box flexDirection="column" width={1}>
              {Array.from({ length: Math.max(1, avail) }).map((_, i) => {
                const trackLen = Math.max(1, avail)
                const thumbLen = Math.max(1, Math.round((trackLen * Math.min(trackLen, avail)) / Math.max(trackLen, totalRows)))
                const thumbStart = Math.round((1 - (maxScrollRows ? scrollRows / maxScrollRows : 0)) * (trackLen - thumbLen))
                const isThumb = i >= thumbStart && i < thumbStart + thumbLen
                return (
                  <Text key={i} color={isThumb ? "cyan" : scrollDraggingRef.current ? "blue" : "gray"}>
                    {isThumb ? "┃" : scrollDraggingRef.current ? "╌" : "╎"}
                  </Text>
                )
              })}
            </Box>
          </Box>
          {attachments.length > 0 && (
            <Box>
              <Text color="blue" wrap="truncate-end">📎 {attachments.map((a) => a.split(/[\\/]/).pop()).join(", ")}</Text>
            </Box>
          )}
          <Box>
            <Text dimColor>{"─".repeat(Math.max(20, columns - 2))}</Text>
          </Box>
          {queue.length > 0 && (
            <Box flexDirection="column" borderStyle="single" borderDimColor paddingX={1}>
              <Text dimColor>
                ⏳ 排队 {queue.length} 条 · Ctrl+↑↓ 选 · Ctrl+E 编辑 · Ctrl+S 立即发送 · Esc 清空
              </Text>
              {queue.slice(0, 6).map((m, i) => (
                <Text
                  key={i}
                  color={i === queueSel ? "black" : "blue"}
                  backgroundColor={i === queueSel ? "blue" : undefined}
                  wrap="truncate-end"
                >
                  {i === queueSel ? "▸ " : "  "}
                  {m.slice(0, 70)}
                </Text>
              ))}
              {queue.length > 6 ? <Text dimColor>… 共 {queue.length} 条</Text> : null}
            </Box>
          )}
          {runSteps.length > 0 && (
            <Box flexDirection="column" borderStyle="single" borderDimColor paddingX={1}>
              {stepMode === "card" && cardRec ? (
                <Box flexDirection="column">
                  <Text color="cyan" wrap="truncate-end">
                    ▣ {cardRec.name} · {cardRec.argsSummary.slice(0, 60)}（↑↓ 滚动 · Ctrl+O 收起）
                  </Text>
                  {cardBody.slice(cardOffset, cardOffset + cardShowRows).map((l, i) => (
                    <Text key={i} wrap="wrap">{l}</Text>
                  ))}
                  <Text dimColor>行 {cardOffset + 1}-{Math.min(cardBody.length, cardOffset + cardShowRows)} / 共 {cardBody.length} 行</Text>
                </Box>
              ) : (
                <Box flexDirection="column">
                  <Text dimColor>
                    ⚙ 执行步骤 {runSteps.length}
                    {stepMode === "list" ? " · Ctrl+J/K 选择 · Ctrl+O 展开卡片" : " · Ctrl+J/K 展开"}
                  </Text>
                  {(stepMode === "list" ? runSteps.slice(-10) : runSteps.slice(-3)).map((s, i) => {
                    const base = runSteps.length - (stepMode === "list" ? Math.min(10, runSteps.length) : Math.min(3, runSteps.length))
                    const idx = base + i
                    return (
                      <Text
                        key={s.id + String(i)}
                        color={s.pending ? "yellow" : stepMode === "list" && idx === stepSel ? "black" : undefined}
                        backgroundColor={stepMode === "list" && idx === stepSel ? "cyan" : undefined}
                        wrap="truncate-end"
                      >
                        {stepIcon(s)} {s.name} · {s.argsSummary || (s.pending ? "执行中" : "完成")}
                      </Text>
                    )
                  })}
                </Box>
              )}
            </Box>
          )}
          {retryInfo ? (
            <Box>
              <Text color="red" wrap="truncate-end">
                {SPINNER[tick % SPINNER.length]} {retryInfo}
              </Text>
            </Box>
          ) : null}
          <Box ref={inputRowRef} justifyContent="space-between">
            <Box>
              <Text color={renaming ? "yellow" : "green"}>{renaming ? "✎ " : "› "}</Text>
              <Text>{input}</Text>
              {!busy ? <Text dimColor>▌</Text> : null}
            </Box>
            {busy ? (
              <Text
                color={sendHover ? "black" : "red"}
                backgroundColor={sendHover ? "red" : undefined}
                bold={sendHover}
              >
                {sendHover ? " ■ 停止 (Ctrl+Q) " : "■ 停止 (Ctrl+Q)"}
              </Text>
            ) : (
              <Text
                color={sendHover ? "black" : "green"}
                backgroundColor={sendHover ? "green" : undefined}
                bold={sendHover}
              >
                {sendHover ? " ▶ 发送 (Enter) " : "▶ 发送 (Enter)"}
              </Text>
            )}
          </Box>
          {pendingQuestion ? (
            <Box flexDirection="column" borderStyle="single" borderDimColor paddingX={1}>
              <Text color="magenta" bold wrap="wrap">❓ {pendingQuestion.question}</Text>
              {pendingQuestion.options?.length ? (
                <Box flexDirection="column" paddingLeft={2}>
                  {pendingQuestion.options.map((o, i) => (
                    <Text key={i} color={o === pendingQuestion.defaultOption ? "magenta" : undefined} wrap="wrap">
                      {i + 1}) {o}
                      {o === pendingQuestion.defaultOption ? "  ★推荐（回车即选）" : ""}
                    </Text>
                  ))}
                  <Text dimColor>输入数字选选项 · 直接输入 = 自定义答案{pendingQuestion.defaultOption ? " · 回车 = 选推荐" : ""}</Text>
                </Box>
              ) : (
                <Text dimColor>输入回答后回车</Text>
              )}
            </Box>
          ) : null}
        </Box>
        {sideOpen && (
          <Box flexDirection="column" width={38} borderStyle="round" borderDimColor paddingX={1}>
            <Box justifyContent="space-between">
              <Text bold color={sideTab === "chat" ? "cyan" : undefined} backgroundColor={sideFocus && sideTab === "chat" ? "blue" : undefined}>
                ⟡ 对话
              </Text>
              <Text bold color={sideTab === "tasks" ? "cyan" : undefined} backgroundColor={sideFocus && sideTab === "tasks" ? "blue" : undefined}>
                ☑ 任务
              </Text>
              <Text dimColor>{sideFocus ? "已聚焦" : "Ctrl+I 聚焦"}</Text>
            </Box>
            {sideTab === "chat" ? (
              <>
                <Box marginBottom={1}>
                  <Text dimColor wrap="truncate-end">
                    ▸ {(sessions.find((s) => s.title.startsWith("⟡")) ?? sessions[sideSel] ?? active)?.title ?? "（无）"}
                  </Text>
                </Box>
                <Box flexDirection="column" flexGrow={1}>
                  {sideMsgs.slice(-6).map((m, mi) => {
                    const t = truncateLines(m.content, 5)
                    return (
                      <Box key={`${m.ts}-${m.role}-${mi}`} flexDirection="column" marginBottom={0}>
                        <Text>
                          <Text color={m.role === "user" ? "green" : "cyan"} bold>▎</Text>
                          <Text bold color={m.role === "user" ? "green" : "cyan"}>
                            {m.role === "user" ? "你" : "辅助"}
                          </Text>
                        </Text>
                        <Text wrap="wrap">{t.text}</Text>
                        {t.clipped ? <Text dimColor>…</Text> : null}
                      </Box>
                    )
                  })}
                  {sideStreaming !== null && (
                    <Text color="yellow" wrap="wrap">{sideStreaming}▌</Text>
                  )}
                </Box>
                <Box>
                  {sideBusy ? (
                    <Text color="yellow">…执行中</Text>
                  ) : (
                    <Text
                      color={sideSendHover ? "black" : "green"}
                      backgroundColor={sideSendHover ? "green" : undefined}
                      bold={sideSendHover}
                    >
                      {sideSendHover ? " ▶ 发送 " : "▶ 发送"}
                    </Text>
                  )}
                  <Text>{sideFocus ? sideInput : ""}</Text>
                  {sideFocus && !sideBusy ? <Text dimColor>▌</Text> : null}
                </Box>
                <Text dimColor wrap="truncate-end">
                  {sideFocus ? "输入需求 · Enter 发送（SEND: 行自动发主对话）· Esc 退出聚焦" : "Ctrl+I 聚焦输入 · Ctrl+T 切任务"}
                </Text>
              </>
            ) : (
              (() => {
                const cfgFile = join(PKG_ROOT, "yyagentd.config.json")
                const tasks: Array<{ name: string; cron: string; enabled?: boolean }> = existsSync(cfgFile)
                  ? ((JSON.parse(readFileSync(cfgFile, "utf8")).tasks ?? []) as typeof tasks)
                  : []
                let lastSummary = ""
                const hf = join(PKG_ROOT, "logs", "history.jsonl")
                if (existsSync(hf)) {
                  const lines = readFileSync(hf, "utf8").trimEnd().split(/\r?\n/)
                  for (let i = lines.length - 1; i >= 0; i--) {
                    try {
                      const rec = JSON.parse(lines[i]) as { report?: string; error?: string; task: string }
                      lastSummary = `${rec.task}: ${(rec.report ?? rec.error ?? "").slice(0, 120)}`
                      break
                    } catch {
                      /* 跳过坏行 */
                    }
                  }
                }
                return (
                  <Box flexDirection="column">
                    {tasks.length ? (
                      tasks.map((t, i) => (
                        <Text
                          key={t.name}
                          color={sideFocus && i === sideSel ? "black" : t.enabled === false ? "dimColor" : undefined}
                          backgroundColor={sideFocus && i === sideSel ? "cyan" : undefined}
                          wrap="truncate-end"
                        >
                          {t.enabled === false ? "○" : "●"} {t.name} · {t.cron}
                        </Text>
                      ))
                    ) : (
                      <Text dimColor>无定时任务</Text>
                    )}
                    <Text dimColor>↑↓ 选 · Enter 立即运行（完成有系统通知）</Text>
                    {lastSummary ? <Text dimColor wrap="wrap">最近: {lastSummary}</Text> : null}
                  </Box>
                )
              })()
            )}
          </Box>
        )}
      </Box>
      <Box>
        {visibleButtonsRef.current.map((b, i) => (
          <Text
            key={b.act}
            color={i === hoverBtn ? "black" : "cyan"}
            backgroundColor={i === hoverBtn ? "cyan" : undefined}
            bold={i === hoverBtn}
          >
            {b.label}
            {i < visibleButtonsRef.current.length - 1 ? " " : ""}
          </Text>
        ))}
      </Box>
      <Box>
        {activeButton ? (
          <Text color="yellow" wrap="truncate-end">ℹ {activeButton.label} — {activeButton.desc}</Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            {busy
              ? "Ctrl+Q 停止 · Ctrl+Z 撤回编辑 · Ctrl+S 立即发送排队 · PgUp/PgDn 翻历史"
              : "Enter 发送 · /attach 附件 · /perm 权限 · /help 全部 · PgUp 翻历史"}
          </Text>
        )}
      </Box>
    </Box>
  )
}

function statIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
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

function fmtK(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}



