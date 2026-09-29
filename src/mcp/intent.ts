/**
 * MCP 工具按需加载的意图判定（纯函数，零依赖，可单测）。
 *
 * 为什么需要：白皮书 10.27 量出每步固定开销 ≈24k token（与任务大小无关），
 * 10.29 的拆解探针把它拆开——其中 **MCP 浏览器工具 35 个 ≈4.3k token/步**，
 * 而 `ensureDefaultMcpServers()` 给每个新用户默认种下 edge + tabbit 两个
 * 浏览器自动化服务器。纯文件/编码任务永远用不到它们，却每一步都在为这 35 个
 * schema 付钱（50 步长任务 ≈21 万输入 token 纯浪费）。
 *
 * 设计取舍（用户已确认「按意图自动 + 手动开」）：
 * - **误判加载**（没必要却加载了）：只多花 token，不坏事——倾向宁可多加载。
 * - **误判不加载**（需要却没加载）：浏览器任务做不了。缓解：模型会照系统提示词
 *   的礼仪明说「浏览器工具未启用，可在设置里开」，用户一句话即可手动开。
 * 所以关键词覆盖「明确指向浏览器/网页操作」的表达，不追求覆盖所有间接说法。
 *
 * 三态解析（override 优先于意图，与「手动开」的产品决策一致）：
 * - override === true  → 强制加载（用户显式开了）
 * - override === false → 强制不加载（用户显式关了）
 * - override === undefined → 按意图自动判定
 */

/** 默认意图词：命中任意一个即认为本轮想用浏览器自动化。
 *  大小写不敏感；中英混排。几条边界取舍（误加载只多花 token，漏加载任务失败，
 *  所以偏向「宁可多命中」，但明显泛化的词不收）：
 *  - 收「网页」不收「页面」：「这个网页打不开」是浏览器任务，「这个页面很慢」是代码任务
 *  - 不收裸「edge」：代码讨论里 "edge case" 太常见（用户说 Edge 浏览器时基本会带「浏览器」）
 *  - 收「爬虫」：写爬虫脚本与跑爬虫都可能要浏览器（JS 渲染页面），且用户明说「只写思路」时
 *    代价仅是那一轮多带工具，可接受 */
export const DEFAULT_MCP_KEYWORDS: readonly string[] = [
  // 中文：明确指向浏览器/网页操作
  "浏览器", "网页", "网址", "链接", "点击页面",
  "填表", "填写表单", "网页截图", "页面截图", "截个图",
  "爬虫", "爬取", "抓取网页", "抓一下网", "模拟登录", "自动登录", "登录一下",
  "操控浏览器", "浏览器自动化", "无头浏览器",
  // 英文与产品名（playwright/tabbit 是本仓库默认种的两个 MCP 服务器名）
  "playwright", "tabbit",
  "browser", "web page", "webpage", "web site", "website", "screenshot",
  "headless", "puppeteer", "selenium",
]

export interface McpLoadDecision {
  load: boolean
  /** 人话原因——进 envScan 文案与日志，出问题能一眼看出为什么加载/没加载 */
  reason: string
  /** 命中的关键词（自动判定且加载时非空） */
  matched?: string
}

/** 文本是否命中浏览器意图。导出供单测与造错验证。 */
export function hasMcpIntent(text: string, keywords: readonly string[] = DEFAULT_MCP_KEYWORDS): string | undefined {
  if (!text) return undefined
  const lower = text.toLowerCase()
  return keywords.find((k) => lower.includes(k.toLowerCase()))
}

/**
 * 三态解析：override（会话手动开关）优先，否则按意图自动判。
 * keywords 可注入（测试/未来配置化），默认用 DEFAULT_MCP_KEYWORDS。
 */
export function resolveMcpLoading(text: string, override?: boolean, keywords: readonly string[] = DEFAULT_MCP_KEYWORDS): McpLoadDecision {
  if (override === true) return { load: true, reason: "会话已手动开启浏览器工具" }
  if (override === false) return { load: false, reason: "会话已手动关闭浏览器工具" }
  const matched = hasMcpIntent(text, keywords)
  if (matched) return { load: true, reason: `命中浏览器意图词「${matched}」`, matched }
  return { load: false, reason: "未命中浏览器意图词" }
}
