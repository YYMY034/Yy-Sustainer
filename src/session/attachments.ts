/**
 * T92 会话图片外置
 *
 * 问题：用户发的图以 dataUrl（`data:image/png;base64,...`）直接塞进会话 JSON 的 `messages[].images`。
 * 一张手机截图 1–3 MB，base64 再涨 33%——几轮图文对话下来单个会话文件几十 MB：
 *   · `loadSession()` 每次发消息都要整读 + JSON.parse，越用越卡；
 *   · `/api/sessions` 列表、备份、撤销快照全都被这份体积拖着走；
 *   · 图片被重复存进每条消息（编辑重发时更明显），同样的图存多份。
 *
 * 方案：落库前把 dataUrl 换成文件引用。文件放 `~/.yyagent/attachments/<sessionId>/`，
 * **内容寻址**（sha1 前 16 位）命名——同一张图天然只存一份，重复发送零成本。
 * 引用形式是 `/api/file?p=<绝对路径>`：这是网关已有的本地文件接口（带扩展名白名单），
 * 前端 `<img src>` 直接就能用，不需要新增协议。
 *
 * 向后兼容：
 *   · 新消息在落库时外置（gateway 的 runTurn）；
 *   · 老会话里已有的 dataUrl 由 `migrateInlineImages()` 一次性迁移（有标记文件，幂等）；
 *   · `attachmentToBase64()` 两种形式都认，所以「编辑重发 / 重新生成」在迁移前后都能跑。
 *
 * 失败降级：任何一步出错都退回 dataUrl 原样落库——**宁可文件大，不能丢图**。
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { listSessions, loadSession, persist, type StoredMessage } from "./store.js"

const ROOT = join(homedir(), ".yyagent", "attachments")
const MIGRATED = join(ROOT, ".migrated")

/**
 * mime 子类型 → 落盘扩展名。
 * **必须落在网关 `/api/file` 的白名单里**，否则外置后的图片会被 403 挡掉、界面裂图。
 * 这条约束由 `tests/filetypes.test.ts` 断言守住（曾经 `avif` 只在这一侧有、白名单里没有）。
 * 导出是为了让测试能遍历它，不要在别处引用。
 */
export const ATTACHMENT_EXT: Readonly<Record<string, string>> = {
  png: "png",
  jpeg: "jpg",
  jpg: "jpg",
  webp: "webp",
  gif: "gif",
  bmp: "bmp",
  svg: "svg",
  "svg+xml": "svg",
  avif: "avif",
}
const EXT = ATTACHMENT_EXT

export function attachmentsRoot(): string {
  return ROOT
}

/** dataUrl → { ext, b64 }；不是受支持的图片 dataUrl 就返回 undefined */
function parseDataUrl(v: string): { ext: string; b64: string } | undefined {
  const m = /^data:image\/([a-z0-9+.-]+);base64,([\s\S]+)$/i.exec(v.trim())
  if (!m) return undefined
  const ext = EXT[m[1].toLowerCase()]
  if (!ext) return undefined
  return { ext, b64: m[2].replace(/\s+/g, "") }
}

export function attachmentUrl(absPath: string): string {
  return `/api/file?p=${encodeURIComponent(absPath)}`
}

/** 从 `/api/file?p=...` 取回绝对路径；不是这种引用返回 undefined */
function pathFromUrl(ref: string): string | undefined {
  if (!ref.startsWith("/api/file?")) return undefined
  try {
    const p = new URL(ref, "http://local").searchParams.get("p")
    return p || undefined
  } catch {
    return undefined
  }
}

/** 这张图在磁盘上是否真的存在（用于清理孤儿时保护、以及渲染前校验） */
export function attachmentExists(ref: string): boolean {
  const p = pathFromUrl(ref)
  if (p) return existsSync(p)
  return ref.startsWith("data:")
}

/** 保存一张图（内容寻址：同图只存一份）。失败返回 undefined，调用方保留原 dataUrl */
export function saveAttachment(sessionId: string, b64: string, ext: string): string | undefined {
  try {
    const dir = join(ROOT, sessionId)
    mkdirSync(dir, { recursive: true })
    const buf = Buffer.from(b64, "base64")
    if (!buf.length) return undefined
    const hash = createHash("sha1").update(buf).digest("hex").slice(0, 16)
    const file = join(dir, `${hash}.${ext}`)
    if (!existsSync(file)) writeFileSync(file, buf)
    return attachmentUrl(file)
  } catch {
    return undefined
  }
}

/** 落库前批量外置：逐张转换，单张失败就保留那一张的原样 */
export function externalizeImages(sessionId: string, images: string[]): string[] {
  return images.map((v) => {
    if (!v.startsWith("data:")) return v
    const parsed = parseDataUrl(v)
    if (!parsed) return v
    return saveAttachment(sessionId, parsed.b64, parsed.ext) ?? v
  })
}

/** 引用 → 裸 base64（「编辑重发 / 重新生成」要重新喂模型时用）。dataUrl 与文件引用都认 */
export function attachmentToBase64(ref: string): string | undefined {
  const direct = parseDataUrl(ref)
  if (direct) return direct.b64
  const p = pathFromUrl(ref)
  if (!p) return undefined
  try {
    if (!existsSync(p)) return undefined
    return readFileSync(p).toString("base64")
  } catch {
    return undefined
  }
}

/** 消息列表里被引用到的附件绝对路径（清理孤儿时的白名单） */
export function referencedPaths(messages: StoredMessage[]): Set<string> {
  const out = new Set<string>()
  for (const m of messages) {
    for (const v of m.images ?? []) {
      const p = pathFromUrl(v)
      if (p) out.add(p)
    }
  }
  return out
}

/**
 * 清理会话目录里的孤儿附件（会话被截断/撤回后不再被任何消息引用）。
 * 返回删除的文件数。只在 used 非空时执行——避免「调用方传了空集合」把整个目录清空。
 */
export function pruneAttachments(sessionId: string, used: Set<string>): number {
  const dir = join(ROOT, sessionId)
  if (!existsSync(dir)) return 0
  let n = 0
  try {
    for (const f of readdirSync(dir)) {
      const abs = join(dir, f)
      if (used.has(abs)) continue
      try {
        unlinkSync(abs)
        n++
      } catch {
        /* 被别的进程占用，下次再清 */
      }
    }
  } catch {
    /* 目录读不了就算了 */
  }
  return n
}

/** 会话删除时整体清掉（幂等） */
export function removeSessionAttachments(sessionId: string): void {
  try {
    rmSync(join(ROOT, sessionId), { recursive: true, force: true })
  } catch {
    /* 文件被占用时留待下次；不影响会话删除本身 */
  }
}

/**
 * 启动时清理：附件根目录下已经没有对应会话的目录（会话在别处被删、或删除时文件被占用没删掉）。
 * 返回清掉的目录数。跳过点开头的文件（.migrated 标记等）。
 */
export function sweepOrphanAttachments(aliveSessionIds: Set<string>): number {
  if (!existsSync(ROOT)) return 0
  let n = 0
  try {
    for (const f of readdirSync(ROOT)) {
      if (f.startsWith(".")) continue
      if (aliveSessionIds.has(f)) continue
      try {
        rmSync(join(ROOT, f), { recursive: true, force: true })
        n++
      } catch {
        /* 被占用，下次启动再试 */
      }
    }
  } catch {
    /* 目录读不了就算了 */
  }
  return n
}

export interface MigrateResult {
  sessions: number
  images: number
}

/**
 * 一次性迁移：把历史会话里内嵌的 dataUrl 图片外置。
 * 幂等：标记文件存在即跳过；标记只在**全部成功**后写，中途出错下次重试。
 * 调用方应异步执行（gateway 启动后），避免拖慢监听。
 */
export function migrateInlineImages(): MigrateResult {
  if (existsSync(MIGRATED)) return { sessions: 0, images: 0 }
  let sessions = 0
  let images = 0
  for (const meta of listSessions()) {
    const file = loadSession(meta.id)
    if (!file) continue
    let changed = false
    for (const m of file.messages) {
      const src = m.images
      if (!src?.length) continue
      if (!src.some((v) => v.startsWith("data:"))) continue
      const next = externalizeImages(meta.id, src)
      const converted = next.filter((v, i) => v !== src[i]).length
      if (!converted) continue
      m.images = next
      changed = true
      images += converted
    }
    if (changed) {
      persist(file.meta, file.messages)
      sessions++
    }
  }
  try {
    mkdirSync(ROOT, { recursive: true })
    writeFileSync(MIGRATED, JSON.stringify({ at: Date.now(), sessions, images }, null, 2))
  } catch {
    /* 标记写不进去 → 下次启动重跑一遍（转换是幂等的，代价只是白扫一次） */
  }
  return { sessions, images }
}

/**
 * 细粒度孤儿清理：删掉「会话还在、但没有任何消息引用」的附件文件。
 * 与 `sweepOrphanAttachments` 的分工——那个删**整个会话目录**（会话已不存在），
 * 这个删**会话目录里的单个文件**（撤回 / 编辑 / 重新生成后留下的）。
 *
 * **保守原则**：`used` 为空（这个会话一张外置图都没被引用）时**直接跳过**，不清理。
 * 因为「引用为空」既可能是「文件全是孤儿」，也可能是「消息读取失败/引用格式变了」——
 * 后者一旦误判就是把用户还在用的图删了。宁可留几个垃圾文件，也不能删错。
 */
export function sweepUnreferencedAttachments(): { files: number } {
  if (!existsSync(ROOT)) return { files: 0 }
  let files = 0
  try {
    for (const sid of readdirSync(ROOT)) {
      if (sid.startsWith(".")) continue
      const dir = join(ROOT, sid)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      const file = loadSession(sid)
      if (!file) continue // 会话读不出来 → 它的附件一律不碰
      const used = referencedPaths(file.messages)
      if (!used.size) continue // 保守：判不了就不动
      files += pruneAttachments(sid, used)
    }
  } catch {
    /* 根目录读不了就算了 */
  }
  return { files }
}

export interface AttachmentUsage {
  /** 全部附件占用的字节数 */
  bytes: number
  /** 文件总数 */
  files: number
  /** 会话目录数 */
  sessions: number
  /** 占用最大的前 N 个会话 */
  top: Array<{ sessionId: string; bytes: number; files: number }>
}

/**
 * 附件占用统计（只读，不做任何清理）。
 *
 * 为什么只统计不自动清理：附件是**用户的图片**，不是缓存。
 * 「超过阈值就自动删最旧的」等于在用户不知情时删他的数据——这类自动化宁可没有。
 * 这里只负责让占用**可见**（启动时超过阈值给一条警告），清理动作留给
 * 「会话删除 / 撤回 / 孤儿扫描」这三个语义明确的时机。
 */
export function attachmentsUsage(topN = 5): AttachmentUsage {
  const out: AttachmentUsage = { bytes: 0, files: 0, sessions: 0, top: [] }
  if (!existsSync(ROOT)) return out
  const per: Array<{ sessionId: string; bytes: number; files: number }> = []
  try {
    for (const sid of readdirSync(ROOT)) {
      if (sid.startsWith(".")) continue
      const dir = join(ROOT, sid)
      let bytes = 0
      let files = 0
      try {
        if (!statSync(dir).isDirectory()) continue
        for (const f of readdirSync(dir)) {
          try {
            bytes += statSync(join(dir, f)).size
            files++
          } catch {
            /* 文件刚被删 */
          }
        }
      } catch {
        continue
      }
      out.bytes += bytes
      out.files += files
      out.sessions++
      per.push({ sessionId: sid, bytes, files })
    }
  } catch {
    /* 根目录读不了 → 返回已统计到的部分 */
  }
  out.top = per.sort((a, b) => b.bytes - a.bytes).slice(0, Math.max(1, topN))
  return out
}
