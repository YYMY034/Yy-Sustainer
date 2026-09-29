// T66 钩子执行器：每步工具执行完后，启用的钩子调用模型检查一次输出；
// 不通过则把修正提示追加进工具结果（模型下一步自纠）。fail-open：钩子出错不阻断主流程。
// T82 性能：所有启用钩子合并为**一次** LLM 调用（原每钩子各发一次，串行翻倍耗时/token）。
// T93 L1：判定抽出成 HookJudge 后端（hookJudge.ts）——换更便宜的判定模型只是换一个实现，
// 且 replay 后端让 A/B 框架在没有外部通道时也能闭环。本文件只负责策略与渲染。
import { loadConfig, type HookConfig } from "./config.js"
import { pickJudge, type HookVerdict } from "./hookJudge.js"

/** 输出采样上限：判定只需要看开头，全量既贵又稀释注意力 */
const SAMPLE_CHARS = 2000

/** 一次 runHooksOnTool 内复用同一个后端实例（replay 的样本库只需加载一次） */
const judgeCache = new Map<string, ReturnType<typeof pickJudge>>()

function judgeFor(hooks: HookConfig[]): ReturnType<typeof pickJudge> {
  // 同一批钩子共用一个后端实例：按第一个钩子的配置决定（A/B 时同批会同后端）
  const key = hooks.map((h) => h.id).join(",")
  let j = judgeCache.get(key)
  if (!j) {
    j = pickJudge(hooks[0].id)
    judgeCache.set(key, j)
  }
  return j
}

/**
 * 对单次工具输出跑全部启用钩子；不通过则在输出后追加修正提示（模型下一步可见并自纠）。
 *
 * 判定缺失时的策略（按 `HookConfig.strict`，**不由后端决定**）：
 *   - strict=false（默认）：判不出 = 通过。fail-open，别打断干活。
 *   - strict=true：判不出 = 存疑，追加「未能完成检查，请自行复核…」提示。
 *     这是给安全类钩子用的——旧实现里「找不到该钩子的行即按通过」，
 *     模型答歪/超时/返回空都等于「没风险」，方向是反的。
 */
export async function runHooksOnTool(toolName: string, output: string): Promise<string> {
  const cfg = loadConfig()
  const hooks = (cfg.hooks ?? []).filter((h) => h.enabled)
  if (!hooks.length || typeof output !== "string" || !output.trim()) return output

  const sample = output.length > SAMPLE_CHARS ? output.slice(0, SAMPLE_CHARS) + "…(已截断)" : output
  let verdicts: HookVerdict[] = []
  try {
    verdicts = await judgeFor(hooks).judge({ tool: toolName, sample, hooks })
  } catch {
    verdicts = [] // 后端炸了 → 全判不出，走下面的 strict 策略，绝不阻断主流程
  }
  const byId = new Map(verdicts.map((v) => [v.hookId, v]))

  const notes: string[] = []
  for (const h of hooks) {
    const v = byId.get(h.id)
    if (v && !v.pass) {
      notes.push(`【钩子·${h.name}】${(v.reason ?? "").trim().slice(0, 120) || "未通过检查"}`)
    } else if (!v && h.strict) {
      notes.push(`【钩子·${h.name}】本次未能完成检查（判定缺失或超时），请自行复核后再继续`)
    }
  }
  if (!notes.length) return output
  return output + "\n\n" + notes.map((f) => `【钩子检查未通过】${f}——请立即修正后续行为。`).join("\n")
}

/** 测试/热更新用：清掉后端实例缓存（配置改了之后下次会按新配置挑） */
export function resetHookJudges(): void {
  judgeCache.clear()
}
