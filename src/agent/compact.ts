import type { CoreMessage } from "ai"

/**
 * T93：上下文压缩的纯逻辑部分（不碰网络、不读配置）。
 *
 * 抽出来的理由不是「为了好看」，而是这几条不变量必须能被测试盯住：
 * 摘要两条消息的 ts 必须严格排在保留消息之前、正文拍平不能产出 "[object Object]"、
 * 超长裁剪必须保留「开头 + 结尾」。这些原来埋在 compactHistory 里，只有发一次真实
 * LLM 请求才能间接验证 —— 等于没法验证。
 */

/** 历史消息：会话存储经 toCoreMessages 转换后的形态（带 ts，压缩写回时要用） */
export type HistoryMessage = CoreMessage & { ts?: number }

/** 落库形态的消息（压缩结果写回会话存储用） */
export interface StoredLike {
  role: "user" | "assistant"
  content: string
  ts: number
}

/** 压缩后保留的最近消息条数 */
export const KEEP_RECENT = 6

/** 摘要请求的正文上限 */
export const TRANSCRIPT_MAX = 60_000

/** 滚动摘要消息的标记（历史摘要 = 更早版本的写法，读到要认） */
const SUMMARY_MARKS = ["[滚动摘要]", "[历史摘要]"]

/**
 * 单个 content part → 文本。
 *
 * ⚠️ 历史坑（白皮书 10.31，真模型实测抓到）：AI SDK v5 里**工具调用/工具结果的 part
 * 都没有 .text 字段**，早先一律落成「[图片]」占位——于是回合内压缩后，模型看到的是
 * 六条交替的「[图片]」：轻则浪费上下文，重则产生幻觉（实测对着它们回「你这几条消息的
 * 图床返回是空的」而跑偏）。现在按 part 类型给可读文本；**只有真的图片 part 才给
 * 「[图片]」占位**——那个占位的本意是「别让摘要以为什么都没有」，不是给工具消息用的。
 *
 * 字段双认：v5 的工具调用参数在 `input`（旧形状 `args`），结果在 `output`
 * （v5 是 {type:"text"|"json",value}，旧形状 `result`）。
 */
function partToText(p: unknown): string {
  if (typeof p === "string") return p
  if (!p || typeof p !== "object") return ""
  const o = p as {
    type?: unknown; text?: unknown; toolName?: unknown
    input?: unknown; args?: unknown; output?: unknown; result?: unknown; image?: unknown
  }
  if (typeof o.text === "string") return o.text
  if (o.type === "tool-call") {
    const name = typeof o.toolName === "string" ? o.toolName : "?"
    const raw = o.input ?? o.args
    const args = typeof raw === "string" ? raw : JSON.stringify(raw ?? {})
    return `[调用 ${name}(${args.slice(0, 200)})]`
  }
  if (o.type === "tool-result") {
    const r = o.output ?? o.result
    const t = typeof r === "string"
      ? r
      : r && typeof r === "object" && "value" in (r as object)
        ? String((r as { value: unknown }).value)
        : JSON.stringify(r ?? "")
    return `[工具结果] ${t.slice(0, 500)}`
  }
  if (o.type === "tool-error") {
    const e = (o as { error?: unknown }).error
    return `[工具错误] ${String(e instanceof Error ? e.message : (e ?? "")).slice(0, 200)}`
  }
  // 真的图片/文件 part 才说「图片」
  if (o.type === "image" || o.image != null) return "[图片]"
  return "[非文本内容]"
}

/**
 * 模型把工具调用误输出成**文本**的 XML 形态（白皮书 10.31 真模型实测：弱模型会这么干，
 * 这段文本从没真实执行过）。留着它有三害：进历史是虚构记录、进摘要会被原样抄写、
 * 主模型接着模仿（E 轮实测：摘要里出现 tool_call，模型的最终消息也变成工具调用回声）。
 * 拍平时整块剥掉；只剩碎片标签也剥。剥空了给短标记——空 content 在上游可能非法，
 * 且「这里曾经有过东西」本身是事实。
 *
 * 三种形态都处理：①完整块；②**未闭合的开头标签**（模型话说一半断了——从那之后
 * 全是虚构调用，一起切掉，只留标签前的正常文本）；③单独出现的碎片标签。
 *
 * 只认 tool_call 这一种形态（实测见过的）；模型把调用输出成别的文本形态（如裸 JSON）
 * 无法可靠区分「虚构调用」与「正常内容」，不猜。
 * （正则用 \u003c 转义写，避免源码里出现字面标签被各种工具误伤。）
 */
const FAKE_TOOL_CALL_RE = /\u003ctool_call\u003e[\s\S]*?\u003c\/tool_call\u003e/g
const STRAY_TOOL_CALL_TAG_RE = /\u003c\/?tool_call\u003e/g

function stripFakeToolCallText(s: string): string {
  if (!s.includes("\u003ctool_call") && !s.includes("\u003c/tool_call")) return s
  let out = s.replace(FAKE_TOOL_CALL_RE, "")
  // 未闭合的开头标签：从那之后全部是虚构调用（模型被截断），一并切掉
  const openAt = out.indexOf("\u003ctool_call")
  if (openAt >= 0) out = out.slice(0, openAt)
  out = out.replace(STRAY_TOOL_CALL_TAG_RE, "")
  return out.trim() ? out : "（无效的工具调用文本，已忽略）"
}

/**
 * 把消息正文拍成纯文本。
 * 多模态消息的 content 是 parts 数组，直接 String() 会得到 "[object Object]"——
 * 压缩时会把历史写成一堆 "[object Object]"。当前调用链传进来的都是纯文本，
 * 但这是「一旦某天传进图文消息就静默毁掉历史」的那类隐患，先堵上。
 */
export function contentToText(c: unknown): string {
  if (typeof c === "string") return stripFakeToolCallText(c)
  if (Array.isArray(c)) return c.map((p) => stripFakeToolCallText(partToText(p))).filter(Boolean).join("\n")
  if (c == null) return ""
  if (typeof c === "object") {
    // 单个 part 对象（不是数组）也认；认不出来时给占位而不是 "[object Object]"
    const t = (c as { text?: unknown }).text
    return typeof t === "string" ? stripFakeToolCallText(t) : "[非文本内容]"
  }
  return String(c)
}

/**
 * 摘要文本归一化：弱模型有时把摘要输出成 JSON 壳（实测 {"summary": "..."}）——
 * 内容是对的，壳剥掉（2026-09-23 多轮验证：加「材料≠任务主题」约束后摘要内容
 * 正确了，但裹了层 JSON）。不是合法 JSON 或没有 summary 字段就原样返回。
 */
export function normalizeSummaryText(raw: string): string {
  const t = (raw ?? "").trim()
  if (!t.startsWith("{")) return t
  try {
    const parsed = JSON.parse(t) as { summary?: unknown }
    if (typeof parsed.summary === "string" && parsed.summary.trim()) return parsed.summary.trim()
  } catch { /* 不是合法 JSON，原样用 */ }
  return t
}

/**
 * 超长时保留「开头 + 结尾」而不是只留开头。
 * 原来是 slice(0, 60000) —— 砍掉的正好是最靠近当前的内容，与「保留近期」的直觉相反。
 * 开头是任务目标，结尾是当前状态，中间的流水账最不值钱。
 */
export function fitTranscript(s: string, max = TRANSCRIPT_MAX): string {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.4)
  const tail = max - head
  return `${s.slice(0, head)}\n\n[…中间 ${s.length - max} 字符因超长省略…]\n\n${s.slice(-tail)}`
}

/** 是不是一条滚动摘要消息（压缩时作为合并基础） */
export function isRollingSummary(m: HistoryMessage | undefined): boolean {
  if (m?.role !== "user") return false
  const s = contentToText(m.content)
  return SUMMARY_MARKS.some((k) => s.startsWith(k))
}

/** 剥掉摘要标记，拿到摘要正文 */
export function summaryBody(content: unknown): string {
  const s = contentToText(content)
  for (const k of SUMMARY_MARKS) {
    if (s.startsWith(k)) return s.slice(k.length).replace(/^\n/, "")
  }
  return s
}

/** 核心消息 → 落库形态（ts 缺失时退回给定的锚点，保证顺序仍可预测） */
export function toStoredLike(m: HistoryMessage, fallbackTs: number): StoredLike {
  return {
    role: m.role === "assistant" ? "assistant" : "user",
    content: contentToText(m.content),
    ts: typeof m.ts === "number" ? m.ts : fallbackTs,
  }
}

/**
 * 把新摘要与保留的最近消息拼成落库形态。
 *
 * 不变量（tests/compact.test.ts 盯着）：两条摘要消息的 ts 严格小于第一条保留消息的 ts。
 * 会话文件是按 ts 定位的（撤销/编辑走 truncateFrom），顺序错了会让「摘要」跑到对话后面去。
 */
export function buildCompactedStored(summary: string, recent: HistoryMessage[]): StoredLike[] {
  const anchor = typeof recent[0]?.ts === "number" ? (recent[0].ts as number) : Date.now()
  return [
    { role: "user", content: `[滚动摘要]\n${summary}`, ts: anchor - 2 },
    { role: "assistant", content: "已了解历史上下文，继续。", ts: anchor - 1 },
    ...recent.map((m) => toStoredLike(m, anchor)),
  ]
}

/** 回合内压缩：上下文占窗口到这个比例就主动压。比回合间的 0.6 更宽松——回合内每压一次
 *  都是一次 LLM 调用，压太勤等于把成本翻倍；留点余量也给模型连续干活的空间。 */
export const MID_TURN_RATIO = 0.75
/** 两次回合内压缩之间至少隔这么多步。压缩本身要花一次模型调用，步步压没有意义 */
export const MID_TURN_MIN_GAP_STEPS = 6

/**
 * 丢掉开头孤立的 `tool` 消息。
 *
 * 压缩保留的是**后缀**，而后缀的第一条很可能是一条 tool 结果——发起它的 assistant
 * 消息已经被压掉了。留着它就是「工具结果没有对应的调用」，上游会直接报错。
 * 这是回合内压缩**最容易踩的坑**：不处理的话，压缩不但没救场，反而把回合搞崩。
 */
export function dropOrphanToolMessages<T extends { role?: unknown }>(msgs: T[]): T[] {
  let i = 0
  while (i < msgs.length && msgs[i]?.role === "tool") i++
  return i === 0 ? msgs : msgs.slice(i)
}
