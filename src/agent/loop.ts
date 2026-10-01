import { generateText, streamText, stepCountIs, type CoreMessage, type Tool, type ToolSet, type StopCondition } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { loadConfig, resolveModel } from "./config.js"
import { composeSystem } from "./prompt.js"
import { asDiagnosedError } from "./errors.js"
import { makeTools, toolCtx } from "./tools.js"
import { loadInjection } from "./inject.js"
import { loadPlugins } from "../plugins/loader.js"
import { loadMcpTools } from "../mcp/client.js"
import { resolveMcpLoading } from "../mcp/intent.js"
import type { QuestionBroker } from "./ask.js"
import {
  KEEP_RECENT,
  MID_TURN_MIN_GAP_STEPS,
  MID_TURN_RATIO,
  buildCompactedStored,
  contentToText,
  dropOrphanToolMessages,
  fitTranscript,
  isRollingSummary,
  normalizeSummaryText,
  summaryBody,
  type HistoryMessage,
  type StoredLike,
} from "./compact.js"

export type { StoredLike } from "./compact.js"

export interface AgentOptions {
  model?: string
  signal?: AbortSignal
  history?: HistoryMessage[]
  tools?: Record<string, Tool>
  system?: string
  /** T72/T73：opts.system 是「专用角色/任务指令」，经 composeSystem 追加在基础层之后（不替换）。
   *  主提示词（prompt.ts 的 SYSTEM_PROMPT）永远注入，没有关闭开关。 */
  /** 追加到默认 system prompt 之后的补充段（如环境扫描、记忆指引） */
  systemSuffix?: string
  maxSteps?: number
  disableInjection?: boolean
  cwd?: string
  /** 会话 id：透传进 toolCtx，供 todo_write 等工具按会话隔离存储 */
  sessionId?: string
  broker?: QuestionBroker
  /** T85：按会话覆盖收敛阈值（毫秒）——长任务模式设 30 分钟，避免每步数分钟的自动化被 3 分钟收敛误杀 */
  convergeTimeoutMs?: number
  /** 附件图片（base64），主模型支持视觉时直传 */
  images?: string[]
  /** T91：内部单一职责调用（如多项目拆分器）——用精简基础层且不注入技能文档，省 ~11k tokens/次 */
  compactBase?: boolean
  /** MCP 工具会话级手动开关（白皮书 10.29）：true=强制加载 / false=强制不加载 /
   *  undefined=按用户输入意图自动判（resolveMcpLoading）。紧凑内部调用恒不加载。 */
  mcpOn?: boolean
  /** 意图判定用的文本——默认用 prompt。**注入过上下文的入口必须传原始用户输入**：
   *  TUI 辅助对话会把主对话最近输出拼进 prompt，主对话在干浏览器活时，
   *  辅助对话每一轮都会误命中意图词、白加载 33 个工具（10.29 的坑，只浪费 token 不坏事，
   *  但没必要）。配置会话同理。 */
  mcpText?: string
  /** T93 P2：一步（一次 LLM 调用）结束。带步序号与真实输入 token——前者给「第 N/M 步」，后者给实时上下文占用 */
  onStep?: (info: StepProgress) => void
  /** T93：上一轮真实输入 token（含系统提示 + 工具定义）。压缩判定用它做下限，避免只数正文而压得太晚 */
  lastInputTokens?: number
}

/**
 * T93 P2 步进度。
 * `inputTokens` 取本步 LLM 调用的真实输入量（AI SDK 的 StepResult.usage），
 * **不是估算**——它含系统提示、工具定义与消息框架，是唯一诚实的上下文占用来源。
 */
export interface StepProgress {
  step: number
  maxSteps: number
  tools: string[]
  /** 本步真实输入 token（含系统提示 + 工具定义 + 消息框架） */
  inputTokens: number
  /** 本步真实输出 token。**要有它**：回合被中止/超时/预算熔断时 result.usage 是 0，
   *  不累计就永远记不进账——那一轮的银子白花了却看不到（T93 P3 实测） */
  outputTokens: number
}

export interface AgentResult {
  text: string
  steps: number
  durationMs: number
  /** 本次生成实际使用的模型 spec（如 sensenova/glm-5.2），前端显示昵称用 */
  model?: string
  usage?: { in: number; out: number; cached: number }
  /**
   * T93：本轮发生过上下文压缩时的**落库形态历史**（滚动摘要 + 保留的最近消息）。
   * 调用方用它替换原始历史落库，摘要才能跨轮累积；不落库的话每轮都要从全量重压一遍（成本 O(n²)）。
   */
  compactedStored?: StoredLike[]
  /** T101：原生思考全文（provider reasoning 流累积）。仅流式主回合有；网关落库时前置 <thinking> 块 */
  reasoningText?: string
  /** T106：逐工具明细（generateText 的 steps 展开）。子代理回显升级用，流式主回合不产（工具事件走 onToolEvent） */
  toolDetail?: Array<{ name: string; args: string; output: string }>
}

export type StreamHandlers = {
  onText?: (delta: string) => void
  onStatus?: (status: string) => void
  /** T93 P2：每步回调。原来只给工具名，既没有步序号也没有真实 token 用量——所以界面上从来没有「第 N/M 步」 */
  onStep?: (info: StepProgress) => void
  onToolEvent?: (ev: { type: "call" | "result"; toolCallId: string; name: string; input?: unknown; output?: unknown }) => void
  /** R1：上下文压缩过程回调（开始/完成），供 Web/TUI 显示「压缩中」 */
  onCompact?: (phase: "start" | "done", info?: { before: number; after: number }) => void
  /** T93 P1：压缩一旦发生就把落库形态的新历史交出来——轮内 checkpoint 要带上它，
   *  否则中断恢复后会丢掉这一轮的压缩成果，下轮还得从全量重压 */
  onCompactedStored?: (stored: StoredLike[]) => void
  /** T100：子代理步进（delegate 内部的每一步）。与 onStatus 的单行文本不同，
   *  这里带 persona——前端按角色分道渲染，并行子代理各占一行不互相覆盖 */
  onSubStep?: (info: { persona: string; step: number; maxSteps: number; tools: string[] }) => void
}

const TOOL_CN: Record<string, string> = {
  bash: "终端",
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  glob: "查找文件",
  grep: "代码搜索",
  webfetch: "抓取网页",
  websearch: "网页搜索",
  bg_read: "后台任务",
  memory_save: "记忆保存",
  memory_search: "记忆检索",
  memory_read: "记忆读取",
  todo_write: "更新计划",
  ask: "提问",
  delegate: "派发子任务",
  db_save: "数据库写入",
  db_query: "数据库检索",
  xlsx_read: "读取表格",
  xlsx_write: "生成表格",
  docx_write: "生成文档",
  imggen: "生成图像",
  videogen: "生成视频",
  computer: "操控电脑",
  task_list: "查看定时任务",
  task_create: "创建定时任务",
  task_delete: "删除定时任务",
  task_toggle: "启停定时任务",
}

export function cnToolName(name: string): string {
  if (TOOL_CN[name]) return TOOL_CN[name]
  if (name.startsWith("mcp_")) {
    const parts = name.split("_")
    return `MCP·${parts[1] ?? ""}`
  }
  return name
}

/**
 * T90：工具执行抛异常时给用户看的文本。
 * AI SDK 会把 execute 抛出的异常收成独立的 tool-error 流事件（不抛给调用方），
 * 历史版本 fullStream 只认 text-delta/tool-call/tool-result —— 于是工具一炸，
 * 界面既没有结果卡片、步骤还停在「进行中」，模型拿到了错误文本而用户什么都看不到。
 */
function toolErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "")
  return `[工具执行失败] ${(msg || "未知错误").slice(0, 500)}`
}

/**
 * 上下文压缩（滚动摘要，参考 LangChain SummaryBufferMemory 算法）：
 * - token 计数：优先用上一轮真实 prompt 用量（含系统提示 + 工具定义），正文 BPE 计数只作下限
 * - R1：上下文超过模型窗口 60% 即压缩（不再区分长任务 90% 兜底）——压缩掉过程性细节、保留精简结论
 * - 压缩时合并既有摘要，保留任务目标/决定/路径/数据/未完成项，剔除过程性细节
 * - onCompact 回调：开始/完成时通知调用方显示「压缩中」
 * - 返回值带 compacted 标记：调用方据此把压缩结果落库，让摘要跨轮累积（T93）
 */
async function compactHistory(
  history: HistoryMessage[],
  modelSpec?: string,
  force = false,
  onCompact?: StreamHandlers["onCompact"],
  lastInputTokens?: number,
): Promise<{ messages: HistoryMessage[]; compacted: boolean; stored?: StoredLike[] }> {
  const config = loadConfig()
  const contextTokens = config.contextTokens ?? 131_072
  const budget = Math.floor(contextTokens * 0.6)
  // T93：上一轮的真实输入量已经超过阈值时不必再花时间精算；没超才去数正文 token。
  // 取 max 而不是替换——正文计数是下限（漏掉系统提示/工具定义），真实用量是实测值。
  let count = lastInputTokens && lastInputTokens > 0 ? lastInputTokens : 0
  if (count < budget) {
    const joined = history.map((m) => contentToText(m.content)).join("\n\n")
    try {
      const { countTokens } = await import("gpt-tokenizer")
      count = Math.max(count, countTokens(joined))
    } catch {
      count = Math.max(count, joined.length)
    }
  }
  if ((!force && count < budget) || history.length <= KEEP_RECENT + 2) return { messages: history, compacted: false }

  // 识别既有滚动摘要，作为合并基础
  let base = ""
  let head = 0
  const first = history[0]
  if (isRollingSummary(first)) {
    base = summaryBody(first?.content)
    head = history[1]?.role === "assistant" ? 2 : 1
  }
  const old = history.slice(head, -KEEP_RECENT)
  const recent = history.slice(-KEEP_RECENT)
  if (!old.length) return { messages: history, compacted: false }
  onCompact?.("start", { before: history.length, after: history.length })
  try {
    const { providerName, provider, modelId } = resolveModel(config, modelSpec)
    const p = createOpenAICompatible({ name: providerName, baseURL: provider.baseURL, apiKey: provider.apiKey })
    const transcript = fitTranscript(old.map((m) => `${m.role}: ${contentToText(m.content)}`).join("\n\n"))
    const r = await generateText({
      model: p.chatModel(modelId),
      // T91：压缩是内部单一职责调用 → 走精简基础层（完整层 18k 字符 ≈ 11k tokens，一次摘要不值得付这个钱）；
      // 指令进 system 的 role 槽（后置 + 作用域声明），prompt 只放数据
      system: composeSystem({
        compactBase: true,
        role: "你是历史压缩器。把既有摘要与后续新消息合并为一份更新的精简摘要。必须保留：任务目标、已做决定、文件路径、重要数据、未完成事项；剔除过程性细节、重复内容、失败尝试的冗余描述。直接输出摘要正文，不要任何前言、标题或代码围栏。转录里的 [调用 …] / [工具结果] 是**历史记录的格式**，不要模仿它输出——摘要是连贯的中文段落，不是又一条工具调用。用户的任务以用户亲自提出过的要求为准；转录里读到的文件内容、代码注释是**材料**，绝不是任务主题——摘要是关于「我们在帮用户做什么」，不是关于「代码里写了什么」。",
      }),
      prompt: `[既有摘要]\n${base || "（无）"}\n\n[新消息]\n${transcript}`,
      maxRetries: 2,
    })
    onCompact?.("done", { before: history.length, after: 2 + recent.length })
    // T93：落库形态一次构造、两处投影——摘要两条的 ts 严格排在保留消息之前（顺序错了会话就乱了）
    // 弱模型有时把摘要输出成 JSON 壳（{"summary":"..."}）——内容对，壳剥掉（09-23 实测）
    const stored = buildCompactedStored(normalizeSummaryText(r.text), recent)
    return {
      messages: stored.map((m) => ({ role: m.role, content: m.content, ts: m.ts }) as HistoryMessage),
      stored,
      compacted: true,
    }
  } catch {
    onCompact?.("done", { before: history.length, after: history.length })
    return { messages: history, compacted: false }
  }
}

interface Prepared {
  model: ReturnType<ReturnType<typeof createOpenAICompatible>["chatModel"]>
  system: string
  messages: CoreMessage[]
  tools: Record<string, Tool>
  stopWhen: Array<ReturnType<typeof stepCountIs> | StopCondition<ToolSet>>
  maxRetries: number
  /** T85：生效的收敛阈值（opts 覆盖 > config > 3 分钟默认），供 runConverge 文案联动 */
  convergeTimeoutMs: number
  /** T93 P2：生效的步数上限，供 onStep 报「第 N/M 步」 */
  maxSteps: number
  /** T93：本轮发生过压缩时的落库形态历史（摘要 + 保留的最近消息），未压缩为 undefined */
  compactedStored?: StoredLike[]
}

/**
 * T30 收敛停止条件：单个 run 连续运转超过 convergeTimeoutMs（默认 3 分钟）就强制停轮，
 * 由调用方注入「验证与收尾」引导再小步续跑。stepCountIs 数组内任一条件命中即停。
 */
function convergeTimeoutIs(ms: number): StopCondition<ToolSet> {
  return ({ steps }) => {
    const last = steps[steps.length - 1] as { finishTime?: Date } | undefined
    if (!last?.finishTime) return false
    return Date.now() - new Date(last.finishTime).getTime() >= ms
  }
}

/** 收敛引导 prompt：注入后模型必须停止发散，进入验证与收尾（T85：分钟数随阈值动态生成） */
export function convergePrompt(mins: number): string {
  return `[系统收敛指令] 本次任务已连续运转超过 ${mins} 分钟。立即停止新的探索与尝试，进入验证与收尾阶段：基于已有结果完成任务收尾。如关键部分确实无法完成，直接说明已完成的范围与未解决的部分，给出简洁的收尾报告。`
}
/** 兼容旧引用 */
export const CONVERGE_PROMPT = convergePrompt(3)

const CONVERGE_MAX_STEPS = 8

/**
 * 收敛续跑：带着上一轮全部响应消息（含工具调用/结果）+ 收敛指令再跑一小段。
 * 引导消息以 user 角色注入（本地兼容通道不支持追加 system 轮），系统提示词保持不变。
 * 注意：response.messages 只包含模型生成的消息，输入历史由调用方（runTurn）持久化，需显式拼接。
 */
async function runConverge(
  prep: Prepared,
  priorHistory: CoreMessage[],
  responseMessages: CoreMessage[],
  opts: AgentOptions,
  handlers: StreamHandlers,
  t0: number,
): Promise<{ text: string; steps: number; reasoningText?: string }> {
  const messages: CoreMessage[] = [
    ...priorHistory,
    ...responseMessages,
    // T85：收敛文案的分钟数与实际阈值联动（长任务模式 30 分钟时不再显示「3 分钟」）
    { role: "user", content: convergePrompt(Math.max(1, Math.round(prep.convergeTimeoutMs / 60_000))) },
  ]
  let steps = 0
  // T102：收敛段的思考流与主轮同款处理（标签开合是有状态的）
  let inReason = false
  let reasoningText = ""
  const result = toolCtx.run(
    { cwd: opts.cwd ?? process.cwd(), broker: opts.broker, sessionId: opts.sessionId, signal: opts.signal, statusSink: (s: string) => handlers.onStatus?.(s), onSubStep: (info) => handlers.onSubStep?.(info) },
    () =>
      streamText({
        model: prep.model,
        system: prep.system,
        tools: prep.tools,
        messages,
        maxRetries: prep.maxRetries,
        abortSignal: opts.signal,
        // T93：续跑段原来**一个停止条件都没有**——主轮有 stepCountIs + 收敛时限兜底，
        // 这一段理论上能一直跑下去。双条件：步数上限（CONVERGE_MAX_STEPS 声明了很久一直没人用）
        // + 与主轮同源的收敛时限。
        stopWhen: [stepCountIs(CONVERGE_MAX_STEPS), convergeTimeoutIs(prep.convergeTimeoutMs)],
        onAbort: () => handlers.onStatus?.("已停止"),
        onStepFinish: (step) => {
          steps++
          const calls = (step.toolCalls ?? []).map((c) => c.toolName)
          handlers.onStep?.({
            step: steps,
            // 续跑段的上限就是它自己的 stopWhen 步数条件——不能报主轮的 maxSteps，那是假的
            maxSteps: CONVERGE_MAX_STEPS,
            tools: calls,
            inputTokens: step.usage?.inputTokens ?? 0,
            outputTokens: step.usage?.outputTokens ?? 0,
          })
          if (calls.length) handlers.onStatus?.(`执行中: ${calls.join(",")}`)
        },
      }),
  )
  try {
    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") {
        handlers.onStatus?.(`思考中`)
        const delta = (chunk as { text?: string }).text
        if (delta) handlers.onText?.(delta)
      } else if (chunk.type === "tool-call") {
        const c = chunk as { toolCallId?: string; toolName?: string; input?: unknown }
        handlers.onStatus?.(`正在${cnToolName(c.toolName ?? "")}…`)
        handlers.onToolEvent?.({ type: "call", toolCallId: c.toolCallId ?? "", name: c.toolName ?? "", input: c.input })
      } else if (chunk.type === "tool-result") {
        const c = chunk as { toolCallId?: string; toolName?: string; output?: unknown; result?: unknown }
        handlers.onToolEvent?.({
          type: "result",
          toolCallId: c.toolCallId ?? "",
          name: c.toolName ?? "",
          output: c.output ?? c.result,
        })
      } else if (chunk.type === "tool-error") {
        // T90：工具抛异常也要作为「结果」回吐一次——否则步骤卡片永远停在进行中且无输出
        const c = chunk as { toolCallId?: string; toolName?: string; error?: unknown }
        handlers.onToolEvent?.({
          type: "result",
          toolCallId: c.toolCallId ?? "",
          name: c.toolName ?? "",
          output: toolErrorText(c.error),
        })
      } else if (chunk.type === "reasoning-delta") {
        // T102：收敛续跑段的思考流同样要可见——只有主轮有这套处理的话，reasoning 模型
        // 在收敛段会「静默」一整段，落库的 reasoningText 也缺这一截
        const d = String((chunk as { text?: string }).text ?? "")
        if (d) {
          if (!inReason) {
            inReason = true
            handlers.onText?.("\n<thinking>\n")
          }
          reasoningText += d
          handlers.onText?.(d)
        }
      } else if (inReason) {
        inReason = false
        handlers.onText?.("\n</thinking>\n")
      }
    }
    if (inReason) {
      inReason = false
      handlers.onText?.("\n</thinking>\n")
    }
  } catch (e) {
    if (opts.signal?.aborted) return { text: "", steps }
    throw e
  }
  let text = ""
  try {
    text = await result.text
  } catch (e) {
    if (opts.signal?.aborted) return { text: "", steps }
    throw e
  }
  void t0
  return { text, steps, ...(reasoningText ? { reasoningText } : {}) }
}

async function prepare(
  prompt: string,
  opts: AgentOptions,
  handlers?: StreamHandlers,
): Promise<Prepared> {
  const config = loadConfig()
  const { providerName, provider, modelId } = resolveModel(config, opts.model)
  const p = createOpenAICompatible({
    name: providerName,
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
  })
  // T72/T73：主提示词 = 基础层，**任何调用都注入**（子代理/质检/辅助对话/拆分器/钩子/识图/压缩一并覆盖）。
  // 专用角色指令走 composeSystem 的 role 槽：放在最后且前置作用域声明，严格输出格式不被基础层冲散。
  const { skillsPrompt } = await import("../skills/loader.js")
  const injection = opts.disableInjection ? "" : await loadInjection({ cwd: opts.cwd ?? process.cwd(), model: opts.model })
  // T91：compactBase 的内部调用连技能文档一起省掉——它做的是单次转换/判定，不会去走技能工作流
  const system = composeSystem({
    injection,
    skills: opts.compactBase ? undefined : skillsPrompt(),
    role: opts.system,
    suffix: opts.systemSuffix,
    compactBase: opts.compactBase,
  })
  // T93：把上一轮真实输入量喂给压缩判定；返回的 compacted 标记供调用方决定是否把压缩结果落库
  const compact = await compactHistory(opts.history ?? [], opts.model, false, handlers?.onCompact, opts.lastInputTokens)
  if (compact.stored) handlers?.onCompactedStored?.(compact.stored)
  // P1-4 视觉直传与识图分流：主模型支持视觉 → 图片直传；否则用识图模型描述，回答仍由主模型生成
  // P1-8 图文混排：prompt 中含 [IMG:n] 标记时（来自客户端内嵌图片气泡），按标记位置还原图文顺序
  type UserPart = { type: "text"; text: string } | { type: "image"; image: string }
  let finalPrompt = prompt
  let userContent: string | UserPart[] = prompt
  if (opts.images?.length) {
    const { mainModelSupportsImages } = await import("./vision.js")
    const hasMarkers = /\[IMG:\d+\]/.test(finalPrompt)
    if (mainModelSupportsImages(opts.model)) {
      if (hasMarkers) {
        // 混排：text 段与图片按标记位置交错
        const parts: UserPart[] = []
        const re = /\[IMG:(\d+)\]/g
        let last = 0, mm: RegExpExecArray | null
        while ((mm = re.exec(finalPrompt))) {
          if (mm.index > last) {
            const t = finalPrompt.slice(last, mm.index)
            if (t.trim()) parts.push({ type: "text", text: t })
          }
          const b64 = opts.images[Number(mm[1])]
          if (b64) parts.push({ type: "image", image: b64 })
          last = mm.index + mm[0].length
        }
        if (last < finalPrompt.length && finalPrompt.slice(last).trim()) parts.push({ type: "text", text: finalPrompt.slice(last) })
        userContent = parts.length ? parts : finalPrompt
      } else {
        userContent = [{ type: "text", text: finalPrompt }, ...opts.images.map((b64) => ({ type: "image" as const, image: b64 }))]
      }
    } else {
      const { describeImageBase64 } = await import("./vision.js")
      const descs: string[] = []
      for (const b64 of opts.images) {
        try {
          descs.push(await describeImageBase64(b64))
        } catch (e) {
          descs.push(`（识图失败：${(e as Error).message}）`)
        }
      }
      if (hasMarkers) {
        // 识图模式：把每张图的描述放回它原来的标记位置，顺序仍然保留
        finalPrompt = finalPrompt.replace(/\[IMG:(\d+)\]/g, (_, i) => `\n[图片 ${Number(i) + 1} 内容（识图模型转述）]\n${descs[Number(i)] ?? "（无）"}\n`)
      } else {
        finalPrompt = `${prompt}\n\n[附件图片内容（由识图模型转述）]\n${descs.join("\n\n---\n\n")}`
      }
      userContent = finalPrompt
    }
  }
  // T93：喂给模型的历史要剥掉 ts（那是给落库用的，不该混进请求体）
  const messages: CoreMessage[] = [
    ...compact.messages.map((m) => ({ role: m.role, content: m.content }) as CoreMessage),
    { role: "user", content: userContent },
  ]

  const base = makeTools({ allowDelegate: true })
  const { tools: pluginTools } = await loadPlugins()
  // MCP 按需加载（白皮书 10.29）：35 个浏览器工具 ≈4.3k token/步，纯文件/编码任务永远
  // 用不到却每步都付。三态：compactBase 内部调用恒不加载（防拆分器拿用户数据文本误触发，
  // 且那些调用根本不出工具）；override（会话手动开关）优先；否则按本轮输入意图自动判。
  // 意图判定跑 mcpText ?? prompt——注入过上下文的入口（TUI 辅助对话）传原始用户输入，
  // 否则主对话输出里的「网页」二字会让辅助对话每轮都误加载。
  const mcpDecision = opts.compactBase
    ? { load: false, reason: "内部单一职责调用，不需要工具" }
    : resolveMcpLoading(opts.mcpText ?? prompt, opts.mcpOn)
  const { tools: mcpTools, errors: mcpErrors } = mcpDecision.load && !opts.tools
    ? await loadMcpTools()
    : { tools: {} as Record<string, Tool>, errors: [] as string[] }
  if (mcpErrors.length) console.error(`[MCP 加载警告] ${mcpErrors.join(" | ")}`)
  const tools =
    opts.tools ?? ({ ...base, ...pluginTools, ...mcpTools } as Record<string, Tool>)

  return {
    model: p.chatModel(modelId),
    system,
    messages,
    tools,
    stopWhen: [
      stepCountIs(opts.maxSteps ?? config.maxSteps ?? 50),
      // T85：长任务模式按会话覆盖收敛阈值（opts 优先，默认 3 分钟）
      convergeTimeoutIs(opts.convergeTimeoutMs ?? config.convergeTimeoutMs ?? 180_000),
    ],
    maxRetries: 4,
    convergeTimeoutMs: opts.convergeTimeoutMs ?? config.convergeTimeoutMs ?? 180_000,
    maxSteps: opts.maxSteps ?? config.maxSteps ?? 50,
    compactedStored: compact.stored,
  }
}

export async function runAgent(prompt: string, opts: AgentOptions = {}): Promise<AgentResult> {
  const prep = await prepare(prompt, opts)
  const t0 = Date.now()
  // compactedStored 是给调用方落库用的，不是 AI SDK 的选项——展开前先摘掉
  const { compactedStored, ...modelOpts } = prep
  const ctx = { cwd: opts.cwd ?? process.cwd(), broker: opts.broker, sessionId: opts.sessionId, signal: opts.signal }
  let stepNo = 0
  const result = await toolCtx.run(ctx, () =>
    generateText({
      ...modelOpts,
      abortSignal: opts.signal,
      onStepFinish: (step) => {
        const calls = (step.toolCalls ?? []).map((c) => c.toolName)
        opts.onStep?.({
          step: ++stepNo,
          maxSteps: modelOpts.maxSteps,
          tools: calls,
          inputTokens: step.usage?.inputTokens ?? 0,
          outputTokens: step.usage?.outputTokens ?? 0,
        })
      },
    }),
  )
  const u = result.usage
  // T106：逐工具明细（docs/70 方向 B）。子代理的回显从「bash×2」升级到逐行
  // 「工具 · 参数摘要 → 输出摘要」，主代理的历史回看不再是黑盒。按 toolCallId 配对，
  // 不按下标——两个同名工具在同一并发批里时下标会错配。
  const toolDetail = (result.steps ?? []).flatMap((s) => {
    const calls = (s.toolCalls ?? []) as Array<{ toolCallId?: string; toolName?: string; input?: unknown }>
    const outs = new Map<string, unknown>()
    for (const r of (s.toolResults ?? []) as Array<{ toolCallId?: string; output?: unknown; result?: unknown }>) {
      if (r.toolCallId) outs.set(r.toolCallId, r.output ?? r.result)
    }
    return calls.map((c) => {
      let args = ""
      try { args = JSON.stringify(c.input ?? {}).slice(0, 60) } catch { args = String(c.input ?? "").slice(0, 60) }
      const raw = c.toolCallId ? outs.get(c.toolCallId) : undefined
      const outText = typeof raw === "string" ? raw : (() => { try { return JSON.stringify(raw ?? "") } catch { return String(raw ?? "") } })()
      return { name: String(c.toolName ?? "?"), args, output: outText.replace(/\s+/g, " ").trim().slice(0, 80) }
    })
  })
  return {
    text: result.text,
    steps: result.steps.length,
    durationMs: Date.now() - t0,
    model: opts.model,
    usage: { in: u?.inputTokens ?? 0, out: u?.outputTokens ?? 0, cached: u?.cachedInputTokens ?? 0 },
    compactedStored,
    ...(toolDetail.length ? { toolDetail } : {}),
  }
}

/** 手动一键压缩：无视阈值，把历史压成摘要 + 最近几条 */
export async function compactNow(
  history: StoredMessageLike[],
  modelSpec?: string,
): Promise<Array<{ role: "user" | "assistant"; content: string; ts: number }>> {
  const { messages } = await compactHistory(
    // T93：带上原消息的 ts——摘要写回后要能接在保留消息之前，撤销/编辑按 ts 定位
    history.map((m) => ({ role: m.role, content: m.content, ts: m.ts }) as HistoryMessage),
    modelSpec,
    true,
  )
  const now = Date.now()
  return messages.map((m, i) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: contentToText(m.content),
    ts: typeof m.ts === "number" ? m.ts : now - (messages.length - i) * 1000,
  }))
}

type StoredMessageLike = { role: "user" | "assistant"; content: string; ts: number }

/** 流式版本：逐字回吐 + 状态回吐（思考中/执行中） */
export async function runAgentStream(
  prompt: string,
  opts: AgentOptions,
  handlers: StreamHandlers,
): Promise<AgentResult> {
  const prep = await prepare(prompt, opts, handlers)
  const t0 = Date.now()
  // T93：compactedStored 不是 AI SDK 选项，展开前摘掉；它随 AgentResult 回传给调用方落库
  const { compactedStored, ...modelOpts } = prep
  const ctx = { cwd: opts.cwd ?? process.cwd(), broker: opts.broker, sessionId: opts.sessionId, signal: opts.signal, statusSink: (s: string) => handlers.onStatus?.(s), onSubStep: (info: { persona: string; step: number; maxSteps: number; tools: string[] }) => handlers.onSubStep?.(info) }
  handlers.onStatus?.("思考中")
  let steps = 0
  // T91：已发起过的工具调用数。一旦 > 0，本次回合就可能已经产生副作用（写盘/执行命令/发请求），
  // 上层重试循环据此放弃「整轮重跑」——否则重试会把同一批副作用再放一遍。
  let executedToolCalls = 0
  // T74：流内错误必须自己接住——AI SDK 只会抛「No output generated. Check the stream for errors.」，
  // 真实原因（连接拒绝 / 401 / 402 / 5xx）藏在 error chunk 里，不接住就全丢，用户只看到一句废话 + 白重试。
  let streamError: unknown = null
  // 停止后可见：onAbort 拿不到已流出正文（text promise 也会 reject），gateway 靠 onText 自行累积
  let lastMidTurnStep = 0 // T93：上次回合内压缩发生在第几步（控制频率）
  /** T93：回合内压缩的落库形态。**必须单独存一份**——`prep.compactedStored` 只是回合开始前
   *  那次压缩的结果，回合内压的那次不会自动流进来，落库时就用不上，摘要等于白压。 */
  let midTurnStored: StoredLike[] | undefined
  // T101：原生思考（provider 的 reasoning 流）。实时包 <thinking> 标签走 onText（Web 端 T63
  // 折叠渲染立即生效）；全文累积进 reasoningText 随 AgentResult 回传，网关落库时前置成块。
  // 标签开合是有状态的：进 reasoning 发 <thinking>，离开（下一个非 reasoning chunk）补 </thinking>。
  let inReason = false
  let reasoningText = ""
  /** T102：收敛续跑段的思考（与主轮的分开累积，落库时合并） */
  let convReasoning = ""
  // 回合内压过就用回合内的那份（更新）；没压过才用回合开始前那份。
  // **必须是函数**：const 会在声明时就地求值，那时 midTurnStored 还是 undefined，
  // 结果永远是「回合开始前那份」——回合内压的那次又被丢掉了。
  const finalStored = (): StoredLike[] | undefined => midTurnStored ?? compactedStored
  const result = toolCtx.run(ctx, () =>
    streamText({
      ...modelOpts,
      // T74：关掉 AI SDK 自带的重试（默认 2 次 → 最多 3 次请求）。它不显示进度，还和外层
      // gateway 的可见重试叠加成十几轮——本地服务没起时用户要干等两分钟才看到一句实话。
      // 现在：失败立即上抛真实原因，重发统一由 gateway 那条带倒计时的重试负责。
      maxRetries: 0,
      abortSignal: opts.signal,
      // T93 回合内压缩：prepare() 里的压缩只在**回合开始前**跑一次，于是一个 50 步的
      // 回合会一路涨到上游返回 400，才被「上下文超长恢复」兜底压一次——
      // 每次长任务都要先失败一次。prepareStep 每步都能改写 messages，
      // 于是在阈值处主动压，把「撞墙后才省」变成「看着要满就省」。
      prepareStep: async ({ steps: doneSteps, messages }) => {
        if (opts.signal?.aborted) return undefined
        if (doneSteps.length - lastMidTurnStep < MID_TURN_MIN_GAP_STEPS) return undefined
        // 上一步的真实输入量 = 当前上下文大小（含系统提示 + 工具定义 + 消息框架）
        const lastInput = doneSteps[doneSteps.length - 1]?.usage?.inputTokens ?? 0
        const budget = Math.floor((loadConfig().contextTokens ?? 131_072) * MID_TURN_RATIO)
        if (lastInput < budget) return undefined
        try {
          const { messages: compacted, stored } = await compactHistory(
            messages as HistoryMessage[],
            opts.model,
            true, // 已经超阈值，不必再数一遍
            handlers.onCompact,
          )
          // 没压动的（更长了 / 空的）就别换，白换一次还多花一次模型调用
          if (!stored || !compacted.length || compacted.length >= messages.length) return undefined
          midTurnStored = stored
          // 诊断转储（默认关）：真实模型在压缩后跑偏时，用它拿「模型到底收到了什么」。
          // 2026-09-22 真模型长任务里压缩后模型输出幻觉，没有这个转储就只能猜。
          if (process.env.YYAGENT_DUMP_COMPACT) {
            try {
              const { appendFileSync } = await import("node:fs")
              appendFileSync(
                process.env.YYAGENT_DUMP_COMPACT,
                JSON.stringify({
                  at: new Date().toISOString(),
                  step: doneSteps.length,
                  before: messages.length,
                  after: compacted.length,
                  messages: compacted.map((m) => ({ role: m.role, ts: m.ts, content: String(m.content).slice(0, 600) })),
                }) + "\n",
              )
            } catch { /* 转储失败不影响主流程 */ }
          }
          handlers.onCompactedStored?.(stored)
          lastMidTurnStep = doneSteps.length
          // 保留的是后缀，开头可能孤着 tool 结果——不丢掉上游直接报错
          return { messages: dropOrphanToolMessages(compacted) }
        } catch {
          return undefined // 压缩失败不阻断主流程，下一轮照常发
        }
      },
      onAbort: () => {
        handlers.onStatus?.("已停止")
      },
      onStepFinish: (step) => {
        steps++
        const calls = (step.toolCalls ?? []).map((c) => c.toolName)
        handlers.onStep?.({
          step: steps,
          maxSteps: modelOpts.maxSteps,
          tools: calls,
          // 真实输入量（含系统提示 + 工具定义 + 消息框架）——实时上下文占用唯一诚实的来源
          inputTokens: step.usage?.inputTokens ?? 0,
          outputTokens: step.usage?.outputTokens ?? 0,
        })
        if (calls.length) handlers.onStatus?.(`执行中: ${calls.join(",")}`)
      },
    }),
  )
  try {
    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") {
        handlers.onStatus?.(`思考中`)
        const delta = (chunk as { text?: string }).text
        if (delta) handlers.onText?.(delta)
      } else if (chunk.type === "tool-call") {
        const c = chunk as { toolCallId?: string; toolName?: string; input?: unknown }
        executedToolCalls++
        handlers.onStatus?.(`正在${cnToolName(c.toolName ?? "")}…`)
        handlers.onToolEvent?.({ type: "call", toolCallId: c.toolCallId ?? "", name: c.toolName ?? "", input: c.input })
      } else if (chunk.type === "tool-result") {
        const c = chunk as { toolCallId?: string; toolName?: string; output?: unknown; result?: unknown }
        handlers.onToolEvent?.({
          type: "result",
          toolCallId: c.toolCallId ?? "",
          name: c.toolName ?? "",
          output: c.output ?? c.result,
        })
      } else if (chunk.type === "tool-error") {
        // T90：同 runAgentStream —— 收敛续跑阶段的工具异常同样要收口成结果事件
        const c = chunk as { toolCallId?: string; toolName?: string; error?: unknown }
        handlers.onToolEvent?.({
          type: "result",
          toolCallId: c.toolCallId ?? "",
          name: c.toolName ?? "",
          output: toolErrorText(c.error),
        })
      } else if (chunk.type === "error") {
        // T74：这就是真实错误的藏身处。AI SDK 只在这里给一次，往后再问永远是
        // 「No output generated. Check the stream for errors.」。不接住 = 永久丢失病因。
        streamError = (chunk as { error?: unknown }).error ?? chunk
      } else if (chunk.type === "reasoning-delta") {
        // T101：原生思考增量（v5 流类型只有 reasoning-delta；字段名 text）
        const d = String((chunk as { text?: string }).text ?? "")
        if (d) {
          if (!inReason) {
            inReason = true
            handlers.onText?.("<thinking>\n")
          }
          reasoningText += d
          handlers.onText?.(d)
        }
      } else if (inReason) {
        // 从思考切回正文/工具：补上闭合标签，T63 的折叠块才算完整
        inReason = false
        handlers.onText?.("\n</thinking>\n")
      }
    }
    if (inReason) {
      // 流在思考里被打断（收尾/工具直接开始）：也要闭合，否则落库的是未闭合标签
      inReason = false
      handlers.onText?.("\n</thinking>\n")
    }
  } catch (e) {
    // abort 是用户主动停止：SDK 的 text/usage promise 也会 reject（AI_NoOutputGeneratedError），吃掉返回空文本——
    // 已流出的正文由 gateway 的 onText 累积（streamedText），停止落库时使用
    if (opts.signal?.aborted) {
      return { text: "", steps, durationMs: Date.now() - t0, model: opts.model, usage: { in: 0, out: 0, cached: 0 }, compactedStored: finalStored() }
    }
    throw asDiagnosedError(streamError ?? e, { executedToolCalls })
  }
  // T74：fullStream 可能「平静地」结束（不抛），真实错误只留在 error chunk 里。
  // 此时 result.text 必然 reject 一句废话——趁早把真实原因抛出去。
  if (streamError) throw asDiagnosedError(streamError, { executedToolCalls })
  // T30 收敛兜底：引擎在 convergeTimeoutMs（默认 3 分钟）强制停轮后，注入收敛指令小步续跑一次
  let finishReason = ""
  try {
    finishReason = await result.finishReason
  } catch { /* 拿不到就按正常结束处理 */ }
  if (finishReason === "tool-calls" && !opts.signal?.aborted) {
    try {
      const [doneSteps, responseMessages] = await Promise.all([result.steps, result.response.then((r) => r.messages as CoreMessage[])])
      if (responseMessages.length) {
        handlers.onStatus?.("引导收敛：验证与收尾")
        const conv = await runConverge(prep, opts.history ?? [], responseMessages, opts, handlers, t0)
        steps += conv.steps
        if (conv.reasoningText) convReasoning = conv.reasoningText
        if (conv.text.trim()) {
          handlers.onText?.(conv.text)
        }
      }
    } catch { /* 收敛续跑失败不影响主结果 */ }
  }
  let text = ""
  try {
    text = await result.text
  } catch (e) {
    // fullStream 正常结束但 text promise 仍 reject 的边界（如零步 abort 竞态）：同上吞掉
    if (opts.signal?.aborted) {
      return { text: "", steps, durationMs: Date.now() - t0, model: opts.model, usage: { in: 0, out: 0, cached: 0 }, compactedStored: finalStored() }
    }
    throw asDiagnosedError(e, { executedToolCalls })
  }
  const u = await result.usage
  // T74：上游"成功"却一个 token 都没产出——不能静默落一条空消息，得给明确原因
  if (!text.trim() && steps === 0 && !opts.signal?.aborted) {
    throw asDiagnosedError(new Error("模型没有返回任何内容：上游成功响应但未产出任何 token"), { executedToolCalls })
  }
  return {
    text,
    steps,
    durationMs: Date.now() - t0,
    model: opts.model,
    usage: { in: u?.inputTokens ?? 0, out: u?.outputTokens ?? 0, cached: u?.cachedInputTokens ?? 0 },
    compactedStored: finalStored(),
    // T101/T102：原生思考全文（主轮 + 收敛段合并）。网关落库时前置成 <thinking> 块
    ...(reasoningText || convReasoning ? { reasoningText: [reasoningText, convReasoning].filter(Boolean).join("\n") } : {}),
  }
}
