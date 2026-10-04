import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { decryptSecret, encryptSecret, redactLegacyBackupKeys } from "./secrets.js"

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
  /**
   * T93 L1：判定**缺失**时是否按「存疑」处理。默认 false（= 通过，fail-open 别打断干活）。
   * 安全类钩子该开——旧实现「找不到该钩子的行即按通过」，模型答歪/超时/返回空
   * 都等于「没风险」，方向是反的。开了也不是阻断，只是追加一句「请自行复核」。
   */
  strict?: boolean
}

/** T66 内置钩子（安全/输出格式）：种子与开关归属配置层，hooks.ts 从这里导入 */
export const BUILTIN_HOOKS: Array<HookConfig> = [
  {
    id: "builtin-safety",
    name: "安全钩子",
    builtin: true,
    enabled: true,
    // 判不出 ≠ 没风险：超时/返回空/答歪时至少提醒模型自行复核
    strict: true,
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
  {
    id: "builtin-paths",
    name: "路径纪律钩子",
    builtin: true,
    enabled: false,
    prompt:
      "检查本次工具执行/输出里出现的文件路径：是否全部来自上下文（环境扫描/用户消息/既有内容），是否存在凭空臆造、拼接错误或指向工作区之外的路径。发现可疑路径回复「FAIL：原因（简短）」；否则只回复 PASS。",
  },
  {
    id: "builtin-complete",
    name: "完成质量钩子",
    builtin: true,
    enabled: false,
    prompt:
      "检查本次输出是否留下未完成痕迹：出现 TODO/待补充/占位/略 等字样、只完成一半就收尾、结尾承诺后续要做却没有做。发现此类情况回复「FAIL：原因（简短）」；否则只回复 PASS。",
  },
  {
    id: "builtin-deps",
    name: "依赖安全钩子",
    builtin: true,
    enabled: false,
    prompt:
      "检查本次是否引入新依赖或执行了安装命令（npm i / pip install 等）：包名是否为主流知名包，是否与任务需求匹配，有无可疑拼写变体或来路不明的包。存在可疑依赖回复「FAIL：原因（简短）」；否则只回复 PASS。",
  },
  {
    id: "builtin-chinese",
    name: "中文回复钩子",
    builtin: true,
    enabled: false,
    prompt:
      "检查本次面向用户的输出是否以中文为主（代码、路径、专有名词除外）。若主体是外文回复「FAIL：原因（简短）」；否则只回复 PASS。",
  },
]

export interface YyagentConfig {
  providers: Record<string, ProviderConfig>
  model: string
  maxSteps?: number
  taskTimeoutMs?: number
  /**
   * T93 P2 交互轮总超时（毫秒）。`taskTimeoutMs` 只管 CLI 单跑 / 定时任务 / daemon，
   * **交互的 runTurn 一直没有总超时**——一个卡住的请求能让会话永远转圈。
   * 默认 0 = 不限（交互场景用户自己能点停止，不该替他决定）；
   * 设了就在超时后走既有的「停止」路径落库，不新增错误分支。
   * 长任务模式（会话 meta.longTask）建议设 0 或一个很大的值。
   */
  interactiveTimeoutMs?: number
  /**
   * T93 P3 单会话 token 预算（输入 + 输出累计），0 = 不限。
   *
   * 为什么需要它：`meta.usage` 记得很全（输入/输出/缓存/轮数/步数），`/api/usage` 也能看，
   * 但**从来不强制**——长任务跑飞了没有刹车，用户是看到账单才知道。
   *
   * 超限时的行为：
   *   - 回合开始前超限 → 直接拒绝（不花一分钱），并说清当前用量与该怎么办
   *   - 回合内超限 → 走既有的「停止」路径落库（保住已流出的正文与步骤），不新增错误分支
   * 默认 0：交互场景用户自己能停，不该替他决定；要无人值守长任务时显式设一个值。
   */
  sessionTokenBudget?: number
  /**
   * T93 B2 撤销快照**落盘**。默认全关——它要把**改前的完整文件内容**复制进 `~/.yyagent/`，
   * 这是和 bgTasks 落盘不同量级的代价（那个只有元数据）。要用的用户显式打开，
   * 打开前应该知道自己同意了什么。
   *
   * 单文件上限不在这里——采集侧的 `MAX_SNAPSHOT_BYTES` 就是它（进程安全线，
   * 不该有第二个来源）。这里只管「落盘这一层」的策略。
   */
  undo?: {
    /** 快照落盘开关。false = 维持纯内存行为（重启后不可撤销，与今天完全一致） */
    persist?: boolean
    /** 单轮落盘总字节上限，超过就只落前几个，其余记 skippedOnDisk */
    maxTurnBytes?: number
    /** 快照目录总预算，超出按最旧优先淘汰 */
    maxTotalBytes?: number
    /** 快照保留天数 */
    keepDays?: number
  }
  /**
   * T93 P3 子代理（delegate）的步数上限。原来硬编码 30，而主代理是 `maxSteps ?? 50`——
   * 子任务更容易被截断，且截断后**静默**返回，主代理分不清它是做不完还是做错了。
   * 默认仍 30（不改变现状）；给独立字段而不是复用 maxSteps：子任务是有界聚焦的活，
   * 预算和主代理不是同一个概念。用满时 delegate 会在返回里明确标注截断。
   */
  subagentMaxSteps?: number
  /** T111：会话归档天数——超过 N 天未活动的会话在网关启动时移入 sessions/archive/（不删除，0/未配=关闭） */
  sessionArchiveDays?: number
  /** T119：全局并发上限——同时跑的 agent 回合数（交互+定时任务合计），超出排队等待。默认 2，0 = 不限 */
  maxConcurrentRuns?: number
  /**
   * T129：每模型的推理档位映射。key = "provider/modelId"（如 "stepfun/step-3.7-flash"），
   * value = "low" | "medium" | "high"。设置页的全局 reasoningEffort 做兜底，
   * 此映射优先（模型选择器悬停卡片写入）。未配置的模型走服务端默认。
   */
  modelReasoning?: Record<string, string>
  /**
   * T117：主对话推理档位（reasoning_effort，如 low/medium/high）——**未配 = 服务端默认，不透传**。
   * 内部单一职责调用已经固定 low（internalProviderOptions）；这里只影响主对话：
   * 调低换响应速度（reasoning 模型每步思考 10s+），深度会打折，谨慎设置。
   */
  reasoningEffort?: string
  /** T30 收敛时限（毫秒）：单个 run 连续运转超过此时长，引擎强制停轮并引导模型进入验证与收尾，默认 180000（3 分钟） */
  convergeTimeoutMs?: number
  permission?: "confirm-all" | "danger-confirm" | "full-auto"
  visionModel?: string
  /** T15 默认生图模型（"provider/modelId"）：imggen 优先用它调 images/generations；留空自动猜 */
  imageModel?: string
  /** P1-9 网页搜索引擎（websearch 工具用），默认 bing */
  searchEngine?: "bing" | "duckduckgo" | "baidu"
  // T93：长任务模式开关已挪到会话 meta（SessionMeta.longTask）——原先这里的 longTask 是死配置
  // （TUI 写、没人读），真正生效的是 gateway 内存 Set，两处来源且重启即失效。合并成一份。
  /** T66 钩子：每步工具执行完后用模型检查一次输出，不通过则追加修正提示（内置安全/输出格式 + 自定义） */
  hooks?: HookConfig[]
  /**
   * T93 L1：按钩子 id 指定判定后端。缺省/未列出的钩子走 `llm`（现行为，主模型判）。
   * 可用值：
   *   - `"llm"`    主模型判（默认）
   *   - `"replay"` 回放 `~/.yyagent/hook-samples.jsonl` 里录下的判定——
   *                **A/B 框架的地基**：没有外部判定通道时也能验证框架本身
   * 认不出来的值会告警并回落 llm，绝不静默关掉检查。
   */
  hookBackend?: Record<string, string>
  /**
   * T93 L2：判定采样录制开关。开启后每次 llm 判定都会往
   * `~/.yyagent/hook-samples.jsonl` 追加一条（含判不出的空结果）——
   * 那是 replay 后端与 A/B 框架的数据源。默认关：这是诊断功能，
   * 不该让每个用户在不知情的情况下往家目录写文件。
   */
  hookRecord?: boolean
  /**
   * T93 L2：TypeSafe（Jev）判定后端的配置。`hookBackend` 把某个钩子指向 "typesafe" 时生效。
   *
   * 拿 key：https://console.typesafe.ai/keys （playground 在 /playground，免费免 key 可先试）。
   * 计费只按输入 token（$0.042/Mtok），输出免费；限流 250k tok/s · 1200 req/min。
   * **不配 apiKey 时后端返回空判定**（= 判不出），由调用方按 strict 处理，不会静默关掉检查。
   */
  typesafe?: {
    apiKey?: string
    /** 默认 jev-latest */
    model?: string
    /** 默认 https://api.typesafe.ai/v1；自建网关/代理可改 */
    baseUrl?: string
    timeoutMs?: number
    /** noul ≥ 该值判 FAIL，默认 0.5 */
    threshold?: number
  }
  /** T68 个人化设置服务端化：theme/font/rail/hotkeys/侧栏折叠与宽度等——跨入口(Electron/浏览器)/重启/设备共用一份，不再受 localStorage 按 origin/档案隔离之限 */
  ui?: Record<string, string>
  /** T79 模型自动降级：思考失败/不可重试错误（鉴权/欠费/404 等）时换这个模型整体重试一次；留空不降级。建议配一个不同服务商的稳定模型 */
  fallbackModel?: string
  /** T80 局域网配对 token：非本机访问 /api/* 必须携带（首次启动自动生成）；本机请求永远放行 */
  authToken?: string
  /** T83 自动备份：定期把 ~/.yyagent（会话/记忆/配置/账本）压缩到 backups/，滚动保留 N 份 */
  backup?: { enabled?: boolean; keep?: number; intervalHours?: number }
  /** T88 沙箱执行：bash 命令默认在 Docker 容器内跑（Linux bash，工作区挂载 /workspace）；enabled 默认关，image 缺省 node:22-bookworm；未检测到 Docker 自动回退本机 */
  sandbox?: { enabled?: boolean; image?: string }
  /** T84 项目级命令白名单：key=归一化 cwd，value=允许的命令前缀（如 ["npm","git"]）——匹配则跳过确认 */
  allowlists?: Record<string, string[]>
  /** T85 完成通知：长任务/回合结束时本地 toast + 可选 webhook 推送（ntfy/Server酱，POST 正文即文本） */
  notify?: { toast?: boolean; url?: string; /** T125：只推送失败（无人值守免打扰），成功静默 */ onlyFailure?: boolean }
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
  /**
   * T90 MCP 信任名单（server 名，如 ["tabbit"]）：列出的 server 其写操作按普通操作处理（危险档下免确认），
   * 未列出的一律按危险操作处理——交互模式本会话首次调用确认一次，无人值守直接拒绝。
   * 为什么默认不信任：MCP server 是外部进程，它的写盘/浏览器点击等价于未经审查的第三方副作用。
   */
  mcpTrusted?: string[]
  /**
   * T92 MCP 单次请求超时（毫秒），默认 120000。注意 SDK 自己也有默认值，是 60000——
   * 这里放宽一倍是因为「npx 首次冷启动要下载依赖」这类 server 在 60 秒内完不成初始化。
   * 另有 30 分钟的总时长硬上限（见 src/mcp/timeout.ts），即使服务端一直报进度也不会无限等下去。
   */
  mcpTimeoutMs?: number
  /**
   * T90 无人值守桌面操控：默认 false = 无交互时拒绝 computer 的点击/输入（危险操作不能无 TTY 放行）；
   * 定时任务确需操控桌面时显式设为 true。
   */
  computerUnattended?: boolean
  /**
   * T91 内部调用是否沿用完整基础层（默认 false = 用精简层）。
   * 压缩 / 钩子 / 识图 / 拆分器每次调用都会注入 system 提示词：完整层 18087 字符 ≈ 11k tokens，
   * 一次 PASS/FAIL 判定或一次摘要付这个钱很浪费（钩子还是每步工具一次）。设为 true 可回到旧行为。
   */
  fullBaseForInternal?: boolean
  /**
   * T92 局域网分享：默认 false = 网关只监听 127.0.0.1。
   * 设为 true 才监听 0.0.0.0，让手机/其它电脑打开 /api/file 成果链接（非本机访问 /api/* 仍需配对 token）。
   * 为什么默认关：监听 0.0.0.0 等于把端口暴露给同网段所有人，公共 Wi-Fi 下风险不必要。
   */
  lanShare?: boolean
}

const CONFIG_PATH = join(homedir(), ".yyagent", "config.json")

let cached: YyagentConfig | null = null

export function configPath(): string {
  return CONFIG_PATH
}

/** T91：落盘前把密钥字段加密（内存始终明文，故调用方无需感知） */
function encryptInPlace(cfg: YyagentConfig): YyagentConfig {
  const out: YyagentConfig = JSON.parse(JSON.stringify(cfg)) as YyagentConfig
  for (const p of Object.values(out.providers ?? {})) {
    if (p && typeof p.apiKey === "string") p.apiKey = encryptSecret(p.apiKey)
  }
  if (out.authToken) out.authToken = encryptSecret(out.authToken)
  return out
}

/** T91：读盘后把密钥字段解密（解密失败得空串 → 该通道需重填，不影响启动） */
function decryptInPlace(cfg: YyagentConfig): YyagentConfig {
  for (const p of Object.values(cfg.providers ?? {})) {
    if (p && typeof p.apiKey === "string") p.apiKey = decryptSecret(p.apiKey)
  }
  if (cfg.authToken) cfg.authToken = decryptSecret(cfg.authToken)
  return cfg
}

/** T91：唯一的落盘出口——统一在这里加密，避免哪天多出一条绕过加密的写路径 */
function writeConfig(cfg: YyagentConfig): void {
  mkdirSync(join(CONFIG_PATH, ".."), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(encryptInPlace(cfg), null, 2))
}

/**
 * T91 一次性迁移：把历史明文 key 就地加密（config.json + config.json.bak-* 明文副本）。
 * 幂等——判据是**磁盘原文**而不是内存对象（内存里永远是解密后的明文，拿它判断会每次启动都重写）。
 * 用户手写明文 key 也照样能用，下次保存时自动加密。
 */
let migrated = false
export function migratePlaintextSecrets(): { encrypted: boolean; backups: string[] } {
  if (migrated) return { encrypted: false, backups: [] }
  migrated = true
  let encrypted = false
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8")
    if (/"(apiKey|authToken)"\s*:\s*"(?!enc:|REPLACE_ME")/.test(raw)) {
      writeConfig(loadConfig())
      // 复核落盘结果：加密失败时 encryptSecret 会原样返回明文，不能只看「写过」就当成功
      encrypted = /"(apiKey|authToken)"\s*:\s*"enc:/.test(readFileSync(CONFIG_PATH, "utf8"))
      if (!encrypted) console.error("[密钥保护] 迁移未生效——主密钥不可用，密钥仍以明文落盘，请检查 ~/.yyagent/.master.key")
    }
  } catch {
    /* 首次运行还没有配置文件 */
  }
  const backups = redactLegacyBackupKeys(dirname(CONFIG_PATH))
  if (encrypted || backups.length) {
    console.error(`[密钥保护] 已加密落盘${backups.length ? `，并处理历史明文备份 ${backups.length} 个：${backups.join(", ")}` : ""}`)
  }
  return { encrypted, backups }
}

/**
 * 清掉 loadConfig 的进程内缓存。
 * 存在的理由：配置文件可能在进程运行期间被改（设置页、`/api/config`、测试与探针换配置），
 * 而 `cached` 是模块级变量——不清就永远读第一份。与 `hooks.ts` 的 `resetHookJudges()` 同一用意。
 */
export function resetConfigCache(): void {
  cached = null
}

/**
 * T115：内部单一职责调用的推理档位。reasoning 模型的思考在「一次调用一个判定」的场景
 * （钩子判定 / 压缩摘要 / 识图转述 / 任务拆分）是纯延迟 + token 开销——实测每次内部调用
 * 的 reasoning 输出上百 token、延迟翻倍。low 档保判定可用（L2 一致率不塌方验证后接入）；
 * **主对话永远保持服务端默认档**，不设限。key 必须与 createOpenAICompatible 的 name 一致
 * （providerOptions 按它路由到请求体）。
 */
export function internalProviderOptions(providerName: string): Record<string, { reasoningEffort: string }> {
  return { [providerName]: { reasoningEffort: "low" } }
}

export function loadConfig(): YyagentConfig {
  if (cached) return cached
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(join(CONFIG_PATH, ".."), { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify({ providers: {}, model: "" }, null, 2))
  }
  cached = decryptInPlace(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as YyagentConfig)
  // T66 内置钩子种子：首次加载或手动删过时补回（builtin 钩子保证至少存在于配置中，开关可控）
  const builtinIds = new Set((cached.hooks ?? []).map((h) => h.id))
  const missing = BUILTIN_HOOKS.filter((b) => !builtinIds.has(b.id))
  if (missing.length) {
    cached.hooks = [...(cached.hooks ?? []), ...missing]
    writeConfig(cached)
  }
  // T91：历史明文密钥迁移（幂等，只在真的有明文时写盘）
  migratePlaintextSecrets()
  return cached
}

export function saveConfig(config: YyagentConfig): void {
  cached = config
  writeConfig(config)
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
