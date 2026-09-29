import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

/**
 * T93 P1：**轮内 checkpoint**（断点恢复的第一块）。
 *
 * 要解决的问题：一个回合只在**开头**（用户消息）和**结尾**（助手回复）落库，
 * 中间几十分钟的工具调用、文件修改、已流出的正文**全在内存**。进程被杀 / 断电 / 崩溃
 * → 会话文件里只剩一条用户消息，没有任何线索能找回「已经做了什么」。
 *
 * 设计取舍：
 * - **放在独立目录，不写进会话文件**。写进会话的话，中断消息看起来和正常回复一样，
 *   用户分不清「这是被打断的」还是「模型就答到这儿」。
 * - **原子写**。半截 JSON 比没有更糟（loadSession 会因此打不开整个会话）。
 * - **落 checkpoint 失败绝不能影响主流程**——它是保险丝，不是主链路。
 * - **不自动清理**。超过一定时间只是标 stale，删不删由用户决定（用户数据不擅自处理）。
 */

const ROOT = join(homedir(), ".yyagent", "checkpoints")

/** 结构版本。字段语义变了就升号，老版本按「读不出来」处理（宁可丢线索也不猜） */
export const CHECKPOINT_VERSION = 1

/**
 * 会话 id 必须有この形状才能拼进路径。会话 id 由 randomUUID 生成，但端点参数是外部输入，
 * 不校验就等于给了一个任意路径写入：`../../foo` 能写到 sessions 目录外面去。
 */
const SESSION_ID_RE = /^[\w-]{1,64}$/

export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_RE.test(id)
}

/** 落库形态的消息（与 store.StoredLike 同形，这里不引循环） */
export interface CheckpointMessage {
  role: "user" | "assistant"
  content: string
  ts: number
}

/** 与 store.StoredMessage.steps 同形 */
export interface CheckpointStep {
  name: string
  argsSummary: string
  input?: string
  output?: string
}

export interface TurnCheckpoint {
  v: number
  sessionId: string
  title: string
  cwd: string
  /** 本轮用户消息的 ts —— 用来把 checkpoint 对回具体哪一轮（discard 要按它截断会话） */
  userTs: number
  userText: string
  /** 本轮带的图片张数。图片不入 checkpoint（base64 能把文件撑到几 MB），
   *  所以带图的轮次要恢复就只能人工重发——**宁可少一个自动功能，不能悄悄丢图** */
  images: number
  startedAt: number
  updatedAt: number
  /** 已流出的正文（中断时用户已经看到的那部分） */
  streamedText: string
  steps: CheckpointStep[]
  /** 本轮若发生过压缩，压缩后的落库历史 */
  compactedStored?: CheckpointMessage[]
  model?: string
}

/** steps 字段上限：超长就把最早的工具输出裁剪掉 */
const MAX_STEPS = 200
const STEP_FIELD_MAX = 2000
/** userText 上限 */
const MAX_USER_TEXT = 50_000

function ensure(): void {
  mkdirSync(ROOT, { recursive: true })
}

export function checkpointPath(sessionId: string): string | undefined {
  if (!isValidSessionId(sessionId)) return undefined
  return join(ROOT, `${sessionId}.json`)
}

/**
 * 原子写：tmp + rename。理由见 store.ts 的 writeAtomic——写到一半被杀会留下半个 JSON，
 * 而 checkpoint 是「进程被杀」场景下唯一的线索，绝不能自己先烂掉。
 */
function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, file)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* 没建成功就不用删 */ }
    throw e
  }
}

/** 把任意形状收敛成合法的 checkpoint（长度裁剪 + 版本标记） */
function normalize(input: Omit<TurnCheckpoint, "v">): TurnCheckpoint {
  const steps = input.steps.slice(-MAX_STEPS).map((s) => ({
    name: String(s.name ?? "").slice(0, STEP_FIELD_MAX),
    argsSummary: String(s.argsSummary ?? "").slice(0, STEP_FIELD_MAX),
    ...(s.input !== undefined ? { input: String(s.input).slice(0, STEP_FIELD_MAX) } : {}),
    ...(s.output !== undefined ? { output: String(s.output).slice(0, STEP_FIELD_MAX) } : {}),
  }))
  return {
    ...input,
    v: CHECKPOINT_VERSION,
    steps,
    userText: input.userText.slice(0, MAX_USER_TEXT),
  }
}

/**
 * 落一个 checkpoint。**失败不抛**：checkpoint 是保险，写不进去不能让主流程跟着挂。
 * 返回是否真的写进去了（调用方据此决定要不要打日志）。
 */
export function saveCheckpoint(input: Omit<TurnCheckpoint, "v">): boolean {
  const file = checkpointPath(input.sessionId)
  if (!file) return false
  try {
    ensure()
    writeAtomic(file, normalize(input))
    return true
  } catch {
    return false
  }
}

/** 读一个 checkpoint。文件不存在 / JSON 坏 / 版本不符 → undefined（不猜、不修） */
export function loadCheckpoint(sessionId: string): TurnCheckpoint | undefined {
  const file = checkpointPath(sessionId)
  if (!file || !existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as TurnCheckpoint
    if (!parsed || typeof parsed !== "object") return undefined
    if (parsed.v !== CHECKPOINT_VERSION) return undefined
    if (typeof parsed.sessionId !== "string" || typeof parsed.userTs !== "number") return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** 删掉一个 checkpoint（回合正常结束 / 用户已做出选择）。会话不存在也算清干净，幂等 */
export function clearCheckpoint(sessionId: string): void {
  const file = checkpointPath(sessionId)
  if (!file) return
  try {
    if (existsSync(file)) unlinkSync(file)
  } catch { /* 删不掉下轮还会扫到，不会静默吞掉数据 */ }
}

/** 列出现有 checkpoint。目录里混进别的文件（含 tmp）也不该让扫描崩 */
export function listCheckpoints(): TurnCheckpoint[] {
  try {
    ensure()
    const out: TurnCheckpoint[] = []
    for (const f of readdirSync(ROOT)) {
      if (!f.endsWith(".json")) continue
      const id = f.slice(0, -5)
      // 带点的名字是 tmp 残留或别的产物，跳过
      if (id.includes(".")) continue
      const c = loadCheckpoint(id)
      if (c) out.push(c)
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

const DAY = 24 * 3600_000

/**
 * 写 checkpoint 的触发条件（双阈值，谁先到算谁）：
 * - 定时：长任务里一个 bash 可能跑几分钟，期间没有任何回调，没有定时就抓不到中间状态
 * - 定步：工具密集的回合不等定时器
 */
export const CHECKPOINT_EVERY_MS = 20_000
export const CHECKPOINT_EVERY_STEPS = 5
/** 同一回合内两份 checkpoint 的最小间隔，避免定时器与步数触发器叠在一起连写两次 */
export const CHECKPOINT_MIN_GAP_MS = 1_000

/** 超过这个时间没有再更新的 checkpoint 视为「大概率不会回来了」——只标记，不删 */
export const STALE_MS = DAY

/** 给人看的一句话（WS notice / TUI 提示用）。宁可朴素也要把「有几条线索」说清楚 */
export function describeCheckpoint(c: TurnCheckpoint): string {
  const chars = c.streamedText.trim().length
  const parts = [`「${c.title || c.sessionId}」`]
  parts.push(chars > 0 ? `已流出 ${chars} 字` : "还没有正文产出")
  if (c.steps.length) parts.push(`${c.steps.length} 步工具`)
  if (c.cwd) parts.push(c.cwd)
  if (Date.now() - c.updatedAt > STALE_MS) parts.push("（陈旧的，可能是很久以前中断的）")
  return parts.join(" · ")
}

/** 恢复后要落库的助手消息内容（把「已流出的部分」整理成一条消息） */
export function resumeAssistantContent(c: TurnCheckpoint): { content: string; hadOutput: boolean } {
  const text = c.streamedText.trim()
  if (!text) {
    const steps = c.steps.length ? `（中断前已执行 ${c.steps.length} 步工具）` : ""
    return {
      content: `（进程被中断，这个回合没有产出正文${steps}。可以重新发送同样的请求。）`,
      hadOutput: false,
    }
  }
  return {
    content: `${text}\n\n---\n（进程被中断，以上是中断前已产出的部分；中断前共执行 ${c.steps.length} 步工具）`,
    hadOutput: true,
  }
}
