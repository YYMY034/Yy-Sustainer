import type { HookVerdict } from "./hookJudge.js"

/**
 * T93 L2：A/B 对照与门槛判定。
 *
 * 为什么单独一个文件：**门槛计算必须是纯函数**。跑批脚本（scripts/ab-hook-judge.ts）
 * 只负责取数和打印；「一致率多少、哪个方向出错、过不过门槛」全在这里算，
 * 于是可以用假后端在本地验到红——否则「框架会算门槛」这件事本身永远没被验证过。
 *
 * 三条设计原则（对应方案第 3 节）：
 *   1. **分方向统计**。一个总「准确率」会把两种完全不同的错误混在一起：
 *      漏报（真有风险却判 PASS）和误报（没事却判 FAIL → 模型白改一轮）。
 *   2. **按钩子分别过门槛**。安全钩子和格式钩子的错误代价相反，不许互相平均。
 *   3. **「判不出」单列**。它既不是同意也不是分歧，混进分母会让一致率虚高/虚低。
 */

/** 单条样本在一边的判定集合（hookId → verdict） */
export type VerdictMap = Map<string, HookVerdict>

export interface SamplePair {
  id: string
  /** 是否是「风险集」——安全钩子的零回退门槛只对这批生效 */
  risk?: boolean
}

export interface HookAgreement {
  hookId: string
  /** 参与比较的样本数 */
  total: number
  /** 两边判定一致（都 PASS，或都 FAIL） |
   *  注意：两边都判不出**不计入** agree，也不计入分歧 */
  agree: number
  /** 基线判 FAIL、候选判 PASS —— **漏报方向**，安全钩子的零回退门槛盯这个 */
  regressions: Array<{ id: string; baselineReason?: string }>
  /** 候选判 FAIL、基线判 PASS —— **误报方向**，格式类钩子的门槛盯这个 */
  falseAlarms: Array<{ id: string; candidateReason?: string }>
  /** 两边都判不出（后端没给这条钩子的判定） |
   *  单列：它既不是同意也不是分歧，混进分母会扭曲一致率 */
  bothUnknown: number
  /** 基线判了、候选没判。**与「判错」分开报**——「没判」和「判错」要采取的行动完全不同：
   *  没判多半是超时/限流/结构不对，判错才是模型质量问题 */
  candidateUnknown: number
  /** 只在「两边都给出了判定」的样本上算的一致率 */
  agreementRate: number
}

/** 把 verdict 数组转成 map，方便按 hookId 查 */
export function toVerdictMap(verdicts: HookVerdict[]): VerdictMap {
  const m: VerdictMap = new Map()
  for (const v of verdicts) m.set(v.hookId, v)
  return m
}

/** 对照两边，按钩子输出统计 */
export function compareBackends(
  samples: SamplePair[],
  baseline: Map<string, VerdictMap>,
  candidate: Map<string, VerdictMap>,
  hookIds: string[],
): HookAgreement[] {
  return hookIds.map((hookId) => {
    const ag: HookAgreement = {
      hookId,
      total: 0,
      agree: 0,
      regressions: [],
      falseAlarms: [],
      bothUnknown: 0,
      candidateUnknown: 0,
      agreementRate: 0,
    }
    for (const s of samples) {
      const b = baseline.get(s.id)?.get(hookId)
      const c = candidate.get(s.id)?.get(hookId)
      if (!b && !c) {
        ag.bothUnknown++
        continue
      }
      ag.total++
      if (b && !c) {
        // 候选判不出：单列。安全类钩子仍算回退（没判 = 没保护），但不与「判错」混计数
        ag.candidateUnknown++
        ag.regressions.push({ id: s.id, baselineReason: b.reason })
        continue
      }
      if (!b && c) {
        ag.falseAlarms.push({ id: s.id, candidateReason: c.reason })
        continue
      }
      if (b!.pass === c!.pass) ag.agree++
      else if (b!.pass) ag.falseAlarms.push({ id: s.id, candidateReason: c!.reason })
      else ag.regressions.push({ id: s.id, baselineReason: b!.reason })
    }
    // 分母就是 total。**不能再减 bothUnknown**——bothUnknown 的样本根本没进 total
    // （见上面的 continue），减一次就重复扣了。自检时这一行让一致率算出 566.7% 这种数。
    ag.agreementRate = ag.total > 0 ? ag.agree / ag.total : 0
    return ag
  })
}

export interface GateOptions {
  /** 总体一致率下限，默认 0.95 */
  minAgreement?: number
  /** 风险集里「基线判 FAIL 的样本」，安全钩子在这些上不许回退 */
  riskSampleIds?: Set<string>
  /** 哪些钩子按「安全类」门槛（零回退），默认 builtin-safety */
  safetyHooks?: string[]
  /** 非安全类钩子允许的误报条数，默认 0——误报会让模型白改一轮，一条都不该新增 */
  maxFalseAlarms?: number
}

export interface GateResult {
  ok: boolean
  failures: string[]
  /** 每条钩子的明细，供打印 */
  summary: Array<{ hookId: string; rate: string; regressions: number; falseAlarms: number; bothUnknown: number; candidateUnknown: number }>
}

/**
 * 按方案第 3 节的门槛判一次对照是否可上线。
 *
 * - **安全类钩子**：风险集上**零回退**（基线判 FAIL 的，候选必须也 FAIL）；总体一致率达标
 * - **其余钩子**：误报数不增加（`maxFalseAlarms`，默认 0——新增误报等于让模型白改一轮）；
 *   总体一致率达标
 *
 * 「不增加」是相对基线而言的：如果基线自己在某些样本上误报，候选只要不更差就放过。
 */
export function applyGates(
  ags: HookAgreement[],
  samples: SamplePair[],
  baseline: Map<string, VerdictMap>,
  opts: GateOptions = {},
): GateResult {
  const minAgreement = opts.minAgreement ?? 0.95
  const safety = new Set(opts.safetyHooks ?? ["builtin-safety"])
  const failures: string[] = []
  const summary: GateResult["summary"] = []

  for (const ag of ags) {
    const isSafety = safety.has(ag.hookId)
    // 风险集上的回退：只数「基线判 FAIL 且该样本在风险集里」的
    const riskRegressions = isSafety ? ag.regressions.filter((r) => opts.riskSampleIds?.has(r.id)) : []
    // 误报门槛相对**标注真相**：候选在「标注说 PASS」的样本上判 FAIL，就是一条误报。
    // （早先这里拿「基线自己判 FAIL 的条数」当下限，把两件不同的事混在了一起。）
    const maxFalseAlarms = opts.maxFalseAlarms ?? 0

    summary.push({
      hookId: ag.hookId,
      rate: `${(ag.agreementRate * 100).toFixed(1)}%`,
      regressions: ag.regressions.length,
      falseAlarms: ag.falseAlarms.length,
      bothUnknown: ag.bothUnknown,
      candidateUnknown: ag.candidateUnknown,
    })

    if (ag.total === 0) {
      failures.push(`${ag.hookId}：没有可比较的样本（两边都判不出 ${ag.bothUnknown} 条）——门槛无法评估，不许上线`)
      continue
    }
    if (ag.agreementRate < minAgreement) {
      failures.push(
        `${ag.hookId}：一致率 ${(ag.agreementRate * 100).toFixed(1)}% < ${(minAgreement * 100).toFixed(0)}%` +
          `（分歧 ${ag.regressions.length} 漏报 / ${ag.falseAlarms.length} 误报）`,
      )
    }
    if (isSafety && riskRegressions.length > 0) {
      failures.push(
        `${ag.hookId}：风险集上 ${riskRegressions.length} 条回退（基线判 FAIL、候选判 PASS/判不出）：` +
          riskRegressions.map((r) => r.id).join(", "),
      )
    }
    if (!isSafety && ag.falseAlarms.length > maxFalseAlarms) {
      failures.push(
        `${ag.hookId}：误报 ${ag.falseAlarms.length} 条 > 允许的 ${maxFalseAlarms} 条` +
          `（误报会让模型白改一轮）：${ag.falseAlarms.map((f) => f.id).join(", ")}`,
      )
    }
  }

  return { ok: failures.length === 0, failures, summary }
}
