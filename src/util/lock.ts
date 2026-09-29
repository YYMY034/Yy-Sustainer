/**
 * T92 跨进程文件锁
 *
 * 为什么需要：T91 的原子写（tmp + rename）只解决了「半个文件」——读者不会看到写了一半的 JSON，
 * 但**读-改-写**这个复合操作依然不是原子的。会话 index 就是典型：
 * gateway 进程和 TUI 进程（或两个 gateway 窗口）同时 `readIndex() → 改 → writeIndex()`，
 * 后写的那个把先写的整个覆盖掉，先写的那次新建/重命名会话凭空消失。
 *
 * 方案：用 `open(lockFile, "wx")` 的**原子创建**语义做互斥锁——同一个路径只有一个进程能创建成功。
 * 拿不到就自旋等待；持锁进程崩溃留下的陈旧锁按 mtime 年龄回收。
 *
 * 为什么不用 `proper-lockfile` 之类的依赖：这里的临界区只有「读一个小 JSON + 写回」，
 * 毫秒级，自旋锁完全够用，不值得为它引入依赖树。
 *
 * 降级策略：等待超时后**不抛错**，打一条警告后无锁继续。
 * 理由——锁只保护一次 index 更新，最坏结果是丢一次列表变更（下一次 persist 会重新写全量）；
 * 而抛错会让「新建会话」这种基础功能直接不可用，代价更大。
 */
import { closeSync, openSync, statSync, unlinkSync, writeSync } from "node:fs"

/** 同步 sleep：`Atomics.wait` 在超时返回，不占 CPU（不能用 busy loop，会把 TUI 主线程烤干） */
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))
export function sleepSync(ms: number): void {
  try {
    Atomics.wait(SLEEP_BUF, 0, 0, ms)
  } catch {
    /* 极端环境下 Atomics.wait 不可用（如主线程被禁）→ 退化成不 sleep，靠外层重试次数兜底 */
  }
}

export interface FileLockOptions {
  /** 自旋等待上限（毫秒），超过后降级为无锁执行 */
  timeoutMs?: number
  /** 超过这个年龄的锁视为陈旧（持锁进程已崩溃），直接回收 */
  staleMs?: number
  /** 自旋间隔（毫秒） */
  intervalMs?: number
  /** 降级时是否静默（回归脚本里用来断言行为） */
  quiet?: boolean
}

export interface FileLockResult<T> {
  value: T
  /** true = 本次拿到了锁；false = 等待超时后降级为无锁执行 */
  locked: boolean
}

/**
 * 在 lockFile 的保护下执行 fn。
 * 返回 `{ value, locked }`，locked=false 表示这次是降级执行（调用方可据此记日志）。
 */
export function withFileLock<T>(lockFile: string, fn: () => T, opts: FileLockOptions = {}): FileLockResult<T> {
  const timeoutMs = opts.timeoutMs ?? 3000
  const staleMs = opts.staleMs ?? 10_000
  const intervalMs = opts.intervalMs ?? 25
  const deadline = Date.now() + timeoutMs

  let fd: number | null = null
  for (;;) {
    try {
      // "wx" = 只在文件不存在时创建，创建动作本身是原子的
      fd = openSync(lockFile, "wx")
      try {
        writeSync(fd, `${process.pid} ${Date.now()}\n`)
      } catch {
        /* 写持有者信息失败不影响互斥语义 */
      }
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        // 目录不存在等意外错误：降级执行，别把调用方拖死
        if (!opts.quiet) console.error(`[锁] 无法创建 ${lockFile}（${(e as Error).message}），本次无锁执行`)
        return { value: fn(), locked: false }
      }

      // 锁被占：先看是不是陈旧锁（持锁进程被杀，锁文件留在盘上）
      try {
        const st = statSync(lockFile)
        if (Date.now() - st.mtimeMs > staleMs) {
          try {
            unlinkSync(lockFile)
          } catch {
            /* 别人抢先回收了，下一轮重试即可 */
          }
          continue
        }
      } catch {
        // 锁文件刚被释放（statSync 抛 ENOENT）→ 立刻重试，不 sleep
        continue
      }

      if (Date.now() > deadline) {
        if (!opts.quiet) console.error(`[锁] 等待 ${lockFile} 超时（${timeoutMs}ms），本次无锁执行`)
        return { value: fn(), locked: false }
      }
      sleepSync(intervalMs)
    }
  }

  try {
    return { value: fn(), locked: true }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(lockFile)
      } catch {
        /* 已被陈旧回收流程删掉 */
      }
    }
  }
}
