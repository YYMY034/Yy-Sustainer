/**
 * T119：全局并发闸。定时任务和交互会话共享同一个 API 通道——没有全局上限时
 * 「三个任务同时到点 + 用户在对话」就是 N 路并发，轻则限流雪崩（同日 bai 通道实测），
 * 重则费用无预警叠加。本闸给「同时跑的 agent 回合总数」设上限，超出的排队等位。
 *
 * 排队语义：先到先得；waiters 带各自的等待开始时间，供调用方报「已排队 Ns」。
 * 释放时唤醒队首（不抢锁、不插队）。纯逻辑，无 I/O，可被单测直接钉住。
 */

export class RunGate {
  private max: number
  private active = 0
  private waiters: Array<{ resolve: () => void; since: number }> = []

  constructor(max: number) {
    // max<=0 = 不设限（acquire 永远直接放行）
    this.max = Math.max(0, Math.floor(max))
  }

  setMax(max: number): void {
    this.max = Math.max(0, Math.floor(max))
    // 上调时把等待者按容量放进来
    this.pump()
  }

  get capacity(): number {
    return this.max
  }

  get running(): number {
    return this.active
  }

  get waiting(): number {
    return this.waiters.length
  }

  /** 立即可跑（无上限或有余位） */
  get hasSlot(): boolean {
    return this.max <= 0 || this.active < this.max
  }

  /** 当前最长等待毫秒（0 = 没人在等） */
  get maxWaitMs(): number {
    return this.waiters.length ? Date.now() - this.waiters[0].since : 0
  }

  /** 占一个位。没位就等——resolve 由 release 触发 */
  async acquire(since = Date.now()): Promise<void> {
    if (this.hasSlot) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.waiters.push({ resolve, since }))
    // 注意：这里**不再** active++——pump 唤醒时已先占位计数。两边都加会把 active 虚增一倍，
    // 第二次 release 时名额被多算，队首永远等不到唤醒（首版实现的真实 bug，调试输出抓的现行）。
  }

  /** 释放一个位，并唤醒队首等待者（pump 里 ++） */
  release(): void {
    this.active = Math.max(0, this.active - 1)
    this.pump()
  }

  private pump(): void {
    while (this.waiters.length && (this.max <= 0 || this.active < this.max)) {
      const w = this.waiters.shift()!
      this.active++
      w.resolve()
    }
  }
}
