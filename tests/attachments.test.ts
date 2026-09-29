/**
 * T92 会话图片外置单测
 *
 * 核心不变量：**往返无损**——外置后还能还原出逐字节相同的 base64；
 * 以及**同图只存一份**（内容寻址的意义）。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  attachmentExists,
  attachmentToBase64,
  attachmentUrl,
  attachmentsRoot,
  attachmentsUsage,
  externalizeImages,
  pruneAttachments,
  referencedPaths,
  removeSessionAttachments,
  saveAttachment,
  sweepOrphanAttachments,
  sweepUnreferencedAttachments,
} from "../src/session/attachments.js"
import { createSession, deleteSession, persist, type StoredMessage } from "../src/session/store.js"

/** 1x1 PNG，用来当真实图片载荷 */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`
/** 另一张图（1x1 GIF），用于「不同图不该互相覆盖」 */
const GIF_B64 = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
const GIF_DATA_URL = `data:image/gif;base64,${GIF_B64}`

function cleanup(sessionId: string): void {
  removeSessionAttachments(sessionId)
}

test("dataUrl 外置成 /api/file 引用，且文件真的落盘", () => {
  const sid = "t-基本"
  const [ref] = externalizeImages(sid, [PNG_DATA_URL])
  assert.ok(ref.startsWith("/api/file?p="), `应是 /api/file 引用，实际 ${ref}`)
  assert.ok(ref.includes(encodeURIComponent(".png")), "扩展名应是 .png")
  assert.equal(attachmentExists(ref), true)
  assert.equal(readdirSync(join(attachmentsRoot(), sid)).length, 1)
  cleanup(sid)
})

test("同图只存一份（内容寻址去重）", () => {
  const sid = "t-去重"
  const refs = externalizeImages(sid, [PNG_DATA_URL, PNG_DATA_URL, PNG_DATA_URL])
  assert.equal(new Set(refs).size, 1, "三次相同内容应指向同一个文件")
  assert.equal(readdirSync(join(attachmentsRoot(), sid)).length, 1)
  cleanup(sid)
})

test("不同图各存一份，互不覆盖", () => {
  const sid = "t-不同图"
  const refs = externalizeImages(sid, [PNG_DATA_URL, GIF_DATA_URL])
  assert.equal(new Set(refs).size, 2)
  assert.equal(readdirSync(join(attachmentsRoot(), sid)).length, 2)
  cleanup(sid)
})

test("往返无损：外置再还原，base64 与原文逐字相同", () => {
  const sid = "t-往返"
  const [ref] = externalizeImages(sid, [PNG_DATA_URL])
  const back = attachmentToBase64(ref)
  assert.equal(back, PNG_B64)
  cleanup(sid)
})

test("attachmentToBase64 对未外置的 dataUrl 也照常工作（迁移前的老会话）", () => {
  assert.equal(attachmentToBase64(PNG_DATA_URL), PNG_B64)
})

test("attachmentToBase64 对不存在的文件返回 undefined（不抛）", () => {
  const ref = attachmentUrl(join(attachmentsRoot(), "不存在", "nope.png"))
  assert.equal(attachmentToBase64(ref), undefined)
})

test("无法识别的引用返回 undefined", () => {
  assert.equal(attachmentToBase64("/some/other/path.png"), undefined)
  assert.equal(attachmentToBase64("data:image/tiff;base64,AAAA"), undefined, "白名单外的类型不外置")
})

test("白名单外的图片类型原样保留（宁可不外置，也不能丢图）", () => {
  const sid = "t-白名单外"
  const weird = "data:image/tiff;base64,AAAA"
  const out = externalizeImages(sid, [weird])
  assert.deepEqual(out, [weird])
  cleanup(sid)
})

test("非 dataUrl 引用（已外置过）原样透传，不重复落盘", () => {
  const sid = "t-幂等"
  const [ref] = externalizeImages(sid, [PNG_DATA_URL])
  const again = externalizeImages(sid, [ref])
  assert.deepEqual(again, [ref])
  assert.equal(readdirSync(join(attachmentsRoot(), sid)).length, 1)
  cleanup(sid)
})

test("referencedPaths 收集消息里被引用的附件路径", () => {
  const sid = "t-引用"
  const refs = externalizeImages(sid, [PNG_DATA_URL, GIF_DATA_URL])
  const msgs: StoredMessage[] = [
    { role: "user", content: "看这两张 [图片1][图片2]", ts: 1, images: refs },
    { role: "assistant", content: "看到了", ts: 2 },
  ]
  const used = referencedPaths(msgs)
  assert.equal(used.size, 2)
  for (const r of refs) {
    const p = decodeURIComponent(new URL(r, "http://x").searchParams.get("p") ?? "")
    assert.ok(used.has(p))
  }
  cleanup(sid)
})

test("pruneAttachments 删掉不再被引用的文件，保留在用的", () => {
  const sid = "t-清理"
  const refs = externalizeImages(sid, [PNG_DATA_URL, GIF_DATA_URL])
  const dir = join(attachmentsRoot(), sid)
  assert.equal(readdirSync(dir).length, 2)
  // 只保留第一张
  const used = new Set([decodeURIComponent(new URL(refs[0], "http://x").searchParams.get("p")!)])
  const removed = pruneAttachments(sid, used)
  assert.equal(removed, 1)
  assert.equal(readdirSync(dir).length, 1)
  cleanup(sid)
})

test("removeSessionAttachments 清掉整个会话目录（幂等）", () => {
  const sid = "t-删除"
  externalizeImages(sid, [PNG_DATA_URL])
  assert.equal(existsSync(join(attachmentsRoot(), sid)), true)
  removeSessionAttachments(sid)
  assert.equal(existsSync(join(attachmentsRoot(), sid)), false)
  removeSessionAttachments(sid) // 再来一次不该抛
})

test("sweepOrphanAttachments 只清没有对应会话的目录", () => {
  const alive = "t-存活"
  const dead = "t-孤儿"
  externalizeImages(alive, [PNG_DATA_URL])
  externalizeImages(dead, [GIF_DATA_URL])
  const n = sweepOrphanAttachments(new Set([alive]))
  assert.equal(n, 1)
  assert.equal(existsSync(join(attachmentsRoot(), alive)), true, "存活会话的附件必须留下")
  assert.equal(existsSync(join(attachmentsRoot(), dead)), false)
  cleanup(alive)
})

test("sweepOrphanAttachments 不动点开头的标记文件", () => {
  mkdirSync(attachmentsRoot(), { recursive: true })
  const marker = join(attachmentsRoot(), ".migrated")
  const existed = existsSync(marker)
  const before = existed ? readFileSync(marker, "utf8") : ""
  if (!existed) writeFileSync(marker, "{}")
  sweepOrphanAttachments(new Set())
  assert.equal(existsSync(marker), true, "标记文件不该被当成孤儿目录删掉")
  if (!existed) rmSync(marker, { force: true })
  else writeFileSync(marker, before)
})

test("saveAttachment 对空内容返回 undefined（不产生 0 字节垃圾文件）", () => {
  const sid = "t-空"
  assert.equal(saveAttachment(sid, "", "png"), undefined)
  cleanup(sid)
})

test("attachmentsUsage：统计到总量与 top（只统计，不清理）", () => {
  const sid = "t-占用"
  externalizeImages(sid, [PNG_DATA_URL, GIF_DATA_URL])
  const u = attachmentsUsage(10)
  assert.ok(u.bytes > 0)
  assert.ok(u.files >= 2)
  assert.ok(u.top.some((t) => t.sessionId === sid), "top 里应能看到本用例的会话")
  assert.equal(existsSync(join(attachmentsRoot(), sid)), true, "统计不该删任何东西")
  cleanup(sid)
})

test("sweepUnreferencedAttachments：清掉不再被消息引用的文件", () => {
  const meta = createSession("C:\\p", undefined, "附件清理")
  const refs = externalizeImages(meta.id, [PNG_DATA_URL, GIF_DATA_URL])
  // 消息里只引用第一张 → 第二张成为孤儿
  persist(meta, [{ role: "user", content: "只留这张 [图片1]", ts: 1, images: [refs[0]] }])
  const r = sweepUnreferencedAttachments()
  assert.ok(r.files >= 1)
  assert.equal(readdirSync(join(attachmentsRoot(), meta.id)).length, 1, "第二张图不再被引用，应被清掉")
  deleteSession(meta.id)
  removeSessionAttachments(meta.id)
})

test("sweepUnreferencedAttachments：引用为空时保守跳过（宁可留垃圾也不误删）", () => {
  const meta = createSession("C:\\p", undefined, "保守跳过")
  externalizeImages(meta.id, [PNG_DATA_URL])
  // 消息里一条外置引用都没有——可能是迁移失败或引用格式变了，判不出来就不该动
  persist(meta, [{ role: "user", content: "没有任何引用", ts: 1 }])
  sweepUnreferencedAttachments()
  assert.equal(readdirSync(join(attachmentsRoot(), meta.id)).length, 1, "判不了就不动")
  deleteSession(meta.id)
  removeSessionAttachments(meta.id)
})

test("sweepUnreferencedAttachments：会话读不出来时不动它的附件", () => {
  const meta = createSession("C:\\p", undefined, "坏会话")
  externalizeImages(meta.id, [PNG_DATA_URL])
  // 把会话文件弄坏 → loadSession 返回 undefined → 该会话的附件一律不碰
  writeFileSync(join(homedir(), ".yyagent", "sessions", `${meta.id}.json`), "{ 坏了")
  sweepUnreferencedAttachments()
  assert.equal(readdirSync(join(attachmentsRoot(), meta.id)).length, 1, "会话读不出来就不该动它的文件")
  deleteSession(meta.id)
  removeSessionAttachments(meta.id)
})
