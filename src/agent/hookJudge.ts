import { generateText } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadConfig, resolveModel, type HookConfig } from "./config.js"
import { composeSystem } from "./prompt.js"

/**
 * T93 L1：钩子判定的**后端抽象**。
 *
 * 为什么要抽这一层：原来 `runHooksOnTool` 把「用什么模型判」和「怎么渲染修正提示」
 * 焊死在一起，于是「换一个更便宜的判定模型」要动整段逻辑，也没法在没有那个模型时
 * 验证任何东西。抽成接口后：
 *   - 换模型只是换一个实现，`runHooksOnTool` 的契约一行不动
 *   - `replay` 后端让 A/B 框架**在没有外部通道时也能闭环**（录下的判定回放）
 *
 * 两条硬规则（写在这里免得后人推翻时不知道代价）：
 *   1. **后端只回答「判没判、判成什么」**。「判不出该怎么办」是调用方的策略——
 *      安全钩子和格式钩子方向相反，不该由后端替他决定。
 *   2. **放行/阻断永远留在代码里**。后端返回判定，不返回动作。
 */

/** 单条钩子的判定。`reason` 只在 pass=false 或有补充说明时出现。 */
export interface HookVerdict {
  hookId: string
  pass: boolean
  reason?: string
}

/** 后端的输入。`sample` 已由调用方截断，后端不再自己切。 */
export interface JudgeInput {
  tool: string
  sample: string
  /** 已按 enabled 过滤、且顺序稳定（调用方保证） */
  hooks: HookConfig[]
}

export interface HookJudge {
  readonly kind: "llm" | "replay" | "typesafe"
  /**
   * 返回**能判定**的那些钩子。判不出的钩子**不要**放进结果——
   * 调用方按 `HookConfig.strict` 决定「缺失」算通过还是算存疑。
   */
  judge(input: JudgeInput): Promise<HookVerdict[]>
}

/** 判定输入的稳定指纹：replay 后端靠它找记录，A/B 框架靠它对齐两边输入 */
export function judgeInputKey(input: JudgeInput): string {
  const h = createHash("sha1")
  h.update(input.tool)
  h.update("\n@tool@\n")
  h.update(input.sample)
  // 按 id 排序后哈希：A/B 两边拿到的钩子顺序可能不同，指纹该仍能对齐
  for (const hook of [...input.hooks].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update("\n@hook@\n")
    h.update(hook.id)
    h.update("@id@")
    h.update(hook.prompt)
  }
  return h.digest("hex")
}

// ---------- LLM 后端（现状的继任者） ----------

const CHECK_TIMEOUT_MS = 25_000
/** 输出采样上限。**调用方传入的 sample 已经是切过的**，这里只兜底防呆。 */
const SAMPLE_HARD_CAP = 4000

/**
 * 用主模型判。相对旧实现的三个修正：
 *   ① 输出格式**锚定到行首**，且按 hookId 精确匹配——旧实现用
 *      `line.includes(h.name)` 子串匹配，钩子名叫「安全钩子」和「安全检查」时
 *      第二条会命中第一条那一行，**拿到别人的判定**。
 *   ② 判不出的钩子**不进结果**（而不是按通过）——缺失怎么算由调用方的 strict 决定。
 *   ③ 仍保留剥 thinking 块与容错解析：模型多说前言/结论不影响判定。
 */
export class LlmHookJudge implements HookJudge {
  readonly kind = "llm" as const

  async judge(input: JudgeInput): Promise<HookVerdict[]> {
    const cfg = loadConfig()
    let client: ReturnType<typeof createOpenAICompatible>
    let modelId: string
    try {
      const resolved = resolveModel(cfg, cfg.model)
      client = createOpenAICompatible({ name: resolved.providerName, baseURL: resolved.provider.baseURL, apiKey: resolved.provider.apiKey })
      modelId = resolved.modelId
    } catch {
      return [] // 无可用模型 → 一个都判不出，由调用方按 strict 处理
    }
    const sample = input.sample.length > SAMPLE_HARD_CAP ? input.sample.slice(0, SAMPLE_HARD_CAP) : input.sample
    // 每行一个钩子，行首锚定；用 id 而不是 name 匹配（name 可能互为子串）
    const checklist = input.hooks.map((h) => `${h.id}｜${h.prompt}`).join("\n")
    let txt = ""
    try {
      const r = await generateText({
        model: client.chatModel(modelId),
        system: composeSystem({
          compactBase: true,
          role:
            "你是钩子检查器。对给定内容逐条执行下列检查，**每条输出一行**，格式严格为「钩子id｜PASS」或「钩子id｜FAIL:原因（简短）」，行首必须是钩子id本身，不要附加任何其他文字。",
        }),
        prompt: `【工具】${input.tool}\n【内容】\n${sample}\n\n【检查清单】\n${checklist}`,
        abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      })
      txt = (r.text ?? "").trim()
    } catch {
      return [] // 超时/报错 → 判不出，调用方按 strict 处理
    }
    const verdicts = parseVerdictLines(txt, input.hooks)
    // L2：录样本。**判不出的也要录**（空数组）——「后端在什么输入上会失手」正是要分析的数据。
    // 录失败绝不影响判定：这是诊断数据，不是主链路。
    if (loadConfig().hookRecord) recordSample(input, verdicts)
    return verdicts
  }
}

/**
 * 把一次判定追加到 `~/.yyagent/hook-samples.jsonl`（replay 后端与 A/B 框架的数据源）。
 *
 * 只追加不读、坏行由读取方跳过——和 `usage.jsonl` 同一套路子。
 * 并发会话可能交错写，但 JSONL 一行一次 appendFileSync，实践上不会写出半行；
 * 真出半行也只会丢一条样本，不值得为此上加锁。
 */
export function recordSample(input: JudgeInput, verdicts: HookVerdict[]): void {
  try {
    mkdirSync(join(homedir(), ".yyagent"), { recursive: true })
    const rec = {
      ts: Date.now(),
      tool: input.tool,
      sample: input.sample,
      hooks: input.hooks.map((h) => ({ id: h.id, prompt: h.prompt })),
      verdicts,
    }
    appendFileSync(DEFAULT_REPLAY_FILE, JSON.stringify(rec) + "\n")
  } catch {
    /* 录不进去就算了，判定已经完成 */
  }
}

/**
 * 解析「钩子id｜PASS / 钩子id｜FAIL:原因」行。
 *
 * **按 id 精确匹配**（旧实现按 name 子串匹配，会串台），且只认行首——
 * 模型在前言里提到某个钩子 id 不算数。
 */
export function parseVerdictLines(raw: string, hooks: HookConfig[]): HookVerdict[] {
  // 剥 thinking 块放在这里而不是调用方：任何后端拿到的是模型原始输出，
  // 都该先剥再判（放在调用方就意味着每个后端都要各自记得剥一遍）
  const txt = raw.replace(/<(thinking|think)>[\s\S]*?<\/\1>/gi, "")
  const byId = new Map<string, HookConfig>(hooks.map((h) => [h.id, h]))
  const out: HookVerdict[] = []
  const seen = new Set<string>()
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = /^([^｜|:\s]+)\s*[｜|]\s*(PASS|FAIL)\b\s*[:：]?\s*(.*)$/i.exec(line)
    if (!m) continue
    const id = m[1].trim()
    const hook = byId.get(id)
    // 必须是本次要判的钩子 id，且没判过（第一次出现为准，避免模型重复输出自相矛盾）
    if (!hook || seen.has(id)) continue
    seen.add(id)
    const isFail = /^FAIL/i.test(m[2])
    const reason = (m[3] ?? "").trim().slice(0, 120)
    out.push(isFail ? { hookId: id, pass: false, reason: reason || "未通过检查" } : { hookId: id, pass: true })
  }
  return out
}

// ---------- replay 后端（A/B 框架的地基） ----------

/** 一条录制样本：判定输入 + 当时各钩子的判定 */
export interface HookSample {
  ts: number
  tool: string
  sample: string
  hooks: Array<{ id: string; prompt: string }>
  verdicts: HookVerdict[]
}

/** 默认录制文件。做成模块常量而不是配置项——它是内部产物，不该占配置面。 */
export const DEFAULT_REPLAY_FILE = join(homedir(), ".yyagent", "hook-samples.jsonl")

/**
 * 回放录下来的判定。
 *
 * 存在的意义：**让 A/B 框架在没有外部通道时也能闭环**。
 * 用它可以验证「框架真的在比对两个后端」「门槛算得对」「fail-open 每条路都通」——
 * 唯一验不了的是廉价模型在真实数据上的质量，那个必须跑通道。
 *
 * 判据（输入指纹）对不上 → 返回空数组（= 判不出），由调用方按 strict 处理。
 */
export class ReplayHookJudge implements HookJudge {
  readonly kind = "replay" as const
  private loaded = false
  private byKey = new Map<string, HookVerdict[]>()

  constructor(private readonly file: string = DEFAULT_REPLAY_FILE) {}

  /** 从 JSONL 读样本。坏行跳过（和 usage.ts 一致）；文件不在就当空库。 */
  load(): number {
    this.byKey.clear()
    this.loaded = true
    if (!existsSync(this.file)) return 0
    let n = 0
    try {
      for (const line of readFileSync(this.file, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const s = JSON.parse(line) as HookSample
          if (!s || typeof s.tool !== "string" || !Array.isArray(s.verdicts)) continue
          this.byKey.set(judgeInputKey({ tool: s.tool, sample: s.sample, hooks: (s.hooks ?? []) as HookConfig[] }), s.verdicts)
          n++
        } catch {
          /* 坏行跳过 */
        }
      }
    } catch {
      /* 读不了就当空库 */
    }
    return n
  }

  async judge(input: JudgeInput): Promise<HookVerdict[]> {
    if (!this.loaded) this.load()
    return this.byKey.get(judgeInputKey(input)) ?? []
  }
}

/** 按配置挑后端。**认不出来的后端名 → 回落 llm 并告警**，绝不静默关掉检查。 */
export function pickJudge(hookId: string): HookJudge {
  const backend = loadConfig().hookBackend?.[hookId]
  if (backend === "replay") return new ReplayHookJudge()
  if (backend === "typesafe") return new TypesafeHookJudge()
  if (backend && backend !== "llm") {
    console.warn(`[钩子] 未知判定后端 "${backend}"（钩子 ${hookId}），已回落 llm；可用值：llm / replay / typesafe`)
  }
  return new LlmHookJudge()
}

// ---------- TypeSafe 后端（Jev） ----------

/**
 * T93 L2：用 TypeSafe（Jev）做判定的后端。
 *
 * 与 llm 后端的区别不只是「换个模型」：
 *   - **一次请求问完所有钩子**（questions 是 map，并行求值，官方文档明确说加问题几乎不增加响应时间）
 *   - **返回类型化结果**，不再有「从自由文本里正则捞判定」这一步——
 *     那正是 L1 修掉的 bug ① 的根源
 *   - 返回的是**概率**（noul 0–1），所以能按钩子设阈值，不必二选一
 *
 * 三个实现决定：
 *   1. **问题用英文写、判据保持原文**。官方 models 页明说 English 是主要训练语言、
 *      CJK "handled but not equally well"。把「是否违反这条规则」的问句翻成英文、
 *      规则原文（rule 字段）保持中文，是当前信息下的最优解；真实一致率要靠 A/B 框架量。
 *   2. **任何异常都返回空数组**（= 判不出），由调用方按 strict 决定——
 *     没配 key、连不上、401、429/529、响应畸形，一视同仁。判定后端不是主链路。
 *   3. **429/529 退避一次**（官方文档要求；SDK 自带，这里直连 HTTP 只能自己来）。
 */

const TS_DEFAULTS = {
  model: "jev-latest",
  baseUrl: "https://api.typesafe.ai/v1",
  timeoutMs: 8000,
  /** noul ≥ 该值判 FAIL。0.5 = 过半把握就拦 */
  threshold: 0.5,
} as const

/** TypeSafe /v1/systemone 的响应体（只取用得到的字段） */
interface SystemOneResponse {
  answers?: Record<string, { type?: string; noul?: number }>
}

function tsCfg(): { apiKey?: string; model: string; baseUrl: string; timeoutMs: number; threshold: number } {
  const t = loadConfig().typesafe ?? {}
  return {
    apiKey: t.apiKey,
    model: t.model ?? TS_DEFAULTS.model,
    baseUrl: (t.baseUrl ?? TS_DEFAULTS.baseUrl).replace(/\/+$/, ""),
    timeoutMs: t.timeoutMs ?? TS_DEFAULTS.timeoutMs,
    threshold: t.threshold ?? TS_DEFAULTS.threshold,
  }
}

/** 退避：429/529 时按 retry-after 或固定 1s 等一次 */
async function backoffOnce(res: Response): Promise<void> {
  const ra = Number(res.headers.get("retry-after"))
  await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : 1000))
}

export class TypesafeHookJudge implements HookJudge {
  readonly kind = "typesafe" as const

  async judge(input: JudgeInput): Promise<HookVerdict[]> {
    const { apiKey, model, baseUrl, timeoutMs, threshold } = tsCfg()
    if (!apiKey) return [] // 没配 key → 判不出
    const state = { tool: input.tool, output: input.sample }
    const questions: Record<string, unknown> = {}
    for (const h of input.hooks) {
      questions[h.id] = {
        type: "noul",
        // 问句用英文（Jev 的主语言），规则原文走 rule 字段引用，保持中文不变
        instructions: {
          question: "Does the tool execution or output below violate the rule in `rule`?",
          rule: h.prompt,
        },
        criteria: {
          true: "The output violates the rule described in `rule`.",
          false: "The output does not violate the rule described in `rule`.",
        },
      }
    }

    let res: Response | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(`${baseUrl}/systemone`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ state, model, questions }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        return [] // 超时/连不上 → 判不出
      }
      // 429 限流 / 529 过载：退避一次再试；第二次还不行就判不出
      if ((res.status === 429 || res.status === 529) && attempt === 0) {
        await backoffOnce(res)
        continue
      }
      break
    }
    if (!res || !res.ok) return [] // 401 key 问题 / 422 请求体 / 5xx → 判不出

    let body: SystemOneResponse
    try {
      body = (await res.json()) as SystemOneResponse
    } catch {
      return [] // 响应不是 JSON → 判不出
    }
    const answers = body.answers
    if (!answers || typeof answers !== "object") return []

    const out: HookVerdict[] = []
    for (const h of input.hooks) {
      const a = answers[h.id]
      // 只认 noul 类型的数字答案；缺答案/类型不对 → 这条钩子判不出（不进结果）
      if (!a || a.type !== "noul" || typeof a.noul !== "number" || !Number.isFinite(a.noul)) continue
      const risk = a.noul >= threshold
      out.push(
        risk
          ? { hookId: h.id, pass: false, reason: `TypeSafe 判定存在风险（noul 超过阈值 ${threshold}）` }
          : { hookId: h.id, pass: true },
      )
    }
    return out
  }
}
