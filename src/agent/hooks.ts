// T66 钩子执行器：每步工具执行完后，启用的钩子调用模型检查一次输出；
// 不通过则把修正提示追加进工具结果（模型下一步自纠）。fail-open：钩子出错不阻断主流程。
import { generateText } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { loadConfig, resolveModel } from "./config.js"
import { composeSystem } from "./prompt.js"

const CHECK_TIMEOUT_MS = 25000
const SAMPLE_CHARS = 2000

/** 对单次工具输出跑全部启用钩子；不通过则在输出后追加修正提示（模型下一步可见并自纠） */
export async function runHooksOnTool(toolName: string, output: string): Promise<string> {
  const cfg = loadConfig()
  const hooks = (cfg.hooks ?? []).filter((h) => h.enabled)
  if (!hooks.length || typeof output !== "string" || !output.trim()) return output
  let providerName = ""
  let modelId = ""
  let client: ReturnType<typeof createOpenAICompatible> | null = null
  let model: ReturnType<ReturnType<typeof createOpenAICompatible>["chatModel"]> | null = null
  try {
    const resolved = resolveModel(cfg, cfg.model)
    providerName = resolved.providerName
    modelId = resolved.modelId
    client = createOpenAICompatible({ name: providerName, baseURL: resolved.provider.baseURL, apiKey: resolved.provider.apiKey })
    model = client.chatModel(modelId)
  } catch {
    return output // 无可用模型 → fail-open
  }
  const sample = output.length > SAMPLE_CHARS ? output.slice(0, SAMPLE_CHARS) + "…(已截断)" : output
  const fails: string[] = []
  for (const h of hooks) {
    try {
      const r = await generateText({
        model: model ?? client!.chatModel(modelId),
        // T73：同样注入基础层；严格输出契约放 role 槽（作用域声明保证「只回 PASS / FAIL」优先）
        system: composeSystem({
          role: "你是钩子检查器。根据钩子要求检查给定内容，只回复 PASS，或回复「FAIL：原因（简短）」。不要附加任何其他文字。",
        }),
        prompt: `【钩子】${h.name}\n【要求】${h.prompt}\n【工具】${toolName}\n【内容】\n${sample}`,
        abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      })
      // T73 解析容错：先剥 thinking 块，再按关键字找 FAIL——即使模型多说了前言/结论也不漏判（找不到即按通过）
      const txt = (r.text ?? "").replace(/<(thinking|think)>[\s\S]*?<\/\1>/gi, "").trim()
      const m = txt.match(/FAIL[:：]?\s*([^\n]*)/i)
      if (m) fails.push(`【钩子·${h.name}】${(m[1] ?? "").trim().slice(0, 120) || "未通过检查"}`)
    } catch {
      /* 单个钩子超时/报错 → fail-open */
    }
  }
  if (!fails.length) return output
  return (
    output +
    "\n\n" +
    fails.map((f) => `【钩子检查未通过】${f}——请立即修正后续行为。`).join("\n")
  )
}
