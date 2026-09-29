/**
 * T92 日志按大小轮转
 *
 * 问题：`history.jsonl`（每次定时任务一行）、`tui.log`（TUI 调试日志）、`bg/<id>.log`（后台命令输出）
 * 全是只追加、从不清理。跑几个月后单个文件几百 MB——打开慢、备份被拖着走、
 * 用户排查问题时 grep 一遍要等半天。
 *
 * 方案：写入前估算体积，超过上限就把当前文件滚成 `file.1`（保留 N 份）。
 * 读取方只关心「最近若干条」（如 history.jsonl 的「最近一次任务结果」），
 * 滚到 .1 的历史不影响这个语义——主文件里永远是最近的数据。
 *
 * 为什么用「估算 + 定期校正」而不是每次 statSync：
 * 日志是热路径（钩子每步工具都写），每行都 stat 一次是浪费。
 * 这里自己累加字节数，每 64 次写真正 stat 一次校正（别的进程也在写同一文件时会漂移）。
 *
 * 注意：`usage.jsonl` **不**参与轮转——用量图表要对全量数据做聚合，
 * 砍掉旧行等于篡改统计。它走的是 pruneUsage（按会话存活性剪枝）。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"

export interface RotateOptions {
  /** 单文件上限（字节）。默认 4MB——足够装几万行 JSON，又不至于让编辑器打不开 */
  maxBytes?: number
  /** 保留的历史份数（file.1 … file.N），默认 1 */
  keep?: number
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
/** 每写这么多次，真去 stat 一次校正估算 */
const STAT_EVERY = 64

interface Counter {
  bytes: number
  writes: number
}
const counters = new Map<string, Counter>()

/**
 * 超限就把 file 滚成 file.1（依次后移，最老的丢弃）。
 * 返回是否真的滚动了。任何失败都静默返回 false（占用中的文件下次再试）。
 */
export function rotateIfNeeded(file: string, opts: RotateOptions = {}): boolean {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const keep = Math.max(1, Math.floor(opts.keep ?? 1))
  try {
    if (!existsSync(file)) return false
    if (statSync(file).size < maxBytes) return false
    // 从最老的开始往后挪，避免覆盖：file.(keep-1) → file.keep，… ，file → file.1
    for (let i = keep; i >= 1; i--) {
      const dst = `${file}.${i}`
      const src = i === 1 ? file : `${file}.${i - 1}`
      if (i === keep && existsSync(dst)) unlinkSync(dst)
      if (existsSync(src)) renameSync(src, dst)
    }
    return true
  } catch {
    return false
  }
}

/**
 * 追加一行并自动轮转（行尾换行由调用方决定，这里不补）。
 * 日志写入失败绝不能影响主流程，所以整段 try/catch 吞掉。
 */
export function appendLogLine(file: string, line: string, opts: RotateOptions = {}): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    let c = counters.get(file)
    if (!c) {
      let size = 0
      try {
        if (existsSync(file)) size = statSync(file).size
      } catch {
        /* 读不到就当空文件 */
      }
      c = { bytes: size, writes: 0 }
      counters.set(file, c)
    }
    appendFileSync(file, line)
    c.bytes += Buffer.byteLength(line)
    c.writes++
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
    if (c.bytes >= maxBytes || c.writes >= STAT_EVERY) {
      c.writes = 0
      if (rotateIfNeeded(file, opts)) {
        c.bytes = 0
      } else {
        // 没滚（其实没超，或 stat 失败）：用真实大小把估算拉回来
        try {
          if (existsSync(file)) c.bytes = statSync(file).size
        } catch {
          /* 保留估算值 */
        }
      }
    }
  } catch {
    /* 日志失败不影响运行 */
  }
}

/**
 * 目录清理：同后缀文件按 mtime 保留最近 keep 个、且不超过 maxAgeMs，其余删除。
 * 用于 `~/.yyagent/bg/*.log` 这种「每次任务一个文件」的场景（它们各自很小，但数量只增不减）。
 * 返回删除的文件数。
 */
export function sweepOldFiles(dir: string, opts: { keep?: number; maxAgeMs?: number; suffix?: string } = {}): number {
  const keep = Math.max(1, opts.keep ?? 50)
  const maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 3600_000
  const suffix = opts.suffix ?? ""
  try {
    if (!existsSync(dir)) return 0
    const items: Array<{ p: string; mtime: number }> = []
    for (const f of readdirSync(dir)) {
      if (suffix && !f.endsWith(suffix)) continue
      const p = join(dir, f)
      try {
        items.push({ p, mtime: statSync(p).mtimeMs })
      } catch {
        /* 刚被删或没权限，跳过 */
      }
    }
    items.sort((a, b) => b.mtime - a.mtime)
    let n = 0
    items.forEach((it, i) => {
      if (i < keep && Date.now() - it.mtime < maxAgeMs) return
      try {
        unlinkSync(it.p)
        n++
      } catch {
        /* 占用中，下次再清 */
      }
    })
    return n
  } catch {
    return 0
  }
}
