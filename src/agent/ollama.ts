// P-1 发行版友好：本地免费模型（Ollama）接入。
//
// 背景：安装包里**不塞权重**（7B 就 4.8GB，塞进去安装包没人愿意下），改成首启动一键下载：
// 检测本机 Ollama → 没有就引导装一个（~700MB）→ 用官方 /api/pull 流式拉模型 → 自动写好 provider。
// 用户全程不碰 API Key、不花钱，这是"下载即用"体验里唯一现实可行的免费路径。
//
// 三个坑写在这里，改之前先读：
// ① Ollama 的默认端口 11434 是**本地**地址。引擎全局装了代理 dispatcher（tools.ts），
//    但那里已经把 127.0.0.1/localhost 永久加进 no_proxy —— 所以这里直接 fetch 是安全的，
//    不要自己再拼代理，否则本地模型必挂且报错看着像"上游 502"。
// ② /api/pull 是 **NDJSON 流**（一行一个 JSON），不是 SSE（没有 "data: " 前缀）。
//    按行切、逐行 JSON.parse，最后一行可能没有换行符 —— 收尾时要把残留 buffer 也喂进去。
// ③ 模型名必须带 tag（qwen2.5:7b），裸名 "qwen2.5" 在部分版本会拉到 latest 之外的意外结果，
//    所以推荐列表里一律写全。
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadConfig, saveConfig, whichSync } from "./config.js"

/** Ollama 服务地址。环境变量 OLLAMA_HOST 允许写成 "127.0.0.1:11434"（官方风格，无 scheme） */
export const OLLAMA_BASE = (() => {
  const raw = (process.env.OLLAMA_HOST ?? "").trim().replace(/\/+$/, "")
  if (!raw) return "http://127.0.0.1:11434"
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
})()

/** 首启动引导里给用户的三档选择。大小是解压后的磁盘占用，不是下载量。 */
export interface ModelChoice {
  /** Ollama 模型名（带 tag） */
  model: string
  /** 展示名 */
  label: string
  /** 磁盘占用（GB，解压后） */
  sizeGB: number
  /** 一句话定位 */
  note: string
  /** 是否具备可用的工具调用能力（agent 场景的硬门槛） */
  agentReady: boolean
}

export const MODEL_CHOICES: ModelChoice[] = [
  {
    model: "qwen2.5:0.5b",
    label: "轻量 0.5B",
    sizeGB: 0.4,
    note: "只够闲聊和简单改写；不支持工具调用，agent 能力基本不可用。适合先验证链路通不通。",
    agentReady: false,
  },
  {
    model: "qwen2.5:3b",
    label: "均衡 3B",
    sizeGB: 2.0,
    note: "日常问答够用，工具调用时好时坏。适合低配机器（8GB 内存）日常使用。",
    agentReady: false,
  },
  {
    model: "qwen2.5:7b",
    label: "推荐 7B",
    sizeGB: 4.7,
    note: "本地能真正跑 agent（工具调用稳定）的最小档位，建议 16GB 内存。",
    agentReady: true,
  },
]

export interface OllamaStatus {
  /** 找到了 ollama 可执行文件（PATH 或 Windows 默认安装位置） */
  installed: boolean
  /** 服务在跑（/api/tags 能通） */
  running: boolean
  /** 服务版本，未运行时为空串 */
  version: string
  /** 已下载的模型名列表 */
  models: string[]
  /** 服务地址（前端展示/排错用） */
  base: string
}

/** 找到 ollama 可执行文件：先 PATH，再 Windows 默认安装位置（装完没重开终端时 PATH 里没有） */
export function findOllamaBin(): string | null {
  const inPath = whichSync("ollama")
  if (inPath) return inPath
  if (process.platform === "win32") {
    const guesses = [
      join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "Ollama", "ollama.exe"),
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Ollama", "ollama.exe"),
    ]
    for (const g of guesses) if (existsSync(g)) return g
  }
  return null
}

async function getJson(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; data: unknown }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ac.signal })
    const text = await r.text()
    let data: unknown = null
    try { data = JSON.parse(text) } catch { data = text }
    return { ok: r.ok, status: r.status, data }
  } catch {
    return { ok: false, status: 0, data: null }
  } finally {
    clearTimeout(timer)
  }
}

export async function ollamaStatus(timeoutMs = 1500): Promise<OllamaStatus> {
  const base = OLLAMA_BASE
  const tags = await getJson(`${base}/api/tags`, timeoutMs)
  const models = tags.ok
    ? (((tags.data as { models?: Array<{ name?: string }> })?.models ?? []).map((m) => m.name ?? "").filter(Boolean))
    : []
  let version = ""
  if (tags.ok) {
    const v = await getJson(`${base}/api/version`, 1200)
    version = String((v.data as { version?: string })?.version ?? "")
  }
  return { installed: !!findOllamaBin(), running: tags.ok, version, models, base }
}

/** Ollama 装了但没在跑时，把它拉起来（后台常驻），最多等 waitMs 毫秒 */
export async function ensureOllamaRunning(waitMs = 12000): Promise<OllamaStatus> {
  let st = await ollamaStatus()
  if (st.running) return st
  const bin = findOllamaBin()
  if (!bin) return st
  try {
    const child = spawn(bin, ["serve"], { detached: true, stdio: "ignore", windowsHide: true })
    child.unref()
  } catch { /* 起不来就让下面轮询去判失败 */ }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600))
    st = await ollamaStatus(1200)
    if (st.running) return st
  }
  return st
}

export interface PullEvent {
  status?: string
  completed?: number
  total?: number
  error?: string
}

/**
 * 流式拉模型：逐行解析 /api/pull 的 NDJSON。
 * onEvent 每收到一行调一次；失败抛 Error（把 Ollama 的 error 字段原样带出来）。
 */
export async function pullModel(
  model: string,
  onEvent: (e: PullEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const r = await fetch(`${OLLAMA_BASE}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: model, stream: true }),
    signal,
  })
  if (!r.ok || !r.body) {
    const text = await r.text().catch(() => "")
    throw new Error(`Ollama 拉取失败（HTTP ${r.status}）${text ? `：${text.slice(0, 300)}` : ""}`)
  }
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const feed = (line: string) => {
    const s = line.trim()
    if (!s) return
    let obj: PullEvent
    try { obj = JSON.parse(s) as PullEvent } catch { return }
    if (obj.error) throw new Error(`Ollama：${obj.error}`)
    onEvent(obj)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      feed(line)
    }
  }
  buf += decoder.decode()
  feed(buf) // 收尾：最后一行常常没有换行符
}

/**
 * 把 Ollama 写成一个 provider（OpenAI 兼容端点），并把默认模型指过去。
 * Ollama 不校验 Key，随便填一个非空串即可 —— 但**不能为空**，
 * 因为 statePayload 会用 /REPLACE_ME/ 过滤占位，空串走的是另一条判断，容易被吞掉。
 */
export function wireOllamaProvider(model: string, already: string[] = []): { spec: string; provider: string } {
  const cfg = loadConfig()
  const models = Array.from(new Set([...(cfg.providers.ollama?.models ?? []), ...already, model]))
  cfg.providers.ollama = {
    baseURL: `${OLLAMA_BASE}/v1`,
    apiKey: "ollama",
    models,
    supportsImages: false,
  }
  cfg.model = `ollama/${model}`
  if (!cfg.permission) cfg.permission = "danger-confirm"
  saveConfig(cfg)
  return { spec: `ollama/${model}`, provider: "ollama" }
}
