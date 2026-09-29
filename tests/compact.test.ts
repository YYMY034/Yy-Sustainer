/**
 * T93：上下文压缩的不变量守卫。
 *
 * 起因是「长任务优化」这一轮的四条改动，每一条都属于「改错了也不会当场报错、
 * 只会让长任务慢慢变坏」的类型：
 *
 * 1. 压缩结果要落库（原来每轮从全量重压，成本 O(n²)）
 * 2. 摘要两条消息的 ts 必须排在保留消息之前（否则写回会话后顺序错乱）
 * 3. 正文拍平不能产出 "[object Object]"（多模态消息一旦进来就毁历史）
 * 4. 超长裁剪必须保留「开头 + 结尾」（原来 slice(0, 60000) 砍掉的正是最近的内容）
 *
 * 前三条在 `src/agent/compact.ts` 里做成了纯函数，就是为了能在这里钉死——
 * 埋在 compactHistory 里的话，要发一次真实 LLM 请求才能间接验证，等于没法验证。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  KEEP_RECENT,
  TRANSCRIPT_MAX,
  buildCompactedStored,
  contentToText,
  fitTranscript,
  isRollingSummary,
  normalizeSummaryText,
  summaryBody,
  toStoredLike,
  dropOrphanToolMessages,
  MID_TURN_MIN_GAP_STEPS,
  MID_TURN_RATIO,
  type HistoryMessage,
} from "../src/agent/compact.js"

const msg = (role: "user" | "assistant", content: unknown, ts?: number): HistoryMessage =>
  ({ role, content, ...(ts === undefined ? {} : { ts }) }) as HistoryMessage

test("摘要两条消息的 ts 严格小于第一条保留消息（顺序守卫）", () => {
  const recent = [msg("user", "最近一", 1000), msg("assistant", "最近二", 2000)]
  const stored = buildCompactedStored("摘要正文", recent)
  assert.equal(stored.length, 2 + recent.length)
  assert.ok(stored[0].content.startsWith("[滚动摘要]"))
  assert.ok(stored[1].content.includes("已了解历史上下文"))
  const tsList = stored.map((m) => m.ts)
  for (let i = 1; i < tsList.length; i++) {
    assert.ok(tsList[i] > tsList[i - 1], `ts 必须严格递增，实际：${tsList.join(",")}`)
  }
})

test("保留消息没有 ts 时也维持顺序（不能拿 Date.now() 把摘要挤到后面）", () => {
  const recent = [msg("user", "无 ts 的一条"), msg("assistant", "无 ts 的二条")]
  const stored = buildCompactedStored("摘要正文", recent)
  const tsList = stored.map((m) => m.ts)
  for (let i = 1; i < tsList.length; i++) {
    assert.ok(tsList[i] >= tsList[i - 1], `ts 不能倒挂，实际：${tsList.join(",")}`)
  }
  assert.ok(stored[0].ts <= stored[2].ts, "摘要必须排在保留消息之前")
})

test("落库形态只产出 user/assistant（压缩结果要能直接写回会话）", () => {
  const recent = [msg("user", "a", 10), msg("assistant", "b", 20)]
  for (const m of buildCompactedStored("s", recent)) {
    assert.ok(m.role === "user" || m.role === "assistant", `非法 role: ${m.role}`)
    assert.equal(typeof m.content, "string")
    assert.equal(typeof m.ts, "number")
  }
})

test("多模态 content 拍平成文本，不产出 [object Object]", () => {
  const parts = [
    { type: "text", text: "看看这张图" },
    { type: "image", image: "data:image/png;base64,AAAA" },
    { type: "text", text: "有问题吗" },
  ]
  const out = contentToText(parts)
  assert.equal(out.includes("[object Object]"), false, `拍平结果里出现了 [object Object]：${out}`)
  assert.ok(out.includes("看看这张图"))
  assert.ok(out.includes("有问题吗"))
  assert.ok(out.includes("[图片]"), "图片占位要保留，否则摘要会以为这里什么都没有")
  // 直接 String() 就是原来的行为，作为对照留在这里
  assert.equal(String(parts).includes("[object Object]"), true)
})

test("contentToText 兜住 null / undefined / 对象 / 数字", () => {
  assert.equal(contentToText(null), "")
  assert.equal(contentToText(undefined), "")
  assert.equal(contentToText(""), "")
  assert.equal(contentToText(42), "42")
  assert.equal(contentToText({ type: "text", text: "x" }).includes("[object Object]"), false)
})

test("超长正文保留「开头 + 结尾」，而不是只留开头（近期内容优先）", () => {
  const head = "【任务目标】把三份报表合并成一份"
  const tail = "【当前状态】最后一步在跑第 7 项"
  const filler = "x".repeat(TRANSCRIPT_MAX * 2)
  const out = fitTranscript(`${head}${filler}${tail}`)
  assert.ok(out.length < TRANSCRIPT_MAX + 200, `裁剪后仍过长：${out.length}`)
  assert.ok(out.startsWith(head), "开头（任务目标）被砍掉了")
  assert.ok(out.endsWith(tail), "结尾（当前状态）被砍掉了——这正是原来 slice(0,60000) 的问题")
  assert.ok(out.includes("省略"), "裁剪处要有说明，否则摘要模型会以为内容本来就断在这")
})

test("不超长时 fitTranscript 一个字符都不动", () => {
  const s = "短的".repeat(10)
  assert.equal(fitTranscript(s), s)
})

test("滚动摘要的识别与正文提取（含更早的 [历史摘要] 写法）", () => {
  assert.equal(isRollingSummary(msg("user", "[滚动摘要]\n任务目标：X")), true)
  assert.equal(isRollingSummary(msg("user", "[历史摘要]\n任务目标：X")), true)
  assert.equal(isRollingSummary(msg("assistant", "[滚动摘要]\nX")), false, "assistant 不算摘要消息")
  assert.equal(isRollingSummary(msg("user", "普通用户消息")), false)
  assert.equal(isRollingSummary(undefined), false)
  assert.equal(summaryBody("[滚动摘要]\n任务目标：X"), "任务目标：X")
  assert.equal(summaryBody("[历史摘要]任务目标：X"), "任务目标：X")
})

test("摘要不会被当成普通消息重新摘要进去（合并基础要对）", () => {
  // 压缩后落库的第一条就是摘要，下一轮压缩必须认出它、把它当 base 而不是当新消息
  const stored = buildCompactedStored("上一轮的结论", [msg("user", "新的一问", 5000)])
  const first = stored[0] as unknown as HistoryMessage
  assert.equal(isRollingSummary(first), true)
  assert.equal(summaryBody(first.content), "上一轮的结论")
})

test("toStoredLike 对 ts 缺失用锚点兜底（可预测，不用 Date.now()）", () => {
  assert.equal(toStoredLike(msg("assistant", "x"), 777).ts, 777)
  assert.equal(toStoredLike(msg("assistant", "x", 5), 777).ts, 5)
})

test("KEEP_RECENT 与摘要两条的关系写死：保留段不能短于 1", () => {
  // 压缩的收益前提是「砍掉的比留下的多」；KEEP_RECENT 太小会让压缩每轮都触发，
  // 太大会让压缩没意义。这里只钉住它是个正整数（真正的取值由 compactHistory 的
  // `history.length <= KEEP_RECENT + 2` 早退条件兜住）。
  assert.ok(Number.isInteger(KEEP_RECENT) && KEEP_RECENT > 0, `KEEP_RECENT 非法：${KEEP_RECENT}`)
})

// ---------- 回合内压缩 ----------

const m = (role: string, content = "x"): { role: string; content: string } => ({ role, content })

test("**丢掉开头孤立的 tool 消息**（不丢的话上游直接报错）", () => {
  const list = [m("tool"), m("tool"), m("assistant"), m("tool"), m("user")]
  assert.deepEqual(dropOrphanToolMessages(list).map((x) => x.role), ["assistant", "tool", "user"])
})

test("开头不是 tool 时原样返回（不白拷一份）", () => {
  const list = [m("user"), m("assistant"), m("tool")]
  assert.equal(dropOrphanToolMessages(list), list, "同一个引用也该原样返回")
})

test("全是 tool 消息时退化成空数组（不能留着一段没有调用的结果）", () => {
  assert.deepEqual(dropOrphanToolMessages([m("tool"), m("tool")]), [])
  assert.deepEqual(dropOrphanToolMessages([]), [])
})

test("配对完整性：后缀保留后不会出现「结果在、调用不在」", () => {
  // 模拟一个真实回合中段的 message list：assistant 发起调用 → tool 结果 → …
  const mid = [
    m("user", "任务"),
    m("assistant", "调用1"),
    m("tool", "结果1"),
    m("assistant", "调用2"),
    m("tool", "结果2"),
  ]
  // 压缩保留后 6 条 = 全部；再模拟只留后 4 条（开头是 tool）
  const kept = mid.slice(-4)
  const cleaned = dropOrphanToolMessages(kept)
  // 结果必须跟在某个 assistant 后面，不能是第一个
  assert.notEqual(cleaned[0]?.role, "tool", "开头不能是 tool 结果")
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i].role === "tool") {
      assert.ok(i > 0 && cleaned[i - 1].role === "assistant", `第 ${i} 条 tool 结果前面不是它的调用`)
    }
  }
})

test("回合内压缩阈值比回合间宽松（每次压缩都要花一次模型调用）", () => {
  assert.ok(MID_TURN_RATIO > 0.6, `回合内阈值 ${MID_TURN_RATIO} 不该比回合间的 0.6 更严`)
  assert.ok(MID_TURN_RATIO < 1, "阈值不能是 1——那等于永不压缩")
  assert.ok(MID_TURN_MIN_GAP_STEPS >= 2, `压缩间隔 {MID_TURN_MIN_GAP_STEPS} 步太小，等于步步压`)
})

// ---------- 工具 part 的拍平（白皮书 10.31 真模型实测抓到的 bug 回归） ----------

test("工具调用 part → 可读文本，不是「[图片]」（压缩后模型不能对着幽灵图片跑偏）", () => {
  // AI SDK v5 的 part 没有 .text 字段——早先一律落成「[图片]」，真模型实测因此产生
  // 「图床返回是空的」幻觉。v5 参数在 input，旧形状 args 也认。
  const v5 = contentToText([{ type: "tool-call", toolCallId: "t1", toolName: "read", input: { path: "src/mcp/client.ts" } }])
  assert.match(v5, /^\[调用 read\(/, v5)
  assert.ok(v5.includes("src/mcp/client.ts"), v5)
  const legacy = contentToText([{ type: "tool-call", toolCallId: "t1", toolName: "bash", args: { command: "ls" } }])
  assert.match(legacy, /^\[调用 bash\(/, legacy)
})

test("工具结果 part → 带内容摘要，不是「[图片]」", () => {
  // v5：output={type:"text",value}；旧形状：result 字符串
  const v5 = contentToText([{ type: "tool-result", toolCallId: "t1", output: { type: "text", value: "文件前 40 行内容…" } }])
  assert.match(v5, /^\[工具结果\] /, v5)
  assert.ok(v5.includes("文件前 40 行内容"), v5)
  const legacy = contentToText([{ type: "tool-result", toolCallId: "t1", result: "旧形状结果" }])
  assert.ok(legacy.includes("旧形状结果"), legacy)
})

test("**只有真的图片 part 才给「[图片]」占位**（占位的本意是「别以为这里什么都没有」）", () => {
  assert.equal(contentToText([{ type: "image", image: "https://x/y.png" }]), "[图片]")
  assert.equal(contentToText([{ type: "file", data: "..." }]), "[非文本内容]")
  assert.equal(contentToText([{ type: "reasoning", text: "思考" }]), "思考")
})

test("端到端：压缩落库形态里不出现裸「[图片]」冒充工具消息", () => {
  // 模拟中段 messages：用户任务 → assistant 文本+工具调用 → tool 结果 → …
  const mid: HistoryMessage[] = [
    msg("user", "审阅这三个目录", 1000),
    msg("assistant", "好，先 glob", 1100),
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: { type: "text", value: "src/mcp/client.ts\nsrc/mcp/intent.ts" } }], ts: 1200 } as HistoryMessage,
    msg("assistant", "再 read", 1300),
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t2", output: { type: "text", value: "import ..." } }], ts: 1400 } as HistoryMessage,
  ]
  const stored = buildCompactedStored("已 glob 并读了两个文件", mid)
  const texts = stored.map((s) => String(s.content))
  // 每条工具结果都能看出「干了什么」，没有任何一条是光秃秃的「[图片]」
  assert.ok(texts.some((t) => t.includes("[工具结果]") && t.includes("src/mcp/client.ts")), JSON.stringify(texts))
  assert.ok(!texts.some((t) => t.trim() === "[图片]"), `出现了冒充工具消息的裸占位：${JSON.stringify(texts)}`)
})

// ---------- 摘要 JSON 壳剥离（09-23 多轮实测：弱模型输出 {"summary":"..."}） ----------
test("JSON 壳剥掉，只留摘要正文", () => {
  const wrapped = JSON.stringify({ summary: "任务目标：审阅三个目录。已完成：glob 定位 11 个文件。" })
  assert.equal(normalizeSummaryText(wrapped), "任务目标：审阅三个目录。已完成：glob 定位 11 个文件。")
})

test("非 JSON / 坏 JSON / 没有 summary 字段 → 原样返回", () => {
  assert.equal(normalizeSummaryText("普通摘要文本"), "普通摘要文本")
  assert.equal(normalizeSummaryText("{ 坏 JSON"), "{ 坏 JSON")
  assert.equal(normalizeSummaryText(JSON.stringify({ text: "x" })), JSON.stringify({ text: "x" }))
  assert.equal(normalizeSummaryText("  带头尾空白的摘要  "), "带头尾空白的摘要")
})
