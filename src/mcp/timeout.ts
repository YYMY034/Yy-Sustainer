/**
 * T92 MCP 调用超时
 *
 * 先澄清一个曾经写进白皮书的**误判**：SDK 本来就有默认超时。
 * `@modelcontextprotocol/sdk` 的 `shared/protocol.js` 里是
 * `const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC`，而 `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`。
 * 所以「MCP callTool 无超时、服务端挂住会一直等」是错的——不传 options 也有 60 秒兜底。
 *
 * 真正的问题是那 60 秒**固定且不可调**，两头都不合适：
 *   · 太紧：`npx` 首次下载、浏览器自动化、大数据量查询，60 秒做不完是常态，
 *     被 SDK 判超时而中断，用户看到「工具失败」但其实是等得不够久；
 *   · 太死：服务端一直在报进度（说明它活着、在干活），照样被 60 秒一刀切。
 *
 * 所以策略是三件事：
 *   ① 超时可配（`config.mcpTimeoutMs`，默认 120 秒，比 SDK 的 60 秒宽松一倍）；
 *   ② 打开 `resetTimeoutOnProgress`——只要服务端还在报进度就重新计时；
 *   ③ 给一个总时长硬上限（30 分钟）兜底，防止「一直报进度」变成永远不结束。
 *
 * 这个文件刻意做成**零依赖纯函数**：便于单测直接盯着「超时判定」和「文案」，
 * 不用去拉 MCP SDK 或 tools.ts 那一大坨依赖。
 */

/** 默认单次请求超时（毫秒）。SDK 是 60s，这里放宽到 120s 覆盖慢工具 */
export const MCP_DEFAULT_TIMEOUT_MS = 120_000

/** 总时长硬上限：即使一直有进度通知也不超过它 */
export const MCP_MAX_TOTAL_MS = 30 * 60_000

/** MCP 协议里「请求超时」的错误码（`ErrorCode.RequestTimeout`） */
export const MCP_REQUEST_TIMEOUT_CODE = -32001

/** 把配置值规范化成可用的超时毫秒数（非法 / 非正数 → 默认值） */
export function resolveMcpTimeoutMs(configured: unknown): number {
  const v = Number(configured)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : MCP_DEFAULT_TIMEOUT_MS
}

/** 这个错误是不是「超时」 */
export function isMcpTimeout(e: unknown): boolean {
  if (!e || typeof e !== "object") return false
  const code = (e as { code?: unknown }).code
  if (code === MCP_REQUEST_TIMEOUT_CODE) return true
  const msg = (e as { message?: unknown }).message
  return typeof msg === "string" && /timed?\s*out|timeout/i.test(msg)
}

/**
 * 把 MCP 调用异常翻译成用户能看懂、能动手的提示。
 * 超时必须说清「等了多久」「可能是什么原因」「怎么改」——
 * 光回一句 `Request timed out` 用户只能干瞪眼。
 */
export function mcpCallErrorText(server: string, tool: string, e: unknown, timeoutMs: number): string {
  const msg = (e as { message?: unknown })?.message
  const detail = typeof msg === "string" && msg ? msg : String(e)
  if (isMcpTimeout(e)) {
    const sec = Math.round(timeoutMs / 1000)
    return (
      `MCP 工具 ${server}/${tool} 超过 ${sec} 秒仍未返回，已中断本次调用。` +
      `常见原因：该 MCP server 启动慢（如 npx 首次下载依赖）、或它真的卡住了。` +
      `可调大配置 mcpTimeoutMs，或检查这个 server 是否正常。`
    )
  }
  return `MCP 工具 ${server}/${tool} 调用失败：${detail}`
}
