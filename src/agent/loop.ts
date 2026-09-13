import { generateText, streamText, stepCountIs, type CoreMessage, type Tool, type ToolSet, type StopCondition } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { loadConfig, resolveModel } from "./config.js"
import { composeSystem } from "./prompt.js"
import { asDiagnosedError } from "./errors.js"
import { makeTools, toolCtx } from "./tools.js"
import { loadInjection } from "./inject.js"
import { loadPlugins } from "../plugins/loader.js"
import { loadMcpTools } from "../mcp/client.js"
import type { QuestionBroker } from "./ask.js"

export interface AgentOptions {
  model?: string
  signal?: AbortSignal
  history?: CoreMessage[]
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
  /** 附件图片（base64），主模型支持视觉时直传 */
  images?: string[]
  onStep?: (tools: string[]) => void
}

export interface AgentResult {
  text: string
  steps: number
  durationMs: number
  /** 本次生成实际使用的模型 spec（如 sensenova/glm-5.2），前端显示昵称用 */
  model?: string
  usage?: { in: number; out: number; cached: number }
}

export type StreamHandlers = {
  onText?: (delta: string) => void
  onStatus?: (status: string) => void
  onStep?: (tools: string[]) => void
  onToolEvent?: (ev: { type: "call" | "result"; toolCallId: string; name: string; input?: unknown; output?: unknown }) => void
  /** R1：上下文压缩过程回调（开始/完成），供 Web/TUI 显示「压缩中」 */
  onCompact?: (phase: "start" | "done", info?: { before: number; after: number }) => void
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

const KEEP_RECENT = 6

/**
 * 上下文压缩（滚动摘要，参考 LangChain SummaryBufferMemory 算法）：
 * - token 计数用 gpt-tokenizer 精确 BPE
 * - R1：上下文超过模型窗口 60% 即压缩（不再区分长任务 90% 兜底）——压缩掉过程性细节、保留精简结论
 * - 压缩时合并既有摘要，保留任务目标/决定/路径/数据/未完成项，剔除过程性细节
 * - onCompact 回调：开始/完成时通知调用方显示「压缩中」
 */
async function compactHistory(
  history: CoreMessage[],
  modelSpec?: string,
  force = false,
  onCompact?: StreamHandlers["onCompact"],
): Promise<CoreMessage[]> {
  const config = loadConfig()
  const contextTokens = config.contextTokens ?? 131_072
  const budget = Math.floor(contextTokens * 0.6)
  const joined = history.map((m) => String(m.content)).join("\n\n")
  let count = 0
  try {
    const { countTokens } = await import("gpt-tokenizer")
    count = countTokens(joined)
  } catch {
    count = joined.length
  }
  if ((!force && count < budget) || history.length <= KEEP_RECENT + 2) return history

  // 识别既有滚动摘要，作为合并基础
  let base = ""
  let head = 0
  const first = history[0]
  const fs = String(first?.content ?? "")
  if (first?.role === "user" && (fs.startsWith("[滚动摘要]") || fs.startsWith("[历史摘要]"))) {
    base = fs.replace(/^\[(滚动摘要|历史摘要)\]\n?/, "")
    head = history[1]?.role === "assistant" ? 2 : 1
  }
  const old = history.slice(head, -KEEP_RECENT)
  const recent = history.slice(-KEEP_RECENT)
  if (!old.length) return history
  onCompact?.("start", { before: history.length, after: history.length })
  try {
    const { providerName, provider, modelId } = resolveModel(config, modelSpec)
    const p = createOpenAICompatible({ name: providerName, baseURL: provider.baseURL, apiKey: provider.apiKey })
    const transcript = old.map((m) => `${m.role}: ${String(m.content)}`).join("\n\n").slice(0, 60_000)
    const r = await generateText({
      model: p.chatModel(modelId),
      // T73：压缩摘要也注入基础层；指令进 system 的 role 槽（后置 + 作用域声明），prompt 只放数据
      system: composeSystem({
        role: "你是历史压缩器。把既有摘要与后续新消息合并为一份更新的精简摘要。必须保留：任务目标、已做决定、文件路径、重要数据、未完成事项；剔除过程性细节、重复内容、失败尝试的冗余描述。直接输出摘要正文，不要任何前言、标题或代码围栏。",
      }),
      prompt: `[既有摘要]\n${base || "（无）"}\n\n[新消息]\n${transcript}`,
      maxRetries: 2,
    })
    onCompact?.("done", { before: history.length, after: 2 + recent.length })
    return [
      { role: "user", content: `[滚动摘要]\n${r.text}` },
      { role: "assistant", content: "已了解历史上下文，继续。" },
      ...recent,
    ]
  } catch {
    onCompact?.("done", { before: history.length, after: history.length })
    return history
  }
}

interface Prepared {
  model: ReturnType<ReturnType<typeof createOpenAICompatible>["chatModel"]>
  system: string
  messages: CoreMessage[]
  tools: Record<string, Tool>
  stopWhen: Array<ReturnType<typeof stepCountIs> | StopCondition<ToolSet>>
  maxRetries: number
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

/** 收敛引导 prompt：注入后模型必须停止发散，进入验证与收尾 */
export const CONVERGE_PROMPT = `[系统收敛指令] 本次任务已连续运转超过 3 分钟。立即停止新的探索与尝试，进入验证与收尾阶段：基于已有结果完成任务收尾。如关键部分确实无法完成，直接说明已完成的范围与未解决的部分，给出简洁的收尾报告。`

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
): Promise<{ text: string; steps: number }> {
  const messages: CoreMessage[] = [
    ...priorHistory,
    ...responseMessages,
    { role: "user", content: CONVERGE_PROMPT },
  ]
  let steps = 0
  const result = toolCtx.run(
    { cwd: opts.cwd ?? process.cwd(), broker: opts.broker, sessionId: opts.sessionId },
    () =>
      streamText({
        model: prep.model,
        system: prep.system,
        tools: prep.tools,
        messages,
        maxRetries: prep.maxRetries,
        abortSignal: opts.signal,
        onAbort: () => handlers.onStatus?.("已停止"),
        onStepFinish: (step) => {
          steps++
          const calls = (step.toolCalls ?? []).map((c) => c.toolName)
          if (calls.length) {
            handlers.onStep?.(calls)
            handlers.onStatus?.(`执行中: ${calls.join(",")}`)
          }
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
      }
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
  return { text, steps }
}

async function prepare(prompt: string, opts: AgentOptions, onCompact?: StreamHandlers["onCompact"]): Promise<Prepared> {
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
  const system = composeSystem({ injection, skills: skillsPrompt(), role: opts.system, suffix: opts.systemSuffix })
  const compacted = await compactHistory(opts.history ?? [], opts.model, false, onCompact)
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
  const messages: CoreMessage[] = [...compacted, { role: "user", content: userContent }]

  const base = makeTools({ allowDelegate: true })
  const { tools: pluginTools } = await loadPlugins()
  const { tools: mcpTools, errors: mcpErrors } = await loadMcpTools()
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
      convergeTimeoutIs(config.convergeTimeoutMs ?? 180_000),
    ],
    maxRetries: 4,
  }
}

export async function runAgent(prompt: string, opts: AgentOptions = {}): Promise<AgentResult> {
  const prep = await prepare(prompt, opts)
  const t0 = Date.now()
  const ctx = { cwd: opts.cwd ?? process.cwd(), broker: opts.broker, sessionId: opts.sessionId }
  const result = await toolCtx.run(ctx, () =>
    generateText({
      ...prep,
      abortSignal: opts.signal,
      onStepFinish: (step) => {
        const calls = (step.toolCalls ?? []).map((c) => c.toolName)
        if (calls.length && opts.onStep) opts.onStep(calls)
      },
    }),
  )
  const u = result.usage
  return {
    text: result.text,
    steps: result.steps.length,
    durationMs: Date.now() - t0,
    model: opts.model,
    usage: { in: u?.inputTokens ?? 0, out: u?.outputTokens ?? 0, cached: u?.cachedInputTokens ?? 0 },
  }
}

/** 手动一键压缩：无视阈值，把历史压成摘要 + 最近几条 */
export async function compactNow(
  history: StoredMessageLike[],
  modelSpec?: string,
): Promise<Array<{ role: "user" | "assistant"; content: string; ts: number }>> {
  const compacted = await compactHistory(
    history.map((m) => ({ role: m.role, content: m.content }) as CoreMessage),
    modelSpec,
    true,
  )
  const now = Date.now()
  return compacted.map((m, i) => ({
    role: m.role as "user" | "assistant",
    content: String(m.content),
    ts: now - (compacted.length - i) * 1000,
  }))
}

type StoredMessageLike = { role: "user" | "assistant"; content: string; ts: number }

/** 流式版本：逐字回吐 + 状态回吐（思考中/执行中） */
export async function runAgentStream(
  prompt: string,
  opts: AgentOptions,
  handlers: StreamHandlers,
): Promise<AgentResult> {
  const prep = await prepare(prompt, opts, handlers?.onCompact)
  const t0 = Date.now()
  const ctx = { cwd: opts.cwd ?? process.cwd(), broker: opts.broker, sessionId: opts.sessionId }
  handlers.onStatus?.("思考中")
  let steps = 0
  // T74：流内错误必须自己接住——AI SDK 只会抛「No output generated. Check the stream for errors.」，
  // 真实原因（连接拒绝 / 401 / 402 / 5xx）藏在 error chunk 里，不接住就全丢，用户只看到一句废话 + 白重试。
  let streamError: unknown = null
  // 停止后可见：onAbort 拿不到已流出正文（text promise 也会 reject），gateway 靠 onText 自行累积
  const result = toolCtx.run(ctx, () =>
    streamText({
      ...prep,
      // T74：关掉 AI SDK 自带的重试（默认 2 次 → 最多 3 次请求）。它不显示进度，还和外层
      // gateway 的可见重试叠加成十几轮——本地服务没起时用户要干等两分钟才看到一句实话。
      // 现在：失败立即上抛真实原因，重发统一由 gateway 那条带倒计时的重试负责。
      maxRetries: 0,
      abortSignal: opts.signal,
      onAbort: () => {
        handlers.onStatus?.("已停止")
      },
      onStepFinish: (step) => {
        steps++
        const calls = (step.toolCalls ?? []).map((c) => c.toolName)
        if (calls.length) {
          handlers.onStep?.(calls)
          handlers.onStatus?.(`执行中: ${calls.join(",")}`)
        }
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
      } else if (chunk.type === "error") {
        // T74：这就是真实错误的藏身处。AI SDK 只在这里给一次，往后再问永远是
        // 「No output generated. Check the stream for errors.」。不接住 = 永久丢失病因。
        streamError = (chunk as { error?: unknown }).error ?? chunk
      }
    }
  } catch (e) {
    // abort 是用户主动停止：SDK 的 text/usage promise 也会 reject（AI_NoOutputGeneratedError），吃掉返回空文本——
    // 已流出的正文由 gateway 的 onText 累积（streamedText），停止落库时使用
    if (opts.signal?.aborted) {
      return { text: "", steps, durationMs: Date.now() - t0, model: opts.model, usage: { in: 0, out: 0, cached: 0 } }
    }
    throw asDiagnosedError(streamError ?? e)
  }
  // T74：fullStream 可能「平静地」结束（不抛），真实错误只留在 error chunk 里。
  // 此时 result.text 必然 reject 一句废话——趁早把真实原因抛出去。
  if (streamError) throw asDiagnosedError(streamError)
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
      return { text: "", steps, durationMs: Date.now() - t0, model: opts.model, usage: { in: 0, out: 0, cached: 0 } }
    }
    throw asDiagnosedError(e)
  }
  const u = await result.usage
  // T74：上游"成功"却一个 token 都没产出——不能静默落一条空消息，得给明确原因
  if (!text.trim() && steps === 0 && !opts.signal?.aborted) {
    throw asDiagnosedError(new Error("模型没有返回任何内容：上游成功响应但未产出任何 token"))
  }
  return {
    text,
    steps,
    durationMs: Date.now() - t0,
    model: opts.model,
    usage: { in: u?.inputTokens ?? 0, out: u?.outputTokens ?? 0, cached: u?.cachedInputTokens ?? 0 },
  }
}
