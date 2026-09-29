/**
 * `/api/file` 的文件类型白名单与 MIME 映射。
 *
 * 为什么单独抽一个模块：这张表和 `src/session/attachments.ts` 的 `EXT` 表
 * **必须保持一致**——附件外置后，会话里存的引用是 `/api/file?p=xxx.png`，
 * 图片能不能显示完全取决于这里的白名单。之前这两张表分散在两个文件里、
 * 没有任何机制防止漂移，结果 `attachments.ts` 支持 `avif`、白名单里却没有 `.avif`：
 * 用户贴一张 AVIF 图 → 外置成 `<sha1>.avif` → `<img src>` 被 403 挡掉 → 界面裂图。
 * （那张注释「必须落在网关 /api/file 的白名单里，否则图片读不出来」就在旁边，照样漏了。）
 *
 * 抽出来之后 `tests/filetypes.test.ts` 可以断言「附件的每个扩展名都在白名单里」，
 * 让漂移在测试里当场暴露，而不是等用户看到裂图。
 */

/** 允许 `/api/file` 读取的扩展名。白名单之外的**一律 403**（防任意文件读取）。 */
export const ALLOWED_FILE_EXT: ReadonlySet<string> = new Set([
  // 图片（attachments.ts 会外置成这些扩展名，见文件头说明）
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif",
  // 表格与文档
  ".csv", ".xlsx", ".xls", ".docx", ".doc", ".pdf",
  // 媒体与压缩包
  ".mp4", ".zip",
  // 纯文本与配置
  ".txt", ".json", ".md", ".html", ".htm", ".log", ".xml",
  ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".sql", ".env", ".gitignore",
  // 代码
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css",
  ".py", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".hpp", ".cs",
  ".sh", ".bat", ".ps1",
])

/** 扩展名 → `Content-Type`。表里没有的走 `application/octet-stream`。 */
export const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".json": "application/json",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".log": "text/plain",
  ".xml": "text/xml",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".jsx": "text/plain",
  ".css": "text/css",
  ".py": "text/plain",
  ".java": "text/plain",
  ".go": "text/plain",
  ".rs": "text/plain",
  ".c": "text/plain",
  ".cpp": "text/plain",
  ".h": "text/plain",
  ".hpp": "text/plain",
  ".cs": "text/plain",
  ".sh": "text/plain",
  ".bat": "text/plain",
  ".ps1": "text/plain",
  ".yml": "text/plain",
  ".yaml": "text/plain",
  ".toml": "text/plain",
  ".ini": "text/plain",
  ".cfg": "text/plain",
  ".conf": "text/plain",
  ".sql": "text/plain",
  ".env": "text/plain",
  ".gitignore": "text/plain",
}

/** 白名单判定。传入的 `ext` 必须已经小写且带点（与 `path.extname()` 的输出一致）。 */
export function isAllowedFileExt(ext: string): boolean {
  return ALLOWED_FILE_EXT.has(ext)
}
