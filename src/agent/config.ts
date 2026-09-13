import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

// P1-8 / P-1 发行版：跑随包 Node 脚本（MCP 适配层等）的可执行文件。
// 开发态 execPath 就是 node；打包态是 Electron 壳（Yy Sustainer.exe），它靠 ELECTRON_RUN_AS_NODE=1
// 当纯 Node 用 —— 所以这里一律返回 execPath，不再回落字符串 "node"（别人机器上没有 node 在 PATH 里，
// 回落等于必然 spawn ENOENT）。
function nodeBin(): string {
  return process.execPath
}

/** 在 PATH 里找一个可执行文件（Windows 认 .cmd/.exe/.bat，找不到再试无扩展名） */
export function whichSync(bin: string): string | null {
  const isWin = process.platform === "win32"
  const exts = isWin ? [".cmd", ".exe", ".bat", ""] : [""]
  const dirs = (process.env.PATH ?? "").split(isWin ? ";" : ":").filter(Boolean)
  for (const d of dirs) {
    for (const ext of exts) {
      const p = join(d, bin + ext)
      try {
        if (existsSync(p)) return p
      } catch { /* 无权限/坏路径，继续 */ }
    }
  }
  return null
}

// P-1 发行版：本文件开发态在 <root>/src/agent/，打包后整包变成 <root>/dist/gateway.mjs 单文件
// （esbuild 把全部模块打进一个文件），到「仓库根」的相对深度不一样 —— 写死 "../.." 或 ".."
// 必然有一侧解析错。所以改成从本文件所在目录向上找「带 scripts/ 目录的那层」当根。
let appRootCached: string | null = null
export function appRoot(): string {
  if (appRootCached) return appRootCached
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "scripts"))) {
      appRootCached = dir
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  appRootCached = process.cwd()
  return appRootCached
}

export interface ProviderConfig {
  baseURL: string
  apiKey: string
  /** 该通道模型是否支持图片输入（支持则附件图片直传主模型，不走识图模型） */
  supportsImages?: boolean
  /** 该通道可切换的模型 ID 列表（模型管理面板展示） */
  models?: string[]
}

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

/** T66 钩子配置：每步工具执行后用模型按 prompt 检查一次输出（内置钩子 builtin:true 不可删除可开关） */
export interface HookConfig {
  id: string
  name: string
  builtin?: boolean
  enabled: boolean
  prompt: string
}

/** T66 内置钩子（安全/输出格式）：种子与开关归属配置层，hooks.ts 从这里导入 */
export const BUILTIN_HOOKS: Array<HookConfig> = [
  {
    id: "builtin-safety",
    name: "安全钩子",
    builtin: true,
    enabled: true,
    prompt:
      "检查本次工具执行/输出是否存在安全风险：删除或覆盖重要文件（rm、del、强制覆盖）、泄露密钥或隐私（打印 API Key、密码、token）、对外发送敏感数据、其他破坏性操作。存在风险回复「FAIL：原因（简短）」；否则只回复 PASS。",
  },
  {
    id: "builtin-format",
    name: "输出格式钩子",
    builtin: true,
    enabled: false,
    prompt:
      "检查本次输出是否符合要求：使用中文、结构清晰（必要时分点）、关键结论明确、无未解释的报错堆栈、无占位内容。不符合回复「FAIL：原因（简短）」；否则只回复 PASS。",
  },
]

export interface YyagentConfig {
  providers: Record<string, ProviderConfig>
  model: string
  maxSteps?: number
  taskTimeoutMs?: number
  /** T30 收敛时限（毫秒）：单个 run 连续运转超过此时长，引擎强制停轮并引导模型进入验证与收尾，默认 180000（3 分钟） */
  convergeTimeoutMs?: number
  permission?: "confirm-all" | "danger-confirm" | "full-auto"
  visionModel?: string
  /** T15 默认生图模型（"provider/modelId"）：imggen 优先用它调 images/generations；留空自动猜 */
  imageModel?: string
  /** P1-9 网页搜索引擎（websearch 工具用），默认 bing */
  searchEngine?: "bing" | "duckduckgo" | "baidu"
  /** 长任务模式：上下文超过模型窗口 60% 就滚动压缩（关闭时 90% 兜底压缩） */
  longTask?: boolean
  /** T66 钩子：每步工具执行完后用模型检查一次输出，不通过则追加修正提示（内置安全/输出格式 + 自定义） */
  hooks?: HookConfig[]
  /** T68 个人化设置服务端化：theme/font/rail/hotkeys/侧栏折叠与宽度等——跨入口(Electron/浏览器)/重启/设备共用一份，不再受 localStorage 按 origin/档案隔离之限 */
  ui?: Record<string, string>
  /** 多项目拆分器用的快速模型（如 siliconflow/qwen3.8-flash）；缺省用主模型——慢模型会把 /api/chat 挂几分钟 */
  splitterModel?: string
  /** 多项目拆分器 LLM 调用超时毫秒数，默认 120000；超时视为拆分失败，回落原流程 */
  splitterTimeoutMs?: number
  /** 监工模式：主对话任务完成后自动调辅助对话检查，有遗漏自动发回主对话 */
  watch?: boolean
  /** T67 出海代理：HTTP(S) 代理 URL（如 Clash 的 http://127.0.0.1:7897）。
   * 设置后全局 fetch 走该代理（Electron/桌面双击启动读不到终端环境变量的场景下，
   * Gemini 等海外 provider 唯一的连通路径）；留空则回退 HTTP(S)_PROXY 环境变量。 */
  proxy?: string
  /** 模型上下文窗口（tokens），用于压缩阈值计算，默认 131072 */
  contextTokens?: number
  mcpServers?: Record<string, McpServerConfig>
}

const CONFIG_PATH = join(homedir(), ".yyagent", "config.json")

let cached: YyagentConfig | null = null

export function configPath(): string {
  return CONFIG_PATH
}

export function loadConfig(): YyagentConfig {
  if (cached) return cached
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(join(CONFIG_PATH, ".."), { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify({ providers: {}, model: "" }, null, 2))
  }
  cached = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as YyagentConfig
  // T66 内置钩子种子：首次加载或手动删过时补回（builtin 钩子保证至少存在于配置中，开关可控）
  const builtinIds = new Set((cached.hooks ?? []).map((h) => h.id))
  const missing = BUILTIN_HOOKS.filter((b) => !builtinIds.has(b.id))
  if (missing.length) {
    cached.hooks = [...(cached.hooks ?? []), ...missing]
    writeFileSync(CONFIG_PATH, JSON.stringify(cached, null, 2))
  }
  return cached
}

export function saveConfig(config: YyagentConfig): void {
  cached = config
  mkdirSync(join(CONFIG_PATH, ".."), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

export function addProvider(name: string, baseURL: string, apiKey: string, model: string): void {
  const config = loadConfig()
  config.providers[name] = { baseURL, apiKey }
  saveConfig(config)
}

/** 添加模型：provider 已存在则追加 modelId 到 models 列表（不覆盖 baseURL/apiKey），不存在则新建 */
export function addModelToProvider(providerName: string, baseURL: string, apiKey: string, modelId: string, supportsImages?: boolean): void {
  const config = loadConfig()
  const existing = config.providers[providerName]
  if (existing) {
    if (!existing.models) existing.models = []
    if (!existing.models.includes(modelId)) existing.models.push(modelId)
    if (supportsImages !== undefined) existing.supportsImages = supportsImages
  } else {
    config.providers[providerName] = { baseURL, apiKey, models: [modelId], ...(supportsImages !== undefined ? { supportsImages } : {}) }
  }
  saveConfig(config)
}

export function setDefaultModel(spec: string): void {
  const config = loadConfig()
  config.model = spec
  saveConfig(config)
}

/** P1-8 默认 MCP 接入：首次使用且无任何 MCP 配置时，预置 Tabbit 浏览器（随包分发，必可用）；
 *  Edge/Playwright 要靠 npx 现拉包，只在机器上真的装了 Node 时才种 —— 否则每次启动都会
 *  留一条 "spawn npx ENOENT" 错误，用户以为是程序坏了。 */
export function ensureDefaultMcpServers(): void {
  const config = loadConfig()
  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) return
  const servers: Record<string, McpServerConfig> = {}

  // Tabbit 浏览器：包官方 tabbit-cli 的 MCP 适配层（T44 替换旧的 CDP server）。
  // 旧方案要求 Tabbit 以 --remote-debugging-port=9222 启动，日常打开的浏览器没有该端口，
  // 调用必然 "Not connected"，且 launch 工具会 taskkill 掉用户正在用的浏览器。
  // 路径随包解析（scripts/ 目录），不再写死开发机的绝对路径。
  const tabbitScript = join(appRoot(), "scripts", "tabbit-cli-mcp.mjs")
  if (existsSync(tabbitScript)) {
    servers.tabbit = {
      command: nodeBin(),
      args: [tabbitScript],
      // 打包态 execPath 是 Electron 壳，必须显式声明「按纯 Node 运行」；真 node 下此变量无害。
      env: { ELECTRON_RUN_AS_NODE: "1" },
    }
  }

  // Microsoft Edge：官方 Playwright MCP，直接以 Edge 为后端浏览器（需要本机有 npx）
  if (whichSync("npx")) {
    servers.edge = { command: "npx", args: ["-y", "@playwright/mcp@latest", "--browser", "msedge"] }
  }

  if (Object.keys(servers).length === 0) return
  config.mcpServers = servers
  saveConfig(config)
}

export function resolveModel(config: YyagentConfig, modelSpec?: string) {
  const spec = modelSpec ?? config.model
  const [providerName, ...rest] = spec.split("/")
  const modelId = rest.join("/")
  const provider = config.providers[providerName]
  if (!provider) throw new Error(`未配置的 provider: ${providerName}（用 /model add 添加，或检查 ~/.yyagent/config.json）`)
  return { providerName, modelId, provider }
}
