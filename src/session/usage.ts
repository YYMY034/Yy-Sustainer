/**
 * T45 用量账本（usage ledger）
 *
 * 为什么需要它：`/api/sessions` 的 `meta.usage` 只有「整会话累计」一个数——
 * 没有日期、没有模型维度，画不出「每日 token 热力图」和「按模型的累计用量环形图」。
 *
 * 方案：把每一轮的 token 消耗按行追加到 `~/.yyagent/usage.jsonl`（append-only，坏行可跳过），
 * 一行 = 一轮 = {ts, sessionId, model, in, out, cached, steps}。
 * 这样「按日」「按模型」都只是对同一份原始数据做一次聚合，两个图共用一份真相。
 *
 * 存量数据怎么办：账本上线前的历史消耗只存在于各会话的 `meta.usage` 里。
 * 靠 `backfill()` 一次性回填：拿会话累计总量，按其 assistant 消息所在的「天」摊分
 * （每天分到该天消息数 / 总消息数 的份额），并把总额拆到每一条上，保证**总和不变**。
 * 回填出来的行带 `approx: true`，前端可以据此说明「含估算」，不冒充真实逐轮记录。
 * 回填做过哪几个会话记在 `~/.yyagent/usage-backfill.json`，因此幂等、只做一次。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { listSessions, loadSession } from "./store.js"

export interface UsageTurn {
  /** 该轮完成时间（毫秒） */
  ts: number
  sessionId: string
  /** 本轮实际使用的模型 spec（如 sensenova/glm-5.2）；旧会话回填时取 assistant 消息上的 model */
  model: string
  in: number
  out: number
  cached: number
  steps: number
  /** true = 由存量会话 cumulative usage 摊分而来的近似值，不是真实逐轮记录 */
  approx?: boolean
}

/** 聚合桶：total 恒 = in + out（cached 是 in 里命中缓存的那部分，不重复计入） */
export interface UsageAgg {
  in: number
  out: number
  cached: number
  total: number
  turns: number
}

export interface DailyUsage {
  /** "YYYY-MM-DD" → 该日聚合 */
  byDate: Record<string, UsageAgg>
  grand: UsageAgg
  /** 最早 / 最晚有数据的日子（"YYYY-MM-DD"），无数据时为空串 */
  from: string
  to: string
  /** 数据里是否混有回填的近似值 */
  hasApprox: boolean
  /** 原始账本行数（便于排查） */
  rows: number
}

export interface ModelUsage {
  model: string
  in: number
  out: number
  cached: number
  total: number
  turns: number
}

export interface ModelUsageResult {
  models: ModelUsage[]
  grand: UsageAgg
  hasApprox: boolean
  rows: number
}

const ROOT = join(homedir(), ".yyagent")
const LEDGER = join(ROOT, "usage.jsonl")
const BACKFILL_MARK = join(ROOT, "usage-backfill.json")

const emptyAgg = (): UsageAgg => ({ in: 0, out: 0, cached: 0, total: 0, turns: 0 })

function addInto(a: UsageAgg, r: UsageTurn): void {
  const i = Number(r.in) || 0
  const o = Number(r.out) || 0
  a.in += i
  a.out += o
  a.cached += Number(r.cached) || 0
  a.total += i + o
  a.turns += 1
}

/** 本地日期键（用本机时区，和用户看日历的直觉一致——不用 toISOString 的 UTC） */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 进程内缓存：账本只追加，读一次即可（appendUsage 会同步往里 push） */
let cache: UsageTurn[] | null = null

export function appendUsage(row: UsageTurn): void {
  try {
    mkdirSync(ROOT, { recursive: true })
    appendFileSync(LEDGER, JSON.stringify(row) + "\n")
  } catch {
    /* 账本落盘失败不能影响正常对话 */
  }
  if (cache) cache.push(row)
}

export function readUsage(): UsageTurn[] {
  if (cache) return cache
  const out: UsageTurn[] = []
  try {
    if (existsSync(LEDGER)) {
      for (const line of readFileSync(LEDGER, "utf8").split(/\r?\n/)) {
        const s = line.trim()
        if (!s) continue
        try {
          const r = JSON.parse(s) as UsageTurn
          if (r && typeof r.ts === "number") out.push(r)
        } catch {
          /* 半边写入/手工编辑导致坏行：跳过，不让一行坏数据废掉整张图 */
        }
      }
    }
  } catch {
    /* 读不到就当空账本 */
  }
  cache = out
  return out
}

/**
 * T66 账本剪枝：只保留 validIds 里会话的行，重写 LEDGER 并刷新缓存。
 * 用途——①删除会话时同步清掉它的账本行，②网关启动时清历史孤儿行（会话已不存在但行还留着），
 * 两者都是为了让不变量「账本总额 === 会话累计总额」恒成立（check-t45 F4 活体断言盯着）。
 */
export function pruneUsage(validIds: Set<string>): void {
  const rows = readUsage()
  const kept = rows.filter((r) => validIds.has(r.sessionId))
  if (kept.length === rows.length) return // 无孤儿，不重写文件
  try {
    mkdirSync(ROOT, { recursive: true })
    writeFileSync(LEDGER, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""))
  } catch {
    /* 剪枝失败不阻断启动/删除；下次启动再试 */
  }
  cache = kept
}

/** 按日聚合（两个图的「每日」口径都走这里） */
export function usageDaily(): DailyUsage {
  const rows = readUsage()
  const byDate: Record<string, UsageAgg> = {}
  const grand = emptyAgg()
  let hasApprox = false
  let from = ""
  let to = ""
  for (const r of rows) {
    const k = dayKey(r.ts)
    const b = (byDate[k] ??= emptyAgg())
    addInto(b, r)
    addInto(grand, r)
    if (r.approx) hasApprox = true
    if (!from || k < from) from = k
    if (!to || k > to) to = k
  }
  return { byDate, grand, from, to, hasApprox, rows: rows.length }
}

/** 按模型聚合（环形图口径） */
export function usageByModel(): ModelUsageResult {
  const rows = readUsage()
  const map = new Map<string, ModelUsage>()
  const grand = emptyAgg()
  let hasApprox = false
  for (const r of rows) {
    const key = r.model || "（未知模型）"
    let m = map.get(key)
    if (!m) {
      m = { model: key, in: 0, out: 0, cached: 0, total: 0, turns: 0 }
      map.set(key, m)
    }
    const i = Number(r.in) || 0
    const o = Number(r.out) || 0
    m.in += i
    m.out += o
    m.cached += Number(r.cached) || 0
    m.total += i + o
    m.turns += 1
    addInto(grand, r)
    if (r.approx) hasApprox = true
  }
  // 用量大的排前面（环形图图例顺序 = 占比从大到小，与参考截图一致）
  const models = [...map.values()].sort((a, b) => b.total - a.total)
  return { models, grand, hasApprox, rows: rows.length }
}

interface BackfillMark {
  version: number
  done: string[]
}

function readMark(): BackfillMark {
  try {
    const j = JSON.parse(readFileSync(BACKFILL_MARK, "utf8")) as BackfillMark
    return { version: j?.version ?? 0, done: Array.isArray(j?.done) ? j.done : [] }
  } catch {
    return { version: 0, done: [] }
  }
}

function writeMark(m: BackfillMark): void {
  try {
    mkdirSync(ROOT, { recursive: true })
    writeFileSync(BACKFILL_MARK, JSON.stringify(m, null, 2))
  } catch {
    /* ignore */
  }
}

/**
 * 一次性回填：把账本上线前各会话的累计 usage 摊到「消息所在的天」。
 * 摊分规则：会话有 N 条 assistant 消息，则每条分到 1/N —— 同一天的多条自然把该天份额累起来；
 * 余数补在最后一条上，保证 **各字段总和与 meta.usage 完全相等**（不做浮点近似丢数）。
 * 没有任何 assistant 消息的会话（比如只用过工具就中断）退化为一条：整笔记在 updatedAt 那天。
 * 返回本次真正回填的会话数。
 */
export function backfillUsage(): number {
  const mark = readMark()
  const done = new Set(mark.done)
  const metas = listSessions()
  // T74 修正：幂等的底线是「账本里已经有这个会话的行」，不能只信 mark 文件——mark 丢失或
  // 未落盘（上一轮网关被杀）时，已经记过真实账的会话会被再补一条 approx 行，账本总额凭空翻倍，
  // 破坏 check-t45 F4「账本总额 === 会话累计总额」的守恒不变量（本轮实测踩到：某会话 49670 vs 24835）。
  const ledgerSids = new Set(readUsage().map((r) => r.sessionId))
  let n = 0
  for (const meta of metas) {
    if (done.has(meta.id)) continue
    if (ledgerSids.has(meta.id)) {
      done.add(meta.id) // 已有账 → 跳过回填，顺手把 mark 补齐
      continue
    }
    const u = meta.usage
    if (!u) {
      done.add(meta.id)
      continue
    }
    const file = loadSession(meta.id)
    const assists = (file?.messages ?? []).filter((m) => m.role === "assistant")
    if (!assists.length) {
      appendUsage({
        ts: meta.updatedAt ?? Date.now(),
        sessionId: meta.id,
        model: meta.model || "（未知模型）",
        in: u.in ?? 0,
        out: u.out ?? 0,
        cached: u.cached ?? 0,
        steps: u.steps ?? 0,
        approx: true,
      })
      done.add(meta.id)
      n++
      continue
    }
    const N = assists.length
    // 余数补在最后一条：整数里做余数分配，避免 Math.round 把总量改掉
    const slice = (total: number, k: number) => (k === N - 1 ? total - Math.floor(total / N) * (N - 1) : Math.floor(total / N))
    assists.forEach((m, k) => {
      appendUsage({
        ts: m.ts ?? meta.updatedAt ?? Date.now(),
        sessionId: meta.id,
        model: m.model || meta.model || "（未知模型）",
        in: slice(u.in ?? 0, k),
        out: slice(u.out ?? 0, k),
        cached: slice(u.cached ?? 0, k),
        steps: slice(u.steps ?? 0, k),
        approx: true,
      })
    })
    done.add(meta.id)
    n++
  }
  writeMark({ version: 1, done: [...done] })
  return n
}
