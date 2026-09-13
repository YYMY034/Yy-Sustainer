import { tool } from "ai"
import { z } from "zod"

export interface PendingQuestion {
  question: string
  options?: string[]
  defaultOption?: string
}

interface Waiting {
  pending: PendingQuestion
  resolve: (answer: string) => void
}

/**
 * 提问桥：agent 的选择题/澄清问题 ↔ TUI 用户应答。
 * - 同一时间只有一个活跃问题（TUI 渲染它）
 * - agent 并行发起的多个问题自动排队，依次应答
 */
export class QuestionBroker {
  private current: Waiting | null = null
  private queue: Array<{ p: PendingQuestion; resolve: (a: string) => void }> = []

  ask(p: PendingQuestion): Promise<string> {
    if (this.current) {
      return new Promise((resolve) => this.queue.push({ p, resolve }))
    }
    return this.activate(p)
  }

  private activate(p: PendingQuestion): Promise<string> {
    return new Promise((resolve) => {
      this.current = { pending: p, resolve }
    })
  }

  answer(answer: string): void {
    if (!this.current) return
    const w = this.current
    this.current = null
    w.resolve(answer)
    // 队列中的下一个问题自动成为活跃问题，由下一次 answer() 解答
    const next = this.queue.shift()
    if (next) this.activate(next.p)
  }

  get queueLength(): number {
    return this.queue.length
  }

  get pending(): PendingQuestion | null {
    return this.current?.pending ?? null
  }

  /** 用户停止/撤回时调用：当前挂起的问题（含排队中的）全部按默认项/放弃应答，agent 不再卡在等待 */
  cancel(): void {
    const w = this.current
    this.current = null
    const queued = this.queue.splice(0)
    if (w) w.resolve(w.pending.defaultOption ?? w.pending.options?.[0] ?? "取消")
    for (const q of queued) q.resolve(q.p.defaultOption ?? q.p.options?.[0] ?? "取消")
  }
}

export const broker = new QuestionBroker()

export function makeAskTool(): Record<string, unknown> {
  return {
    ask: tool({
      description:
        "向用户发起选择题或澄清提问（仅交互模式可用）。存在多条实现路径、需求有歧义、开始新项目时使用：给出 2-5 个候选项并标出推荐项，用户也可自由输入。一次一个问题；多个问题请分多次调用。",
      inputSchema: z.object({
        question: z.string().describe("要问用户的问题，含必要的背景与各选项差异说明"),
        options: z.array(z.string()).min(2).max(5).optional().describe("候选项列表（2-5 个），每项一句话说清这条路径是什么"),
        defaultOption: z.string().optional().describe("推荐项，必须是 options 之一；用户直接回车即选它"),
      }),
      async execute({ question, options, defaultOption }) {
        const { toolCtx } = await import("./tools.js")
        const broker = toolCtx.getStore()?.broker
        if (!broker) {
          const fallback = defaultOption ?? options?.[0]
          return fallback
            ? `[无用户在线] 无人值守模式：已按推荐方案执行——${fallback}。如与预期不符请在最终报告中说明。`
            : "[无用户在线] 无人值守模式：按最合理的方式自行决策并继续，不要提问。"
        }
        const opts = options?.length ? options : undefined
        const def = defaultOption && opts?.includes(defaultOption) ? defaultOption : undefined
        const answer = await broker.ask({ question, options: opts, defaultOption: def })
        const t = answer.trim()
        if (opts && /^\d+$/.test(t)) {
          const idx = Number(t) - 1
          if (idx >= 0 && idx < opts.length) return `用户选择了：${opts[idx]}`
        }
        return `用户的回答：${answer}`
      },
    }),
  }
}
