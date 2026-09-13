import { tool, type Tool } from "ai"
import { z } from "zod"
import { spawn } from "node:child_process"
import { AsyncLocalStorage } from "node:async_hooks"
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import fg from "fast-glob"
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici"
import { gate, isDangerCommand, type PermissionMode } from "./permissions.js"
import { loadConfig } from "./config.js"
import { runHooksOnTool } from "./hooks.js"
import { memoryTools } from "./memory.js"
import { pastChatTools } from "./pastchats.js"
import { makeTodoTool } from "./todo.js"
import { makeAskTool } from "./ask.js"
import { upsertDbRecord, queryDb, deleteDbRecord, listDbs, BUILTIN_DBS } from "./db.js"
import { sceneTools } from "./sceneTools.js"
import { taskTools } from "./tasks.js"
import { trackFileChange } from "./fileTrack.js"
import { psCommand, runPowerShell, truncate } from "./ps.js"
import { makeComputerTool } from "./computer.js"

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
}

export const toolCtx = new AsyncLocalStorage<ToolContext>()

function currentCwd(): string {
  return toolCtx.getStore()?.cwd ?? process.cwd()
}

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
let bgSeq = 0

function startBackground(command: string, cwd: string): string {
  const id = `bg-${++bgSeq}`
  const logDir = join(homedir(), ".yyagent", "bg")
  mkdirSync(logDir, { recursive: true })
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
  child.on("exit", (code) => {
    entry.done = true
    entry.exitCode = code
    stream.end()
  })
  return id
}

// T14 会话级权限档位：每会话可独立选择（不互相混淆）；未设置的会话回落全局 config.permission
type PermissionMode3 = "confirm-all" | "danger-confirm" | "full-auto"
const sessionPermission = new Map<string, PermissionMode3>()
export function setSessionPermission(sessionId: string, mode: PermissionMode3): void {
  sessionPermission.set(sessionId, mode)
}
export function getSessionPermission(sessionId: string): PermissionMode3 | undefined {
  return sessionPermission.get(sessionId)
}
export function deleteSessionPermission(sessionId: string): void {
  sessionPermission.delete(sessionId)
}
function effectivePermission(): PermissionMode3 {
  const sid = toolCtx.getStore()?.sessionId
  const override = sid ? sessionPermission.get(sid) : undefined
  return (override ?? loadConfig().permission ?? "danger-confirm") as PermissionMode3
}

// ---------- 工具定义 ----------

export const bashTool = tool({
  description:
    "在 Windows PowerShell 中执行命令。危险命令（sudo、rm -rf、提权、密钥赋值）按权限档位确认或拒绝。构建/测试/长任务用 background=true 转后台，用 bg_read 查看输出。",
  inputSchema: z.object({
    command: z.string().describe("要执行的 PowerShell 命令"),
    timeoutMs: z.number().optional().describe("前台超时毫秒数，默认 120000"),
    background: z.boolean().optional().describe("转为后台任务（不阻塞），返回任务 id 与日志路径"),
  }),
  async execute({ command, timeoutMs, background }) {
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
        })
    if (rejection) return rejection
    const cwd = currentCwd()
    if (background) {
      const id = startBackground(command, cwd)
      const e = bgTasks.get(id)!
      return `[后台任务已启动] id=${id}\n命令=${command}\n日志=${e.logFile}\n用 bg_read(task_id="${id}") 查看输出`
    }
    return runPowerShell(command, timeoutMs ?? 120_000, cwd)
  },
})

export const bgReadTool = tool({
  description: "查看后台任务：不传 task_id 列出全部任务状态；传 task_id 读该任务日志尾部",
  inputSchema: z.object({
    task_id: z.string().optional().describe("后台任务 id，如 bg-1"),
    lines: z.number().optional().describe("读取日志尾部行数，默认 40"),
  }),
  async execute({ task_id, lines }) {
    if (!task_id) {
      if (!bgTasks.size) return "暂无后台任务"
      return [...bgTasks.entries()]
        .map(([id, e]) => {
          const dur = Math.round((Date.now() - e.startedAt) / 1000)
          return `${id} ${e.done ? `已结束(code=${e.exitCode})` : "运行中"} ${dur}s pid=${e.pid} | ${e.command.slice(0, 80)} | ${e.logFile}`
        })
        .join("\n")
    }
    const e = bgTasks.get(task_id)
    if (!e) return `未找到任务 ${task_id}（用 bg_read 不带参数列出全部）`
    if (!existsSync(e.logFile)) return `日志尚无内容（任务${e.done ? "已结束" : "运行中"}）`
    const all = readFileSync(e.logFile, "utf8").split(/\r?\n/)
    const tail = all.slice(-(lines ?? 40)).join("\n")
    return `[${task_id}] ${e.done ? `已结束(code=${e.exitCode})` : "运行中"}\n${truncate(tail) || "(无输出)"}`
  },
})

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
    const lines = readFileSync(p, "utf8").split(/\r?\n/)
    const start = Math.max(0, (offset ?? 1) - 1)
    const end = Math.min(lines.length, start + (limit ?? 2000))
    const body = lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join("\n")
    return truncate(body || "(空文件)")
  },
})

export const writeTool = tool({
  description: "写入文件（覆盖，用于新建或彻底重写）。相对路径基于当前工作目录。",
  inputSchema: z.object({
    file_path: z.string().describe("文件路径"),
    content: z.string().describe("完整文件内容"),
  }),
  async execute({ file_path, content }) {
    const p = resolve(currentCwd(), file_path)
    const mode = effectivePermission()
    const rejection = await gate({ tool: "write", summary: p, danger: false, mode, broker: toolCtx.getStore()?.broker })
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
    const p = resolve(currentCwd(), file_path)
    const mode = effectivePermission()
    const rejection = await gate({ tool: "edit", summary: p, danger: false, mode, broker: toolCtx.getStore()?.broker })
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
    "把持久信息写入场景数据库（~/.yyagent/db/，跨会话永久保存）。可用库：notes（笔记：title/content）、contacts（联系人·搭子：name/type/contact/note）、knowledge（知识片段：topic/content/source）。用户说「记一下/存到库里/记住这个联系人」时使用。返回带 id，可用于更新或删除。",
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
    try {
      const r = await runAgent(task, { system: p.system, tools, maxSteps: 30, cwd: currentCwd() })
      return r.text
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
    t.computer = makeComputerTool({ permission: effectivePermission, broker: () => toolCtx.getStore()?.broker })
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
  for (const k of Object.keys(t)) {
    const tool = t[k]
    if (typeof tool.execute !== "function") continue
    const orig = tool.execute.bind(tool)
    t[k] = {
      ...tool,
      execute: async (input: never, options: never) => {
        const out = await orig(input, options)
        try {
          return await runHooksOnTool(k, out as string)
        } catch {
          return out
        }
      },
    } as typeof tool
  }
  return t
}
