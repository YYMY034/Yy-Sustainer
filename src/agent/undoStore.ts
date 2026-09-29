import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { loadConfig } from "./config.js"
import { MAX_SNAPSHOT_BYTES, planUndo, type FileEdit, type UndoAction } from "./fileTrack.js"

/**
 * T93 B2：撤销快照**落盘**（`docs/50-persistence.md` 第 5 节）。
 *
 * 要解决的现状：`undoSnapshots` 是网关内存 Map，重启即空。而 `StoredMessage.fileEdits`
 * （只有 `{path, kind}`）是落库的——于是前端那个「撤销」按钮在重启后必然失败，
 * 错误信息还写着「可能已撤销或来自更早的会话进程」，用户没法行动。
 *
 * **默认关。** 它要把改前的完整文件内容复制进 `~/.yyagent/`，这和 bgTasks 只落元数据
 * 不是同一个量级。打开前用户应该知道自己同意了什么。
 *
 * 硬约束（不是可选项）：
 *  1. **绝不快照 `~/.yyagent/` 内部的路径**——那里有 `.master.key`、`config.json`、
 *     `sessions/`（含附件）。快照它们等于把密钥复制一份到另一个位置，还可能导致递归。
 *  2. 单文件上限沿用采集侧的 `MAX_SNAPSHOT_BYTES`——**不设第二个来源**。
 *  3. 单轮落盘总量、目录总预算、保留天数都可配，超出按最旧淘汰。
 *  4. 原子写 + 结构版本号；读不出来/版本不符 → 当作没有，回落到内存路径。
 *  5. `snapshots/` **不**加进 T83 备份（派生数据，加进去备份体积最多翻倍）。
 */

const ROOT = join(homedir(), ".yyagent", "snapshots")

/** 结构版本。字段语义变了就升号，旧版按「读不出来」处理 */
export const UNDO_VERSION = 1

const DEFAULTS = {
  maxTurnBytes: 2 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  keepDays: 7,
} as const

export interface UndoFileRec {
  /** 绝对路径（只进 index.json，不进文件名——避开 Windows 路径字符/长度问题） */
  path: string
  kind: "write" | "edit"
  /** 快照文件名 `<sha1(path) 前 16 位>.snap`；新建文件（snapshot=null）不建 */
  file?: string
  bytes: number
  /** 这条为什么没落盘。有它撤销时就不能动这个文件 */
  skippedOnDisk?: "inside-yyagent" | "over-turn-budget" | "no-snapshot"
  /** 本轮**新建**的文件（改前不存在）→ 撤销 = 删除。没有快照内容，但和「采不到快照」是两件事 */
  newFile?: boolean
}

export interface UndoTurn {
  v: number
  sessionId: string
  /** 对应 assistant 消息的 ts——前端的撤销按钮参数 */
  ts: number
  cwd: string
  files: UndoFileRec[]
  writtenAt: number
}

/** `~/.yyagent/` 自身。快照它 = 复制密钥 + 可能递归。 */
const YYAGENT_ROOT = resolve(homedir(), ".yyagent")

/** 路径是否落在 `~/.yyagent/` 内部（含自身） */
export function insideYyagent(absPath: string): boolean {
  const p = resolve(absPath)
  return p === YYAGENT_ROOT || p.startsWith(YYAGENT_ROOT + sep)
}

function turnDir(sessionId: string, ts: number): string {
  return join(ROOT, sessionId, String(ts))
}

function indexPath(sessionId: string, ts: number): string {
  return join(turnDir(sessionId, ts), "index.json")
}

/** 内容寻址的文件名（复用 attachments 的思路：同内容天然只存一份） */
function snapName(absPath: string): string {
  return createHash("sha1").update(absPath).digest("hex").slice(0, 16) + ".snap"
}

/**
 * 生效配置。**做成可注入而不是只读 loadConfig**——否则测试要改全局配置文件、
 * 还要跟 loadConfig 的进程内缓存搏斗；而调用方（网关）传默认值就行。
 */
export interface UndoCfg {
  persist: boolean
  maxTurnBytes: number
  maxTotalBytes: number
  keepDays: number
}

export function undoCfg(over?: Partial<UndoCfg>): UndoCfg {
  const u = loadConfig().undo ?? {}
  return {
    persist: over?.persist ?? u.persist === true,
    maxTurnBytes: over?.maxTurnBytes ?? u.maxTurnBytes ?? DEFAULTS.maxTurnBytes,
    maxTotalBytes: over?.maxTotalBytes ?? u.maxTotalBytes ?? DEFAULTS.maxTotalBytes,
    keepDays: over?.keepDays ?? u.keepDays ?? DEFAULTS.keepDays,
  }
}

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, typeof data === "string" ? data : JSON.stringify(data))
    renameSync(tmp, file)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* 没建成功就不用删 */ }
    throw e
  }
}

/**
 * 把一轮的文件修改落成快照。**失败不抛**——落不上去只是重启后少一批可撤销的记录，
 * 不该把主流程带崩（内存里那份仍然有效）。
 */
export function saveUndoTurn(sessionId: string, ts: number, cwd: string, edits: FileEdit[], over?: Partial<UndoCfg>): boolean {
  const c = undoCfg(over)
  if (!c.persist) return false
  const files: UndoFileRec[] = []
  let turnBytes = 0

  for (const e of edits) {
    const rec: UndoFileRec = { path: e.path, kind: e.kind, bytes: 0 }
    // 硬约束 1：`~/.yyagent/` 内部一律不落盘。内存里那份仍然有效（本次进程内可撤销），
    // 只是重启后撤不了——这比把密钥复制一份可接受得多。
    if (insideYyagent(e.path)) {
      rec.skippedOnDisk = "inside-yyagent"
      files.push(rec)
      continue
    }
    if (e.snapshot == null) {
      // 采集侧就没采到（超大/二进制/读不了）→ 原样带过去，撤销时 refuse
      if (e.skipped) {
        rec.skippedOnDisk = "no-snapshot"
      } else {
        // 新建文件：没有快照内容，但撤销 = 删除。**不能和「采不到」混为一谈**——
        // 混了的话重启后就连「删掉模型新建的文件」都做不到了。
        rec.newFile = true
      }
      files.push(rec)
      continue
    }
    const bytes = Buffer.byteLength(e.snapshot, "utf8")
    // 硬约束 2：单文件上限沿用采集侧常量（不设第二个来源）
    if (bytes > MAX_SNAPSHOT_BYTES) {
      rec.skippedOnDisk = "over-turn-budget"
      files.push(rec)
      continue
    }
    // 硬约束 3：单轮总量
    if (turnBytes + bytes > c.maxTurnBytes) {
      rec.skippedOnDisk = "over-turn-budget"
      files.push(rec)
      continue
    }
    const name = snapName(e.path)
    try {
      writeAtomic(join(turnDir(sessionId, ts), name), e.snapshot)
      rec.file = name
      rec.bytes = bytes
      turnBytes += bytes
    } catch {
      rec.skippedOnDisk = "over-turn-budget"
    }
    files.push(rec)
  }

  try {
    writeAtomic(indexPath(sessionId, ts), {
      v: UNDO_VERSION,
      sessionId,
      ts,
      cwd,
      files,
      writtenAt: Date.now(),
    } satisfies UndoTurn)
    enforceBudget(over)
    return true
  } catch {
    return false
  }
}

/** 读一轮快照。文件不在 / JSON 坏 / 版本不符 → undefined（不猜、不静默迁移） */
export function loadUndoTurn(sessionId: string, ts: number): UndoTurn | undefined {
  const file = indexPath(sessionId, ts)
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as UndoTurn
    if (!parsed || typeof parsed !== "object") return undefined
    if (parsed.v !== UNDO_VERSION) return undefined
    if (!Array.isArray(parsed.files) || typeof parsed.ts !== "number") return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** 读出某一条的快照内容。没有落盘 / 读不出来 → undefined */
export function readUndoSnapshot(sessionId: string, ts: number, rec: UndoFileRec): string | undefined {
  if (!rec.file) return undefined
  try {
    return readFileSync(join(turnDir(sessionId, ts), rec.file), "utf8")
  } catch {
    return undefined
  }
}

/** 列出某会话的全部落盘快照轮次（按 ts 倒序） */
export function listUndoTurns(sessionId: string): UndoTurn[] {
  const dir = join(ROOT, sessionId)
  try {
    if (!existsSync(dir)) return []
    const out: UndoTurn[] = []
    for (const name of readdirSync(dir)) {
      if (!/^\d+$/.test(name)) continue
      const t = loadUndoTurn(sessionId, Number(name))
      if (t) out.push(t)
    }
    return out.sort((a, b) => b.ts - a.ts)
  } catch {
    return []
  }
}

function dirSize(dir: string): number {
  let total = 0
  try {
    for (const f of readdirSync(dir)) {
      try {
        const st = statSync(join(dir, f))
        if (st.isDirectory()) total += dirSize(join(dir, f))
        else total += st.size
      } catch { /* 刚被删 */ }
    }
  } catch { /* 目录不在 */ }
  return total
}

/** 硬约束 3：总预算 + 保留天数。按轮次 ts 从旧到新删，直到同时满足两个上限。 */
export function enforceBudget(over?: Partial<UndoCfg>): void {
  const c = undoCfg(over)
  try {
    if (!existsSync(ROOT)) return
    const turns: Array<{ sessionId: string; ts: number }> = []
    for (const sid of readdirSync(ROOT)) {
      for (const t of listUndoTurns(sid)) turns.push({ sessionId: sid, ts: t.ts })
    }
    turns.sort((a, b) => a.ts - b.ts) // 旧的先删
    let bytes = dirSize(ROOT)
    const now = Date.now()
    for (const t of turns) {
      const tooOld = now - t.ts > c.keepDays * 24 * 3600_000
      if (!tooOld && bytes <= c.maxTotalBytes) break
      removeUndoTurn(t.sessionId, t.ts)
      bytes = dirSize(ROOT)
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 删一轮快照（目录整个删——index 与 .snap 是一体的） */
export function removeUndoTurn(sessionId: string, ts: number): void {
  try {
    rmSync(turnDir(sessionId, ts), { recursive: true, force: true })
  } catch { /* 删不掉下轮还会被 enforceBudget 看到 */ }
}

/** 启动时扫一次：过期/超预算的清掉。返回**清掉的轮次数**（不是目录数——
 *  同一会话删掉一轮不会让会话目录消失，数目录会恒返回 0）。 */
export function sweepUndoSnapshots(over?: Partial<UndoCfg>): number {
  const before = countTurns()
  enforceBudget(over)
  return Math.max(0, before - countTurns())
}

function countTurns(): number {
  let n = 0
  try {
    if (!existsSync(ROOT)) return 0
    for (const sid of readdirSync(ROOT)) n += listUndoTurns(sid).length
  } catch { /* 目录不在 */ }
  return n
}

// ---------- 恢复的唯一出口 ----------

export interface ResolvedUndoFile {
  path: string
  /** 处置决策。内存与磁盘两条来源都收敛到同一个 planUndo()，不在别处另写一套 */
  plan: UndoAction
}

export interface ResolvedUndoTurn {
  source: "memory" | "disk"
  files: ResolvedUndoFile[]
}

/**
 * 撤销目标的唯一出口。**故意做成纯函数、把内存那份当参数传进来**——
 * 否则「内存一份、磁盘一份」必然写出两套恢复逻辑（这正是前几轮反复吃亏的形状），
 * 而且没法单测。
 *
 * 优先级：内存 > 磁盘。内存那份来自活进程，最新；磁盘是重启后的唯一线索。
 */
export function resolveUndoTurn(
  memoryEdits: FileEdit[] | undefined,
  sessionId: string,
  ts: number,
): ResolvedUndoTurn | undefined {
  if (memoryEdits && memoryEdits.length) {
    return { source: "memory", files: memoryEdits.map((e) => ({ path: e.path, plan: planUndo(e) })) }
  }
  const turn = loadUndoTurn(sessionId, ts)
  if (!turn || !turn.files.length) return undefined
  const files: ResolvedUndoFile[] = turn.files.map((rec) => {
    if (rec.skippedOnDisk) {
      const reason =
        rec.skippedOnDisk === "inside-yyagent"
          ? "位于 ~/.yyagent/ 内部，按设计不落快照"
          : rec.skippedOnDisk === "no-snapshot"
            ? "采集侧未采到快照（文件过大 / 二进制 / 读取失败），无法自动恢复"
            : "超过单轮落盘预算，未落盘"
      return { path: rec.path, plan: { op: "refuse", reason } }
    }
    // 本轮新建的文件：撤销 = 删除（与内存侧 planUndo 的语义一致）
    if (rec.newFile) return { path: rec.path, plan: { op: "delete" } }
    const snap = readUndoSnapshot(sessionId, ts, rec)
    if (snap === undefined) return { path: rec.path, plan: { op: "refuse", reason: "快照文件读不出来（可能已被清理）" } }
    return { path: rec.path, plan: { op: "restore", content: snap } }
  })
  return { source: "disk", files }
}

/** 撤销失败时给人看的分层原因——原来三种情况混成一句，用户没法行动 */
export function undoMissReason(hasFileEditsMeta: boolean): string {
  return hasFileEditsMeta
    ? "这一轮没有可撤销的快照。可能原因：未开启快照落盘（config.undo.persist）、已超过保留期、或文件过大/二进制被跳过。可在设置里开启 undo.persist。"
    : "这一轮没有文件修改记录（可能已撤销过，或来自更早的版本）"
}
