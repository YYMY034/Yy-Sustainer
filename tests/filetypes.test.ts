/**
 * T93：`/api/file` 白名单 与 附件外置扩展名表 的一致性守卫。
 *
 * 这两张表分散在两个文件里（`src/util/filetypes.ts` 与 `src/session/attachments.ts`），
 * 但语义上必须严格包含：附件外置后会话里存的是 `/api/file?p=<绝对路径>` 引用，
 * 图片能不能显示**完全**取决于白名单放不放行。
 *
 * 曾经的真实事故：`attachments.ts` 支持 `avif`、白名单里却没有 `.avif`，
 * 于是用户贴一张 AVIF 图 → 外置成 `<sha1>.avif` → `<img src>` 被 403 挡掉 → 界面裂图。
 * 更糟的是当时那张表旁边就写着注释「必须落在网关 /api/file 的白名单里」——
 * **注释约束不了任何人，只有测试能。**
 *
 * 所以这里断言的是「附件侧的每一个落盘扩展名，都在白名单里」，让漂移当场变红。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { ATTACHMENT_EXT } from "../src/session/attachments.js"
import { ALLOWED_FILE_EXT, MIME_BY_EXT, isAllowedFileExt } from "../src/util/filetypes.js"

test("附件外置的每个扩展名都在 /api/file 白名单里（漂移守卫）", () => {
  const missing: string[] = []
  for (const [mime, ext] of Object.entries(ATTACHMENT_EXT)) {
    if (!ALLOWED_FILE_EXT.has(`.${ext}`)) missing.push(`image/${mime} → .${ext}`)
  }
  assert.deepEqual(
    missing,
    [],
    `这些扩展名外置后会被 /api/file 403 挡掉（用户会看到裂图）：${missing.join(", ")}`,
  )
})

test("附件用到的扩展名都有 MIME 映射（否则响应会退化成 octet-stream）", () => {
  const missing: string[] = []
  for (const ext of new Set(Object.values(ATTACHMENT_EXT))) {
    if (!MIME_BY_EXT[`.${ext}`]) missing.push(`.${ext}`)
  }
  assert.deepEqual(missing, [], `缺少 Content-Type 映射：${missing.join(", ")}`)
})

test("白名单里的每个扩展名都有 MIME 映射（避免白名单放行但类型错）", () => {
  const missing = [...ALLOWED_FILE_EXT].filter((e) => !MIME_BY_EXT[e])
  assert.deepEqual(missing, [], `白名单放行但没有 MIME 映射：${missing.join(", ")}`)
})

test("白名单表里的扩展名格式统一：小写、带点、无重复语义", () => {
  for (const ext of ALLOWED_FILE_EXT) {
    assert.equal(ext, ext.toLowerCase(), `${ext} 不是小写`)
    assert.ok(ext.startsWith("."), `${ext} 没带点（path.extname 的输出是带点的）`)
    assert.equal(ext.slice(1).includes("."), false, `${ext} 不该含第二个点`)
  }
})

test("avif 专项：外置后必须可读（历史 bug 回归）", () => {
  assert.equal(ATTACHMENT_EXT.avif, "avif")
  assert.equal(isAllowedFileExt(".avif"), true, "avif 图片外置后会被 403 挡掉")
  assert.equal(MIME_BY_EXT[".avif"], "image/avif")
})

test("白名单确实在拦东西（反向断言：可执行/敏感扩展名不得放行）", () => {
  // 白名单是「防任意文件读取」的那道门，它必须真的挡得住
  for (const bad of [".exe", ".dll", ".msi", ".com", ".scr", ".key", ".pem", ".p12", ".pfx", ".bat2", ""]) {
    assert.equal(isAllowedFileExt(bad), false, `${bad || "(空扩展名)"} 不该被放行`)
  }
})

test("无扩展名 / 点开头文件的行为写清楚（既有约定，不改行为只钉住）", () => {
  assert.equal(isAllowedFileExt(""), false)
  // 已知的既有行为：`path.extname(".gitignore")` 返回 ""（Node 把点开头的当隐藏文件、
  // 不算扩展名），所以 `/api/file?p=...\.gitignore` 实际是 403。
  // 白名单里那条 `.gitignore` 只在文件名形如 `x.gitignore` 时才命中。
  // 这是安全白名单的保守副作用，不影响功能（.gitignore 也不是预览场景），故保持现状。
  assert.equal(isAllowedFileExt(".gitignore"), true, "表里有这条（x.gitignore 这类文件名会命中）")
})
