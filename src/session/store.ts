import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { normalize } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import type { CoreMessage } from "ai"
import { sleepSync, withFileLock } from "../util/lock.js"

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  cwd: string
  model?: string
  /** 上下文占用百分比（红绿灯缓存，切回会话不丢） */
  ctxPct?: number
  /** 会话累计 token 消耗（deepseek 风格统计：输入/输出/缓存命中 + 请求轮数） */
  usage?: { in: number; out: number; cached: number; turns: number; steps: number }
  /**
   * T93 长任务模式：把收敛时限放宽到 30 分钟。
   * **存在会话上而不是内存里**——原先有两份来源：config.longTask（TUI 写、没人读的死配置）
   * 和 gateway 内存 Set（重启即失效）。合并成这一份，两处入口（Web/TUI）读写同一个字段。
   */
  longTask?: boolean
  /**
   * T93 上一轮真实输入的 token 数（含系统提示 + 工具定义 + 消息框架）。
   * 压缩判定用它做下限：只数消息正文会漏掉系统提示与工具定义的开销，导致压得太晚。
   */
  lastInputTokens?: number
  /**
   * MCP 浏览器工具会话级开关（白皮书 10.29）。三态：
   *   true=强制加载 / false=强制不加载 / undefined=按用户输入意图自动判。
   * 存在会话上而不是 config 里——手动开一次只影响这个会话，且重启不丢。
   */
  mcpOn?: boolean
}

export interface StoredMessage {
  /** T55："system" = 系统提示（如模型切换），仅入库展示用，toCoreMessages 会过滤、绝不进 LLM 上下文 */
  role: "user" | "assistant" | "system"
  content: string
  ts: number
  tools?: string[]
  /** 用户消息附带的图片（dataUrl，与 content 中 [图片n] 占位一一对应），前端渲染成小气泡 */
  images?: string[]
  /** assistant 消息：本次生成实际使用的模型 spec（如 sensenova/glm-5.2），前端昵称显示用 */
  model?: string
  steps?: Array<{ name: string; argsSummary: string; input?: string; output?: string }>
  /** D6：本轮模型修改的文件（不含快照——快照在网关内存，撤销经 /api/sessions/:id/undo 走服务端） */
  fileEdits?: Array<{ path: string; kind: "write" | "edit" }>
  /** 用户对本条 assistant 回复的评分（点赞/点踩），进入会话记忆供模型感知 */
  feedback?: "up" | "down"
  /** T137：本轮 token 消耗（in/out 输入输出，cached 其中缓存命中部分）——前端操作条尾部显示 */
  usage?: { in: number; out: number; cached: number }
}

interface SessionFile {
  meta: SessionMeta
  messages: StoredMessage[]
}

const ROOT = join(homedir(), ".yyagent", "sessions")
const INDEX = join(ROOT, "index.json")
// T92 跨进程锁：index 的「读-改-写」必须互斥，否则 gateway / TUI / sidecar 并发时会互相覆盖列表
const INDEX_LOCK = join(ROOT, "index.json.lock")

function ensure(): void {
  mkdirSync(ROOT, { recursive: true })
  sweepStaleTemp()
}

/** 进程内只扫一次：清理上次崩溃留下的 .tmp（60 秒内刚写的可能正被别的进程用，不动） */
let swept = false
function sweepStaleTemp(): void {
  if (swept) return
  swept = true
  try {
    for (const f of readdirSync(ROOT)) {
      if (!f.endsWith(".tmp")) continue
      const p = join(ROOT, f)
      try {
        if (Date.now() - statSync(p).mtimeMs > 60_000) unlinkSync(p)
      } catch {
        /* 被别的进程抢先删了 */
      }
    }
  } catch {
    /* 目录读不了就算了，不影响主流程 */
  }
}

/**
 * T91 原子写：先写临时文件再 rename 覆盖。
 * 历史版本直接 writeFileSync 目标文件——写到一半（进程被杀/磁盘满/并发写）就留下半个 JSON，
 * 而 loadSession 的 JSON.parse 没有兜底，结果整个会话打不开。
 * rename 在同一分区上是原子操作，读者要么看到旧文件、要么看到完整新文件，不存在中间态。
 *
 * T92：tmp 名带 pid + 随机后缀。原来固定叫 `${file}.tmp`——两个进程同时写同一文件时会
 * 用同一个临时文件互相踩（A 写一半、B 覆盖、A rename 走了 B 的内容）。失败时顺手清掉自己的 tmp。
 */
function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameWithRetry(tmp, file)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 没建成功就不用删 */
    }
    throw e
  }
}

/**
 * Windows 上 rename 覆盖目标文件时，若目标正被杀软/索引服务/另一个进程短暂持有，
 * 会抛 EPERM/EBUSY/EACCES——这类冲突是瞬时的，退避重试比直接失败合理。
 */
function renameWithRetry(from: string, to: string, tries = 5): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES"
      if (i >= tries - 1 || !transient) throw e
      sleepSync(15 * (i + 1))
    }
  }
}

function readIndex(): SessionMeta[] {
  try {
    const parsed = JSON.parse(readFileSync(INDEX, "utf8")) as SessionMeta[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeIndex(list: SessionMeta[]): void {
  ensure()
  writeAtomic(INDEX, list)
}

/**
 * T92 读-改-写 index（跨进程互斥）。
 * 注意：**不可重入**——同一进程内嵌套调用会自己等自己的锁，白等 3 秒后降级。
 * 所以所有 index 变更都必须走这一个出口，且 fn 里不要再调本函数。
 */
function mutateIndex(fn: (list: SessionMeta[]) => SessionMeta[]): void {
  ensure()
  withFileLock(INDEX_LOCK, () => {
    writeIndex(fn(readIndex()))
  })
}

export function createSession(cwd: string, model?: string, title = "新对话"): SessionMeta {
  const meta: SessionMeta = {
    id: randomUUID().slice(0, 8),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cwd,
    model,
  }
  // T140 排查插桩：批量/反复出现的会话（如 A-0~C-4 僵尸）要抓调用方——调用栈进 engine.log
  console.log(`[会话] 创建 title=${JSON.stringify(title)} cwd=${cwd}\n${(new Error().stack ?? "").split("\n").slice(1, 5).join("\n")}`)
  // T92：原来这里「unshift + writeIndex」后又 persist()——两次读改写，锁外还可能被并发覆盖。
  // persist() 找不到 id 时本来就会 unshift，所以直接交给它（且它在锁内）即可。
  persist(meta, [])
  return meta
}

export function listSessions(): SessionMeta[] {
  ensure()
  // T32：归一化 cwd——存量数据里同一路径有多种斜杠写法（C:\... / C://... / C:////...），
  // 前端按 cwd 字符串分组会裂成多个组。读出口统一压成规范形式（C:\Users\...），写入端不动。
  // T140 对账自愈：外部进程（并行测试工具/误操作）可能覆盖 index 或删掉其中条目——
  // 磁盘上的 <id>.json 才是真相。读列表时扫目录，把 index 丢失的孤儿补回并写回。
  // 正常情况（无孤儿）只有一次 readdir 的开销，零文件读。
  let list = readIndex()
  try {
    const known = new Set(list.map((s) => s.id))
    const orphans: SessionMeta[] = []
    for (const f of readdirSync(ROOT)) {
      if (!f.endsWith(".json") || f === "index.json") continue
      const id = f.slice(0, -5)
      if (known.has(id)) continue
      const t = tombstones.get(id)
      if (t != null && Date.now() - t < 30 * 60000) continue // 刚删除的不救回
      try {
        const j = JSON.parse(readFileSync(join(ROOT, f), "utf8")) as SessionFile
        if (j?.meta?.id && Array.isArray(j.messages)) orphans.push(j.meta)
      } catch { /* 坏文件跳过 */ }
    }
    if (orphans.length) {
      orphans.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      list = [...orphans, ...list]
      writeIndex(list)
      console.log(`[会话] 对账自愈：补回 ${orphans.length} 个被从 index 丢掉的会话（${orphans.map((o) => o.id).join(",")}）`)
    }
  } catch { /* 目录扫描失败不影响列表返回 */ }
  return list.map((s) => (s.cwd ? { ...s, cwd: normalize(s.cwd) } : s))
}

export function loadSession(id: string): SessionFile | undefined {
  const f = join(ROOT, `${id}.json`)
  if (!existsSync(f)) return undefined
  // T91：坏文件不能把调用方一起带走（历史上 JSON.parse 直接抛，半个文件 = 会话打不开且无提示）
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8")) as SessionFile
    if (!parsed || !Array.isArray(parsed.messages)) {
      console.error(`[会话] ${f} 结构异常，按空会话处理`)
      return undefined
    }
    return parsed
  } catch (e) {
    console.error(`[会话] ${f} 读取失败（${(e as Error).message}）——该会话暂时无法打开`)
    return undefined
  }
}

export function persist(meta: SessionMeta, messages: StoredMessage[]): void {
  ensure()
  // T91：原子写，避免并发/中断写出半个文件（index 同理）
  writeAtomic(join(ROOT, `${meta.id}.json`), { meta, messages })
  // T92：列表更新走跨进程锁——两个窗口同时发消息时，后写的不会再抹掉先写的
  mutateIndex((list) => {
    const i = list.findIndex((x) => x.id === meta.id)
    if (i >= 0) {
      list[i] = meta
      return list
    }
    // T140：刚被删除的会话不允许凭 persist 复活——checkpoint 定时器/任务队列的迟到写入
    // 会把用户已删除的会话写回 index（实测「删了又回来」的机制之一）。tombstone 存活 30 分钟
    //（长任务 timeoutMs 上限 15 分钟 + 余量），过期自动清理。
    const t = tombstones.get(meta.id)
    if (t != null) {
      if (Date.now() - t < 30 * 60000) return list
      tombstones.delete(meta.id)
    }
    return [meta, ...list]
  })
}

/** T140：最近删除的会话 id → 删除时刻。persist 见到新鲜的 tombstone 就不 unshift（防复活） */
const tombstones = new Map<string, number>()

export function deleteSession(id: string): void {
  tombstones.set(id, Date.now())
  mutateIndex((list) => list.filter((x) => x.id !== id))
  // T140：删除改「移入回收站」——~/.yyagent/sessions-trash/ 保留 7 天，误删/异常可找回。
  // 回收站清理顺手做：删除动作发生时清掉超期文件。原 unlink 直删导致用户会话一旦被
  // 异常路径删掉就彻底找不回（备份 zip 7 天滚动，粒度不够）。
  const f = join(ROOT, `${id}.json`)
  try {
    const trashDir = join(dirname(ROOT), "sessions-trash")
    mkdirSync(trashDir, { recursive: true })
    if (existsSync(f)) renameSync(f, join(trashDir, `${id}-${Date.now()}.json`))
    for (const name of readdirSync(trashDir)) {
      const p = join(trashDir, name)
      try {
        if (Date.now() - statSync(p).mtimeMs > 7 * 86400000) unlinkSync(p)
      } catch { /* 单个文件清理失败不影响 */ }
    }
  } catch { /* 回收站失败不阻塞删除：文件留在原地，index 已移除（孤儿文件无害） */ }
}

/**
 * T111：会话归档——把超过 days 天未活动的会话移入 sessions/archive/ 并从 index 剔除。
 * **是移动不是删除**（文件式一切：数据可见可捞，归档文件随时能手动挪回来）；
 * rename 失败时文件留在原地，下次启动 repairIndex 会自动把它补回 index（自愈路径天然成立）。
 */
export function archiveStaleSessions(days: number): { archived: number; ids: string[] } {
  if (!(days > 0)) return { archived: 0, ids: [] }
  const cutoff = Date.now() - days * 86_400_000
  const ids: string[] = []
  mutateIndex((list) => {
    const keep: SessionMeta[] = []
    for (const s of list) {
      if ((s.updatedAt ?? 0) < cutoff) ids.push(s.id)
      else keep.push(s)
    }
    return keep
  })
  if (ids.length) {
    const dir = join(ROOT, "archive")
    mkdirSync(dir, { recursive: true })
    for (const id of ids) {
      try {
        renameSync(join(ROOT, `${id}.json`), join(dir, `${id}.json`))
      } catch {
        /* 移不动就留在原地：index 已剔，repairIndex 下次自愈 */
      }
    }
  }
  return { archived: ids.length, ids }
}

export interface RepairResult {
  /** index 里指向不存在文件的条目（已剔除） */
  dropped: number
  /** 磁盘上有文件但 index 里没有的会话（已补回） */
  recovered: number
  /** 文件存在但读不出来（结构坏了）的会话数——只报告，不删（用户数据不擅自处理） */
  unreadable: number
  /** 修完后的条目总数 */
  total: number
  /** 是否真的写了盘（两侧本来就一致时为 false） */
  changed: boolean
}

/**
 * T92 索引自愈：让 index.json 与磁盘上的会话文件对齐。
 *
 * 为什么需要：`persist()` 是「先写会话文件、再更新 index」两步，本身不是事务。
 * 第一步成功、第二步失败（锁降级后写盘失败 / 进程被杀）时，会话文件在、列表里没有 →
 * 用户看不到这个会话（数据没丢，但等于丢了）。反方向「列表里有、文件没了」则表现为点进去 404。
 * 这两类偏差靠人工排查很痛苦（要逐个比对文件名和 index），而且**只会越积越多**。
 *
 * 修法：扫一遍 sessions 目录，两侧取并集——
 * - index 有、磁盘没有 → 剔除（点进去 404 的条目）；
 * - 磁盘有、index 没有 → 从文件里读出 meta 补回（否则这个会话永远不可见）；
 * - 两侧一致 → 一个字节都不写（幂等，启动时随便跑）。
 *
 * 边界：读不出来的文件（结构坏了）只计数上报，**不删**——那是用户数据，
 * 交给人判断比自动清理安全。
 */
export function repairIndex(): RepairResult {
  ensure()
  const r = withFileLock(INDEX_LOCK, () => {
    const list = readIndex()
    const onDisk = new Set<string>()
    try {
      for (const f of readdirSync(ROOT)) {
        if (!f.endsWith(".json") || f === "index.json") continue
        const id = f.slice(0, -".json".length)
        // 只认「<id>.json」这种干净文件名，跳过 index.json.1 / 各种 .tmp 残留
        if (!id || id.includes(".")) continue
        onDisk.add(id)
      }
    } catch {
      /* 目录读不了 → 不动 index，避免误删 */
      return { dropped: 0, recovered: 0, unreadable: 0, total: list.length, changed: false }
    }

    let dropped = 0
    const kept = list.filter((m) => {
      if (onDisk.has(m.id)) return true
      dropped++
      return false
    })

    let recovered = 0
    let unreadable = 0
    const known = new Set(kept.map((m) => m.id))
    for (const id of onDisk) {
      if (known.has(id)) continue
      const file = loadSession(id)
      if (!file?.meta?.id) {
        unreadable++
        continue
      }
      kept.push(file.meta)
      known.add(id)
      recovered++
    }

    if (!dropped && !recovered) {
      return { dropped: 0, recovered: 0, unreadable, total: kept.length, changed: false }
    }
    // 最近的排前面，与 persist() 的 unshift 语义保持一致（前端按数组顺序渲染侧栏）
    kept.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    writeIndex(kept)
    return { dropped, recovered, unreadable, total: kept.length, changed: true }
  })
  return r.value
}

/**
 * T93：带 ts 的核心消息。压缩后要把「滚动摘要 + 保留的最近消息」原样写回会话存储，
 * 没有 ts 就只能现编一个，撤销/编辑（truncateFrom 按 ts 定位）和前端排序都会错位。
 */
export type CoreMessageWithTs = CoreMessage & { ts: number }

/**
 * T102：LLM 上下文不回传历史思考块。`<thinking>`（T101 落库的原生思考）是**当轮草稿**——
 * 结论已经在正文里，进历史后每轮都为它白付 token（reasoning 模型的思考回合给上下文永久加租），
 * 压缩摘要也会跟着把它当结论存。只剥 **assistant** 消息：用户消息里出现 `<thinking>`
 * 更可能是贴的代码/示例，剥了就是篡改用户输入。落库原文不动（UI 折叠渲染、TUI 剥离各自处理）。
 * 未闭合的半截（停止/超时兜底落库的）一并剥。
 */
export function stripThinkingForModel(content: string): string {
  return content.replace(/<thinking>[\s\S]*?<\/thinking>\n?/g, "").replace(/<thinking>[\s\S]*$/g, "")
}

export function toCoreMessages(messages: StoredMessage[]): CoreMessageWithTs[] {
  const out: CoreMessageWithTs[] = []
  for (const m of messages) {
    // T55：system（模型切换提示等）只入库展示，绝不进 LLM 上下文
    if (m.role === "system" || !m.content.trim()) continue
    const content = m.role === "assistant" ? stripThinkingForModel(m.content).trim() : m.content
    // 剥完变空的（纯思考回合，如「已停止」兜底只落了思考）——空 assistant 消息上游 API 会拒收
    if (m.role === "assistant" && !content) continue
    out.push({ role: m.role, content, ts: m.ts } as CoreMessageWithTs)
  }
  return out
}

/** P2-2 撤回/编辑：截掉 ts 及之后的所有消息，返回剩余消息数组（找不到返回 undefined） */
export function truncateFrom(messages: StoredMessage[], ts: number): StoredMessage[] | undefined {
  const idx = messages.findIndex((m) => m.ts === ts)
  if (idx < 0) return undefined
  return messages.slice(0, idx)
}
