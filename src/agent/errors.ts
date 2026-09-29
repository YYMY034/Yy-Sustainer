/**
 * T74 错误诊断：把 provider / 传输层错误变成「人能看懂 + 能判重试」的结构。
 *
 * 为什么需要它：
 *  AI SDK 的 streamText 在流内出错时**不会**把真实错误抛出来——它只在 fullStream 里
 *  吐一个 `{type:"error", error}` chunk，然后把 `result.text` 拒掉，拒的理由永远是
 *  一句 `No output generated. Check the stream for errors.`。
 *  于是上层看到的全是这句废话：用户不知道是 key 错了、没钱了、还是本地服务没起。
 *  更糟的是 gateway 的重试判定用 `/rate/` 猜限流，而 "gene**rate**d" 正好命中——
 *  401/402 这种**绝不该重试**的错误被白重试 10 次，每次还等十几秒。
 *
 * 本模块做三件事：
 *  1. `describeFailure()` —— 从 AI_RetryError / APICallError 的嵌套结构里挖出真实原因，
 *     按 statusCode + 网络错误码分类，给中文提示，并判定是否值得重试。
 *  2. `retryBudget()` —— 按类别给重试次数（鉴权/欠费/配置错 → 0，网络/5xx → 有限次）。
 *  3. `asDiagnosedError()` —— 统一「自动重发中」的文案来源。
 */

export type ErrKind =
  | "abort" // 用户主动停止 / 引擎收敛强制停轮
  | "auth" // 401 / 403：key 无效或无权限
  | "quota" // 402：余额/额度不足
  | "notfound" // 404：模型或 baseURL 路径不对
  | "badrequest" // 400 / 422：请求体不合法（多为模型不支持某参数）
  | "ratelimit" // 429
  | "server" // 5xx
  | "network" // 连接被拒 / 连接被重置 / fetch failed
  | "dns" // 域名解析失败
  | "timeout" // 连接或首包超时
  | "unknown"

export interface ErrInfo {
  /** 人类可读的一句话（给用户直接看） */
  message: string
  kind: ErrKind
  /** HTTP 状态码（若有） */
  status?: number
  /** 出错的目标地址（若有） */
  url?: string
  /** 是否值得自动重发 */
  retryable: boolean
}

/** AI SDK 的重试包装类会把「最后一次尝试」藏在 errors[] / lastError 里，挖到最里面 */
function deepest(e: unknown, depth = 0): unknown {
  if (!e || typeof e !== "object" || depth > 6) return e
  const o = e as Record<string, unknown>
  const arr = o.errors
  if (Array.isArray(arr) && arr.length) return deepest(arr[arr.length - 1], depth + 1)
  if (o.lastError) return deepest(o.lastError, depth + 1)
  return e
}

/** 从嵌套层里逐级找 HTTP 状态码 */
function findStatus(e: unknown, depth = 0): number | undefined {
  if (!e || typeof e !== "object" || depth > 8) return undefined
  const o = e as Record<string, unknown>
  for (const k of ["statusCode", "status"]) {
    const v = o[k]
    if (typeof v === "number" && v >= 100 && v < 600) return v
  }
  const arr = o.errors
  if (Array.isArray(arr) && arr.length) return findStatus(arr[arr.length - 1], depth + 1)
  if (o.lastError) return findStatus(o.lastError, depth + 1)
  return undefined
}

/** 去掉 AI SDK 的英文套话——它常嵌在 message 中间（RetryError 的 message 就是 "Failed after N attempts. Last error: <真因>"） */
function stripSdkNoise(s: string): string {
  return s
    .replace(/Failed after \d+ attempts\.\s*/gi, "")
    .replace(/Last error:\s*/gi, "")
    .replace(/Cannot connect to API:\s*/gi, "")
    .replace(/^AI_APICallError:\s*/i, "")
    .trim()
}

/** 收进根因片段：重复的、被包含的都不要，让"真因"只说一遍 */
function pushPart(parts: string[], p: string): void {
  const t = stripSdkNoise(p)
  if (!t) return
  if (parts.some((x) => x.includes(t))) return // 已经有一条更完整的覆盖它了
  const i = parts.findIndex((x) => t.includes(x))
  if (i >= 0) parts.splice(i, 1) // 新片段更完整，顶掉旧的碎片
  parts.push(t)
}

/** 拼出「根因文字」：cause 链 + responseBody 里的 error.message 都要看 */
function rootText(e: unknown): string {
  if (!e) return ""
  if (typeof e === "string") return e
  if (!(e instanceof Error) && typeof e !== "object") return String(e)
  const o = e as Record<string, any>
  const parts: string[] = []
  if (typeof o.message === "string" && o.message) pushPart(parts, o.message)
  // OpenAI 兼容端点习惯把原因塞在 responseBody 的 error.message 里
  const body = o.responseBody
  if (typeof body === "string" && body.trim()) {
    try {
      const j = JSON.parse(body)
      const m = j?.error?.message ?? j?.message ?? j?.error ?? ""
      if (typeof m === "string" && m) pushPart(parts, m)
    } catch {
      pushPart(parts, body.slice(0, 200))
    }
  }
  const c = o.cause
  if (c && c !== e) {
    const cm = rootText(c)
    if (cm) pushPart(parts, cm)
  }
  return parts.join(" · ").trim()
}

/** 各类错误的「人话解释」——用户照着这句就能自查配置 */
const HINTS: Record<ErrKind, string> = {
  abort: "已停止",
  auth: "API Key 无效、已过期或没有该模型的权限，请检查通道配置",
  quota: "账户余额或额度不足，请充值或更换通道",
  notfound: "接口地址或模型 ID 不存在，请检查 Base URL（应以 /v1 结尾）与模型名",
  badrequest: "请求被上游拒绝，通常是该模型不支持所选参数",
  ratelimit: "触发上游限流，稍后会自动重试",
  server: "上游服务异常（非本机问题），稍后会自动重试",
  network: "连不上上游：本地服务未启动、端口被占用或被代理/防火墙拦截",
  dns: "域名解析失败，请检查 Base URL 拼写与网络",
  timeout: "连接上游超时，请检查网络或代理",
  unknown: "未知错误",
}

/** 这些类别才值得自动重发；其余（鉴权/欠费/配置错/未知）重发一百次也一样，别让用户干等 */
const RETRYABLE_KINDS = new Set<ErrKind>(["ratelimit", "server", "network", "timeout"])

/** 把任意抛出物归一成可判定、可展示的错误信息 */
export function describeFailure(e: unknown): ErrInfo {
  const top = e as Record<string, any> | null

  // 0) 幂等：asDiagnosedError 已经诊断过的错误会带 kind 标记，别再诊一遍——
  //    二次诊断会把"干净原因"和它 cause 里的 SDK 原文拼在一起，变成一长串重复
  const preKind = top?.kind
  if (typeof preKind === "string" && Object.prototype.hasOwnProperty.call(HINTS, preKind)) {
    const k = preKind as ErrKind
    return {
      message: String(top?.message ?? ""),
      kind: k,
      status: typeof top?.status === "number" ? top.status : undefined,
      url: typeof top?.url === "string" ? top.url : undefined,
      retryable: RETRYABLE_KINDS.has(k),
    }
  }

  // 1) abort 优先——用户主动停止不是"错误"
  const name = String(top?.name ?? "")
  const rawMsg = typeof top?.message === "string" ? top.message : String(e ?? "")
  if (name === "AbortError" || /^abort/i.test(rawMsg) || /aborted/i.test(name)) {
    return { message: "已停止", kind: "abort", retryable: false }
  }

  const d = deepest(e)
  const status = findStatus(e)
  const url = String((d as any)?.url ?? (top as any)?.url ?? "") || undefined
  // 根因文字：优先用最深层的（那是真正的 API 报错），退回最外层
  let text = stripSdkNoise(rootText(d) || rootText(e) || rawMsg || "未知错误")
  if (/^no output generated/i.test(text)) text = ""

  // 2) 归类：statusCode 优先，其次网络错误码关键字
  let kind: ErrKind = "unknown"
  const netish =
    /\b(ECONNREFUSED|ECONNRESET|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed|other side closed|terminated|premature close|UND_ERR_SOCKET)\b|Failed to process successful response/i
  const dnsish = /\b(ENOTFOUND|EAI_AGAIN|getaddrinfo)\b/i
  const timeoutish = /\b(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|connect timeout|timed? ?out)\b/i

  if (status === 401 || status === 403) kind = "auth"
  else if (status === 402) kind = "quota"
  else if (status === 404) kind = "notfound"
  else if (status === 400 || status === 422) kind = "badrequest"
  else if (status === 429) kind = "ratelimit"
  else if (status && status >= 500) kind = "server"
  else if (timeoutish.test(text) || timeoutish.test(rawMsg)) kind = "timeout"
  else if (dnsish.test(text) || dnsish.test(rawMsg)) kind = "dns"
  else if (netish.test(text) || netish.test(rawMsg)) kind = "network"

  // 展示用状态码：2xx/3xx 不是"HTTP 错误"，别在文案里摆出来误导人（流中途断掉时上游返回的就是 200）
  const showStatus = status && status >= 400 ? status : undefined

  // 3) 组装给用户看的一句话
  if (!text && !showStatus) {
    // 真正的"空响应"：没有状态码、没有根因文字——AI SDK 的 NoOutputGenerated 就是这一档
    return {
      message: "模型没有返回任何内容：上游连接中断，或未产出任何 token。请检查该通道的地址与密钥是否可用",
      kind: "unknown",
      url,
      retryable: false,
    }
  }
  const head = text || `HTTP ${showStatus}`
  const label = text && showStatus ? ` · HTTP ${showStatus}` : ""
  const hint = HINTS[kind]
  const message = hint && hint !== "未知错误" ? `${head}${label}（${hint}）` : `${head}${label}`

  const retryable = RETRYABLE_KINDS.has(kind)
  return { message, kind, status, url, retryable }
}

/** 按错误类别给重试预算——不值得重试的一律 0，别让用户干等 */
export function retryBudget(kind: ErrKind): number {
  switch (kind) {
    case "ratelimit":
      return 8
    case "server":
      return 4
    case "network":
      return 4
    case "timeout":
      return 3
    default:
      // auth / quota / notfound / badrequest / dns / abort / unknown：配置或权限问题，重发一百次也一样
      return 0
  }
}

/**
 * 把任意抛出物换成带真实原因的 Error（保留 name 便于上层判 abort）。
 * T91：可附带「本次失败前已执行的工具调用数」——重试前必须看它。
 * 已产生副作用的回合（写过文件、跑过命令、发过请求）整轮重跑＝副作用重复，
 * 上层据此放弃自动重发（见 gateway 的重试循环）。
 */
export function asDiagnosedError(e: unknown, extra?: { executedToolCalls?: number }): Error {
  const info = describeFailure(e)
  const out = new Error(info.message)
  out.name = String((e as Record<string, any>)?.name ?? "Error")
  ;(out as any).kind = info.kind
  ;(out as any).status = info.status
  ;(out as any).cause = e
  const inherited = Number((e as Record<string, any>)?.executedToolCalls ?? 0)
  ;(out as any).executedToolCalls = extra?.executedToolCalls ?? (Number.isFinite(inherited) ? inherited : 0)
  return out
}

/**
 * T93 P3：判定一个错误是不是「上下文超出模型窗口」。
 *
 * 为什么要单独判：这类错误在 `describeFailure` 里会落进 `badrequest`，
 * 于是 `retryBudget = 0`，提示文案是「请求被上游拒绝，通常是该模型不支持所选参数」——
 * **病因完全不相干**。而它是长任务最常见的死法之一：`config.contextTokens`
 * 是个手拍的值（默认 131072），配了 32k/8k 窗口的模型时压缩阈值形同虚设，
 * 任务跑几十步后在某一部突然死掉，用户既不知道真实原因也不知道能做什么。
 *
 * 各家说法（OpenAI 兼容 / Anthropic / 国产通道都见过）：
 *   - "This model's maximum context length is 8192 tokens..."
 *   - code: "context_length_exceeded"
 *   - "maximum context length" / "context window" / "too many tokens"
 *   - "Request too large" / "payload too large" / HTTP 413
 * 匹配刻意放宽：漏判的代价是任务白死，误判的代价只是多压一次（很便宜）。
 */
const CTX_OVERFLOW_PATTERNS = [
  /context[_ ]?length/i,
  /context window/i,
  /maximum context/i,
  /too many tokens/i,
  /too long for model/i,
  /request too large/i,
  /payload too large/i,
  /tokens? (?:exceed|limit)/i,
  /exceeds? the (?:maximum|model)/i,
  /reduce the length of the messages/i,
]

export function isContextOverflow(e: unknown): boolean {
  const texts: string[] = []
  let tooLarge = false
  // 遍历整棵错误树收集字符串与 status。刻意放宽：真实错误结构千奇百怪
  // （APICallError.statusCode / response.status / responseBody.error.message / lastError…），
  // 漏判的代价是任务白死，误判的代价只是多压一次历史（很便宜）。
  // 但要设上限——错误里可能挂着整个 responseBody。
  const MAX_TEXTS = 200
  const MAX_LEN = 2000
  const walk = (x: unknown, depth = 0): void => {
    if (depth > 6 || x == null || texts.length >= MAX_TEXTS) return
    if (typeof x === "string") {
      texts.push(x.slice(0, MAX_LEN))
      return
    }
    if (typeof x === "number") return
    if (Array.isArray(x)) {
      for (const it of x) walk(it, depth + 1)
      return
    }
    if (typeof x === "object") {
      const o = x as Record<string, unknown>
      for (const k of ["status", "statusCode"]) {
        if (o[k] === 413 || o[k] === "413") tooLarge = true
      }
      // Error 的 message/name 是**不可枚举**的自有属性，Object.entries 看不到——
      // 只靠 entries 会漏掉最常见的那一种（第一版就这么错的，实测漏掉了 asDiagnosedError 包过的错误）
      for (const k of ["message", "name"]) {
        if (typeof o[k] === "string") texts.push((o[k] as string).slice(0, MAX_LEN))
      }
      for (const [k, v] of Object.entries(o)) {
        if (k === "stack") continue // 栈里全是源码文本，又长又无关
        walk(v, depth + 1)
      }
    }
  }
  walk(e)
  if (tooLarge) return true
  return texts.some((t) => CTX_OVERFLOW_PATTERNS.some((re) => re.test(t)))
}

/** 给用户看的一句「超限了该怎么办」——带上当前估值，让人知道该调什么 */
export function contextOverflowHint(contextTokens: number, compacted: boolean): string {
  const tried = compacted ? "已自动压缩历史后重试，仍然超限" : "未做压缩"
  return (
    `上下文超出模型窗口（${tried}）。` +
    `请把 config.contextTokens 调小到模型的真实窗口（当前估值 ${contextTokens}），` +
    `或换用窗口更大的模型。长任务建议同时开启会话的长任务模式。`
  )
}
