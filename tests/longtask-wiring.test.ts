/**
 * T93：长任务链路的「接线」守卫（静态）。
 *
 * 这一轮修的五个问题有同一个形状：**东西都写好了，就是没接上**——
 *   · `CONVERGE_MAX_STEPS` 声明了，没有任何地方用
 *   · `config.longTask` 开关写了配置，没有任何地方读
 *   · `compactHistory` 算出压缩结果，调用方落库时用的是原始历史
 *   · `delegate` 起子代理，不传 signal / sessionId / broker
 *   · `onStep` 每步都在回调，gateway 没接
 *
 * 这类问题**语法正确、类型正确、跑起来也不报错**，只有真的跑一次长任务才可能发现。
 * 所以用静态断言钉住「这个符号必须至少被引用 N 次」「这条语句必须存在」。
 *
 * 断言取「调用形式」而不是「函数名」：本轮踩过 `grep gate` 命中 `delegate` 的坑。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (p: string): string => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8")
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length

const loop = read("src/agent/loop.ts")
const gateway = read("src/gateway.ts")
const tools = read("src/agent/tools.ts")
const config = read("src/agent/config.ts")
const store = read("src/session/store.ts")
const intent = read("src/mcp/intent.ts")

test("CONVERGE_MAX_STEPS 真的被用上了（不是又一个「声明了没人用」）", () => {
  const n = count(loop, /CONVERGE_MAX_STEPS/g)
  assert.ok(n >= 2, `CONVERGE_MAX_STEPS 只出现 ${n} 次——声明处 1 次意味着仍然没人用`)
  assert.match(loop, /stopWhen: \[stepCountIs\(CONVERGE_MAX_STEPS\)/, "收敛续跑必须带步数上限")
})

test("收敛续跑 runConverge 有 stopWhen（原来这一段一个停止条件都没有）", () => {
  const start = loop.indexOf("async function runConverge")
  const end = loop.indexOf("async function prepare")
  assert.ok(start > 0 && end > start, "找不到 runConverge 函数体")
  const body = loop.slice(start, end)
  assert.match(body, /stopWhen:/, "runConverge 的 streamText 没有 stopWhen——续跑段能无限跑下去")
  assert.match(body, /convergeTimeoutIs\(prep\.convergeTimeoutMs\)/, "续跑段要与主轮同源的收敛时限")
})

test("压缩判定用上一轮真实用量，不是只数消息正文", () => {
  const start = loop.indexOf("async function compactHistory")
  const end = loop.indexOf("interface Prepared")
  assert.ok(start > 0 && end > start, "找不到 compactHistory 函数体")
  const body = loop.slice(start, end)
  assert.match(body, /lastInputTokens/, "压缩判定没接 lastInputTokens——系统提示与工具定义的开销会被漏掉")
  assert.match(body, /Math\.max\(count, /, "正文计数只能当下限（真实用量是实测值，必须取 max）")
})

test("压缩结果回传给调用方落库（compactedStored 贯通 Prepared → AgentResult）", () => {
  assert.match(loop, /compactedStored\?: StoredLike\[\]/, "AgentResult 必须带 compactedStored")
  assert.match(loop, /compactedStored: compact\.stored/, "Prepared 必须把 compactHistory 的 stored 传下去")
  // 三个返回点（正常 / 两处 abort）都要带上，否则停止时压缩又白做。
  // T93 回合内压缩后统一走 finalStored()：回合内压过就用回合内那份（更新），没压过才用回合开始前那份。
  const n = count(loop, /compactedStored: finalStored\(\)/g)
  assert.ok(n >= 3, `只有 ${n} 处返回带 compactedStored: finalStored()，应覆盖正常返回 + 两处 abort 返回`)
  assert.match(loop, /const \{ compactedStored, \.\.\.modelOpts \} = prep/, "compactedStored 不是 AI SDK 选项，展开给 streamText 前必须摘掉")
})

// ---------- T93 回合内压缩（prepareStep，把「撞墙后才省」变成「看着要满就省」） ----------

const compact = read("src/agent/compact.ts")

test("回合内压缩真的接在 prepareStep 上（只在 prepare() 里压一次，50 步的回合照样涨到上游 400）", () => {
  assert.match(loop, /prepareStep: async \(\{ steps: doneSteps, messages \}\) => \{/, "没有 prepareStep——回合开始后就没有第二次压缩机会了")
  // 限流：每步都压一次 = 每步都多花一次模型调用
  assert.match(
    loop,
    /if \(doneSteps\.length - lastMidTurnStep < MID_TURN_MIN_GAP_STEPS\) return undefined/,
    "回合内压缩没限流——每步触发会把压缩本身变成最大开销",
  )
})

test("回合内压缩用上一步的真实输入量判定（数消息条数会漏掉系统提示与工具定义）", () => {
  assert.match(loop, /const lastInput = doneSteps\[doneSteps\.length - 1\]\?\.usage\?\.inputTokens \?\? 0/, "没取上一步真实 inputTokens")
  assert.match(
    loop,
    /const budget = Math\.floor\(\(loadConfig\(\)\.contextTokens \?\? 131_072\) \* MID_TURN_RATIO\)/,
    "门槛没接 contextTokens 配置",
  )
  assert.match(compact, /export const MID_TURN_RATIO = 0\.75/)
  assert.match(compact, /export const MID_TURN_MIN_GAP_STEPS = 6/)
})

test("回合内压缩的结果单独存（prep.compactedStored 不会自己流进来，不单独存就白压）", () => {
  assert.match(loop, /let midTurnStored: StoredLike\[\] \| undefined/, "没有 midTurnStored")
  // 必须是函数：写成 const 会在声明时就地求值，midTurnStored 那时还是 undefined，
  // 结果永远是「回合开始前那份」——回合内压的那次又被丢掉（这个坑真踩过）
  assert.match(
    loop,
    /const finalStored = \(\): StoredLike\[\] \| undefined => midTurnStored \?\? compactedStored/,
    "finalStored 必须是函数，且优先取回合内那份",
  )
})

test("回合内压缩的可观测性：压缩过程对用户可见，结果进 checkpoint", () => {
  const psStart = loop.indexOf("prepareStep: async")
  const psEnd = loop.indexOf("onAbort:", psStart)
  assert.ok(psStart > 0 && psEnd > psStart, "找不到 prepareStep 函数体")
  const body = loop.slice(psStart, psEnd)
  // 压缩本身要花一次模型调用，用户得看见（onCompact 是压缩摘要的可见性回调）
  assert.match(body, /compactHistory\([\s\S]{0,300}handlers\.onCompact\b(?!\w)/, "回合内压缩没复用 onCompact——用户看不到这一分钟的等待")
  assert.match(body, /midTurnStored = stored/, "回合内压缩没记下落库形态")
  // gateway/TUI 靠 onCompactedStored 把它写进 checkpoint，否则中断恢复后这轮压缩白做
  assert.match(body, /handlers\.onCompactedStored\?\.\(stored\)/, "回合内压缩没广播压缩结果")
})

test("没压动的就别换（更长了/空的换过去白多一次失败）", () => {
  assert.match(loop, /if \(!stored \|\| !compacted\.length \|\| compacted\.length >= messages\.length\) return undefined/)
})

test("保留后缀后丢掉开头的孤儿 tool 消息（不丢掉上游直接报错）", () => {
  assert.match(loop, /return \{ messages: dropOrphanToolMessages\(compacted\) \}/, "prepareStep 里没走 dropOrphanToolMessages")
  assert.match(compact, /export function dropOrphanToolMessages<T extends \{ role\?: unknown \}>/, "compact.ts 没导出 dropOrphanToolMessages")
})

// ---------- 白皮书 10.29：MCP 浏览器工具按需加载（35 个 ≈4.3k token/步） ----------

test("MCP 按需加载接在 prepare() 上，且 compactBase 内部调用恒不加载", () => {
  // 意图判定必须是纯函数、单独模块（单测直接盯关键词，不用起网关）
  assert.match(loop, /import \{ resolveMcpLoading \} from "\.\.\/mcp\/intent\.js"/, "loop 没接意图判定模块")
  assert.match(loop, /const mcpDecision = opts\.compactBase/, "compactBase 内部调用没豁免——拆分器拿用户数据文本跑意图匹配会误触发")
  assert.match(loop, /: resolveMcpLoading\(opts\.mcpText \?\? prompt, opts\.mcpOn\)/, "主路径没走三态判定（override 优先，否则按意图；判定文本默认 prompt、可被 mcpText 覆盖）")
  // 关键接线：不加载就连 loadMcpTools 都不调（省掉 spawn 两个 MCP 进程）
  assert.match(loop, /mcpDecision\.load && !opts\.tools/, "没有「不加载就不连 MCP」的门")
  assert.match(loop, /\? await loadMcpTools\(\)/, "加载分支没了")
})

test("三态判定：override 优先于意图，原因进人话", () => {
  assert.match(intent, /export function resolveMcpLoading/)
  assert.match(intent, /override === true\) return \{ load: true/, "手动开没被优先处理")
  assert.match(intent, /override === false\) return \{ load: false/, "手动关没被优先处理")
  assert.match(intent, /const matched = hasMcpIntent\(text, keywords\)/, "没走关键词匹配")
})

test("网关：envScan 与 loop 的工具面共用同一个判定（文案不能说「有工具」却没有）", () => {
  assert.match(gateway, /const mcpDecision = resolveMcpLoading\(text, meta\.mcpOn\)/, "网关没算判定")
  assert.match(gateway, /envScanPrompt\(meta\.cwd, mcpDecision\.load\)/, "envScan 没拿真实加载态")
  assert.match(gateway, /mcpOn: meta\.mcpOn,/, "runAgentStream 没透传会话手动开关")
  // envScan 的缓存 key 必须含加载态——否则同 cwd 两个会话一个开一个关会拿到同一段文案
  assert.match(gateway, /const cacheKey = `\$\{cwd\}\|mcp:\$\{mcpActive \? "on" : "off"\}`/, "envScan 缓存 key 没含 mcpActive——两个会话会串文案")
  // 未加载时的文案必须说清「有这套能力 + 怎么用上」，不能只说没有
  assert.match(gateway, /已配备浏览器自动化[\s\S]{0,80}本轮未启用/, "未启用文案没说清怎么用上")
})

test("MCP 三态路由：嵌套形状 + 排在通用会话路由之前 + null=回自动", () => {
  assert.match(gateway, /p\.match\(\/\^\\\/api\\\/sessions\\\/\(\[\\w-\]\+\)\\\/mcp\$\/\)/, "没有嵌套形状的 /api/sessions/{id}/mcp 路由")
  // 平铺形状是 /api/longtask 那种历史遗留，不许再做
  assert.equal(gateway.includes('p === "/api/mcp/toggle"'), false, "又做了平铺路由")
  // 路由必须在通用 /api/sessions/{id} 之前（字面量会被正则吃掉——checkpoint 踩过）
  const mcpAt = gateway.indexOf("\\/api\\/sessions\\/([\\w-]+)\\/mcp$")
  const genericAt = gateway.indexOf('mt = p.match(/^\\/api\\/sessions\\/([\\w-]+)$/)')
  assert.ok(mcpAt > 0 && genericAt > mcpAt, "MCP 路由排在通用会话路由之后——会被当成会话 id 吃掉")
  // 三态契约：true/false 写 meta，null 删字段回自动，其它值 400
  assert.match(gateway, /if \(on === true \|\| on === false\) f\.meta\.mcpOn = on/, "没接 true/false")
  assert.match(gateway, /else if \(on === null\) delete f\.meta\.mcpOn/, "null 没删字段——回不了自动")
  assert.match(gateway, /on 只能是 true \/ false \/ null/, "非法值没有明确报错")
  assert.match(gateway, /persist\(f\.meta, f\.messages\)/, "开关没落库——重启即丢（longTask 的教训）")
  // meta 字段本身
  assert.match(store, /mcpOn\?: boolean/, "SessionMeta 没有 mcpOn")
})

test("意图判定跑原始用户输入，不跑注入后的拼接文本（否则主对话提「网页」会污染辅助对话）", () => {
  assert.match(loop, /resolveMcpLoading\(opts\.mcpText \?\? prompt, opts\.mcpOn\)/, "loop 没接 mcpText 覆盖")
  assert.match(loop, /mcpText\?: string/, "AgentOptions 没有 mcpText 字段")
  // TUI 两个注入点（配置会话 / 辅助对话快照）都必须传原始 text
  assert.equal(count(tui, /mcpText: text/g), 2, `TUI 有 ${count(tui, /mcpText: text/g)} 处传 mcpText，应为 2（主对话 + 辅助对话）`)
  // 网关传的就是原始用户文本（runTurn 的 text 参数），不需要 mcpText 覆盖——
  // 但必须真的把 text 原样交给 runAgentStream，不能在任何路径上替换它
  assert.match(gateway, /r = await runAgentStream\(\s*text,/, "网关没把原始 text 交给 runAgentStream")
})

test("TUI：/mcp 三态命令 + 两个 runAgentStream 调用点都透传 mcpOn/mcpText", () => {
  assert.match(tui, /case "mcp": \{/, "TUI 没有 /mcp 命令")
  assert.match(tui, /args\[0\] === "auto"\)[\s\S]{0,120}delete m\.mcpOn/, "/mcp auto 没删字段")
  assert.match(tui, /updateActive\(\(m\) => \(m\.mcpOn = on\), messages\)/, "/mcp on|off 没写 meta")
  assert.equal(count(tui, /mcpOn: active\.mcpOn/g) + count(tui, /mcpOn: target\.mcpOn/g), 2, "TUI 两个 runAgentStream 调用点（主对话 + 辅助对话）都要透传 mcpOn")
})

test("Web：三态按钮 + 换会话同步 + 循环切换语义", () => {  assert.ok(web.includes('id="mcpBtn"'), "没有 #mcpBtn 元素")
  assert.match(web, /async function syncMcpState\(\)/, "没有 syncMcpState")
  assert.match(web, /fetch\(`\/api\/sessions\/\$\{encodeURIComponent\(activeId\)\}\/mcp`\)/, "没拉三态")
  assert.match(web, /syncMcpState\(\) \/\/ 白皮书 10\.29：换会话同步浏览器工具三态/, "换会话时没同步浏览器工具状态")
  // 循环：自动 → 开 → 关 → 自动
  assert.match(web, /const next = mcpOn === true \? false : mcpOn === false \? null : true/, "单击循环语义不对")
  assert.match(web, /\/api\/sessions\/\$\{encodeURIComponent\(activeId\)\}\/mcp`[\s\S]{0,200}body: JSON\.stringify\(\{ on: next \}\)/, "POST 没带三态 on")
  assert.match(web, /#mcpBtn\.off \{ opacity: 0\.55; \}/, "关闭态没有视觉区分——用户分不清自动和关")
})

test("出错/中断路径也要记账（真模型实测：18 个工具调用后超时，usage 却显示 0/0）", () => {
  // T93 P3 只修了成功路径（r.usage 全是 0 → 用轮内累计）；catch 分支原来直接 persist，
  // 上游超时/HTTP 失败烧的真 token 不进 meta.usage 也不进账本——预算熔断看不见它。
  assert.match(gateway, /const accountErroredTurn = \(\): void =>/, "没有出错路径的记账函数")
  // catch 一进来就记（abort 与 error 两个分支之前），两个分支的 persist 才都带上
  assert.match(gateway, /\} catch \(e\) \{\n\s*const err = e as Error\n\s*const dinfo = describeFailure\(e\)\n(?:\s*\/\/[^\n]*\n)*\s*accountErroredTurn\(\)/, "catch 里没调 accountErroredTurn")
  // 必须 turnTokens（轮内按步累计），不能拿 r.usage——出错时 r 是 null
  assert.match(gateway, /meta\.usage = \{\n\s*in: u\.in \+ turnTokens\.in/, "accountErroredTurn 没用轮内累计")
  // 账本与 meta 同源（check-t45 守恒不变量）：appendUsage 的 in/out 必须与 meta 用同一份数
  assert.match(gateway, /appendUsage\(\{ ts: Date.now\(\), sessionId, model, in: turnTokens\.in, out: turnTokens\.out/, "账本行没用同一份数——守恒会被打破")
})

test("gateway 落库用压缩后的历史，而不是原始 msgsAfterUser", () => {
  assert.match(gateway, /const baseMsgs = r\?\.compactedStored \?\? msgsAfterUser/, "成功路径没接压缩结果")
  assert.match(gateway, /persist\(meta, finalMsgs\)/, "落库语句不见了")
  assert.match(gateway, /\[\.\.\.\(r\?\.compactedStored \?\? msgsAfterUser\), (errMsg|stopMsg)\]/, "出错/停止路径也要保住本轮已做的压缩")
})

test("长任务开关只有一处来源：会话 meta（不再有内存 Set 或死配置）", () => {
  assert.equal(count(gateway, /longTaskSessions/g), 0, "gateway 里不该再有 longTaskSessions —— 那正是重启即失效的第二份来源")
  assert.match(gateway, /convergeTimeoutMs: meta\.longTask \? 30 \* 60_000 : undefined/, "长任务判定要读会话 meta")
  assert.match(gateway, /f\.meta\.longTask = body\.on === true/, "/api/longtask 要写会话文件")
  assert.match(gateway, /persist\(f\.meta, f\.messages\)/, "/api/longtask 要落库（否则重启又丢）")
  assert.equal(/longTask\?: boolean/.test(config), false, "config.longTask 是死配置，必须删掉——留两处必然漂")
  assert.match(store, /longTask\?: boolean/, "SessionMeta 要有 longTask")
  assert.match(store, /lastInputTokens\?: number/, "SessionMeta 要有 lastInputTokens")
})

test("gateway 把真实用量存回 meta，供下一轮压缩判定", () => {
  assert.match(gateway, /if \(r\?\.usage\?\.in\) meta\.lastInputTokens = r\.usage\.in/)
})

test("delegate 给子代理透传 signal / sessionId / broker", () => {
  const start = tools.indexOf("export const delegateTool")
  assert.ok(start > 0, "找不到 delegateTool")
  const body = tools.slice(start, tools.indexOf("export interface ToolOptions"))
  assert.match(body, /signal: store\?\.signal/, "子代理没拿到 signal——主循环 abort 后它还在跑")
  assert.match(body, /sessionId: store\?\.sessionId/, "子代理没拿到 sessionId——todo_write 会落到全局 todo.json")
  assert.match(body, /broker: store\?\.broker/, "子代理没拿到 broker——它的权限确认问不到人")
  assert.match(tools, /signal\?: AbortSignal/, "ToolContext 要能携带 signal")
})

test("三处 toolCtx.run 的上下文都带上 signal", () => {
  const n = count(loop, /sessionId: opts\.sessionId, signal: opts\.signal \}/g)
  assert.equal(n, 3, `有 ${n} 处 toolCtx 上下文带了 signal，应为 3（runAgent / runAgentStream / runConverge）`)
})

test("toCoreMessages 带上 ts（压缩写回要靠它定位顺序）", () => {
  assert.match(store, /content: m\.content, ts: m\.ts/, "toCoreMessages 丢了 ts，压缩后消息顺序只能现编")
  assert.match(store, /export type CoreMessageWithTs = CoreMessage & \{ ts: number \}/)
})

// ---------- T93 P1 轮内 checkpoint ----------

const tui = read("src/tui/App.tsx")

test("回合一启动就写 checkpoint（否则「刚发起就被杀」仍无迹可寻）", () => {
  assert.match(gateway, /cpLastMs = Date\.now\(\)\s*\n\s*writeCp\(\)/, "轮开始时没有立即落第一个 checkpoint")
  assert.match(gateway, /setInterval\(\(\) => \{[\s\S]{0,200}writeCp\(\)/, "没有定时触发器（一个 bash 跑几分钟时只有步数触发是不够的）")
})

test("回合收尾一定清 checkpoint，否则下一个回合会读到上一个的残留", () => {
  assert.match(gateway, /clearInterval\(cpTimer\)/, "finally 里没有清定时器")
  assert.match(gateway, /clearInterval\(cpTimer\)\s*\n\s*clearCheckpoint\(sessionId\)/, "finally 里没有清 checkpoint")
  assert.match(tui, /clearInterval\(cpTimer\)\s*\n\s*clearCheckpoint\(active\.id\)/, "TUI 的 finally 里没有清 checkpoint")
})

test("checkpoint 路由必须排在通用 `/api/sessions/{id}` 之前（否则被当成会话 id 遮蔽）", () => {
  const literal = gateway.indexOf('p === "/api/sessions/checkpoints"')
  const generic = gateway.indexOf("mt = p.match(/^\\/api\\/sessions\\/([\\w-]+)$/)")
  assert.ok(literal > 0, "没有 checkpoints 路由")
  assert.ok(generic > literal, "字面路由排在通用路由之后 —— /api/sessions/checkpoints 会被当成 id=checkpoints 的会话查询")
})

test("resume 的三种动作都在，且有「双完成」护栏", () => {
  for (const a of ["adopt", "retry", "discard"]) {
    assert.ok(gateway.includes(`action === "${a}"`), `checkpoint 恢复缺少 ${a}`)
  }
  // 双完成：会话里已有更新的助手回复 → 这一轮其实跑完了，不能再 adopt（否则追加重复回复）
  assert.match(
    gateway,
    /file\.messages\.some\(\(mm\) => mm\.role === "assistant" && mm\.ts > c\.userTs\)/,
    "没有「这一轮其实已经完成」的护栏",
  )
  // 图片不入 checkpoint → retry 必须拒绝而不是静默丢图
  assert.match(gateway, /c\.images > 0/, "带图的轮次要能拒绝自动重发（不能悄悄丢图）")
})

test("网关启动扫残留 checkpoint 并广播可操作提示", () => {
  assert.match(gateway, /const cps = listCheckpoints\(\)/)
  assert.match(gateway, /\[断点\] 发现 \$\{cps\.length\} 个未完成的回合/)
  assert.match(gateway, /broadcast\(\{\s*type: "notice",/)
})

test("压缩结果必须进 checkpoint（否则中断恢复后这轮压缩白做）", () => {
  assert.match(gateway, /onCompactedStored: \(stored\) => \{[\s\S]{0,200}compactedThisTurn = /)
  assert.match(gateway, /compactedStored: compactedThisTurn/)
  assert.match(tui, /onCompactedStored: \(stored\) => \{[\s\S]{0,200}cpCompacted = /)
})

test("TUI 的流式正文有同步镜像（state 里读不到最新值，定时器写不了）", () => {
  assert.match(tui, /const streamedTextRef = useRef\(""\)/)
  assert.match(tui, /streamedTextRef\.current \+= d/)
  assert.match(tui, /streamedText: streamedTextRef\.current/)
})

test("双完成护栏的文案要指向撤回（活体探针曾在这里栽过：文案说「已完成」会让人以为该用恢复）", () => {
  assert.match(gateway, /action: "already-done"[\s\S]{0,400}撤回/, "护栏文案没告诉用户「想撤回该用撤回功能」")
  // 护栏必须三个动作共享（放在分支之前），而不是只在 adopt 里判一次
  const guardAt = gateway.indexOf('mm.role === "assistant" && mm.ts > c.userTs')
  const adoptAt = gateway.indexOf('action === "adopt"')
  assert.ok(guardAt > 0 && adoptAt > guardAt, "护栏判在 adopt 分支里 —— discard/retry 会绕过去")
})

// ---------- T93 P2 交互轮总超时 ----------

test("交互轮有总超时，且默认关（不替他决定）", () => {
  assert.match(gateway, /const interactiveTimeoutMs = loadConfig\(\)\.interactiveTimeoutMs \?\? 0/)
  assert.match(gateway, /interactiveTimeoutMs > 0\s*\n\s*\? setTimeout\(/, "超时定时器必须按配置决定装不装——默认 0 就不该装")
  assert.match(config, /interactiveTimeoutMs\?: number/, "config 里要有这个字段")
})

test("超时定时器在 finally 里清掉（否则留失效 handle）", () => {
  assert.match(gateway, /if \(turnTimeout\) clearTimeout\(turnTimeout\)/)
})

test("超时不能落成「已停止」——abort 会让 runAgentStream 早返回空 text，所以超时也走成功分支", () => {
  assert.match(gateway, /const stopOrTimeoutContent = \(\): string => \{/)
  assert.match(gateway, /if \(timedOut\) \{[\s\S]{0,300}已超时/, "超时落库文案必须说「已超时」")
  assert.match(gateway, /content: stopOrTimeoutContent\(\)/, "成功分支的助手消息要走这个函数，否则超时永远写成「已停止」")
  // 超时不算「任务完成」，不该发完成通知
  assert.match(gateway, /if \(!timedOut && \(durTurn >= 30_000 \|\| meta\.longTask\)\)/)
})

test("TUI 的交互轮也有总超时（两条入口一致）", () => {
  assert.match(tui, /interactiveTimeoutMs|turnTimeout|timedOut/, "TUI 没有接交互轮超时")
})

// ---------- T93 P2 步数进度与实时上下文 ----------

test("loop 的 onStep 必须带步序号与上限（否则前端永远显示不出「第 N/M 步」）", () => {
  assert.match(loop, /export interface StepProgress \{[\s\S]{0,200}step: number[\s\S]{0,120}maxSteps: number/)
  assert.match(loop, /Prepared 的?|maxSteps: number/, "Prepared 要带 maxSteps")
  // 三处 onStepFinish 都要构造 StepProgress
  assert.equal(count(loop, /maxSteps: (modelOpts\.maxSteps|CONVERGE_MAX_STEPS)/g), 3, "三处续跑/主轮的 onStep 都要带 maxSteps")
  // 真实输入 token 才是诚实的上下文来源
  assert.equal(count(loop, /inputTokens: step\.usage\?\.inputTokens \?\? 0/g), 3, "三处都要取 step.usage.inputTokens")
})

test("gateway/TUI 真的接了 onStep（这才是本轮的 bug：loop 报了没人接）", () => {
  assert.match(gateway, /onStep: \(\{ step, maxSteps, tools, inputTokens, outputTokens \}\) =>/, "gateway 没接 onStep")
  assert.match(gateway, /第 \$\{step\}\/\$\{maxSteps\} 步/, "状态文案里没有「第 N/M 步」")
  assert.match(gateway, /ctxPct: pctFromTokens\(liveCtxTokens\)/, "实时上下文占用没用真实 token 算")
  assert.match(gateway, /function pctFromTokens\(tokens: number\): number/)
  assert.match(tui, /onStep: \(\{ step, maxSteps, tools, inputTokens, outputTokens \}\) =>/, "TUI 没接 onStep")
})

test("续跑段报的上限是它自己的（不能冒称主轮的 maxSteps）", () => {
  assert.match(loop, /maxSteps: CONVERGE_MAX_STEPS/, "runConverge 必须报 CONVERGE_MAX_STEPS")
})

// ---------- T93 P2 前端断点恢复入口 ----------

const web = read("web/index.html")
const bgstore = read("src/agent/bgStore.ts")

test("前端有断点恢复横幅（元素 + 样式 + 三个动作按钮）", () => {
  assert.ok(web.includes('id="cpBar"'), "没有 #cpBar 元素")
  for (const act of ["adopt", "retry", "discard"]) {
    assert.ok(web.includes(`data-act="${act}"`), `缺少 ${act} 按钮`)
  }
  assert.match(web, /#cpBar\.show \{ display: flex; \}/, "没有 .show 样式——加了也不会显示")
  assert.ok(web.includes('id="cpBar"><span class="cpText">'), "横幅里没有文案容器")
})

test("前端真的去拉列表并接线（不是摆着看的）", () => {
  assert.match(web, /async function syncCheckpoints\(\) \{/)
  assert.match(web, /fetch\("\/api\/sessions\/checkpoints"\)/, "没拉 checkpoint 列表")
  assert.match(web, /fetch\("\/api\/sessions\/checkpoints\/resume"/, "没接恢复动作")
  // 换会话要看、回合一结束也要看（这一轮被中断时横幅该出现）
  assert.match(web, /syncLongTask\(\)[^\n]*\n\s*syncMcpState\(\)[^\n]*\n\s*syncCheckpoints\(\)/, "换会话时没同步 checkpoint（也别把 syncMcpState 插丢）")
  assert.match(web, /if \(!m\.busy && \(!sid \|\| sid === activeId\)\) syncCheckpoints\(\)/, "回合结束没重查 checkpoint")
  // discard 要二次确认（它会截掉会话历史）
  assert.match(web, /act === "discard" && !confirm\(/, "discard 没有二次确认")
})

test("adopt 不自己插消息（服务端已广播 message，自己插会双份）", () => {
  assert.equal(web.includes("appendMessage(r.message)"), false, "又在本地插了一份——会和广播重复")
  assert.match(web, /落库的消息由服务端广播 message 事件追加/)
})

test("web 脚本段仍是合法 JS（本次改的是 index.html，语法错会让 27 个脚本一起红）", () => {
  // 只做静态检查：不能有 TypeScript 专有语法漏进 <script>（web 是纯 JS）
  const script = web.slice(web.indexOf("<script>"), web.lastIndexOf("</script>"))
  assert.equal(/\) as [A-Z]/.test(script), false, "<script> 里出现了 TS 断言语法")
})

// ---------- T93 B1 后台任务元数据落盘 ----------

test("bg id 必须从磁盘回填（不能再用重启归零的进程内计数器）", () => {
  assert.equal(count(tools, /let bgSeq = 0/g), 0, "bgSeq 还在——重启后 id 归零会撞车")
  assert.match(tools, /const id = nextBgId\(\)/, "startBackground 没有用 nextBgId()")
  assert.match(tools, /import \{[\s\S]*?nextBgId[\s\S]*?\} from "\.\/bgStore\.js"/, "没导入 bgStore")
})

test("bg 元数据在「启动」和「退出」两处都落盘", () => {
  assert.match(tools, /saveBgTask\(\{ id, pid: entry\.pid, command, logFile, cwd, startedAt: entry\.startedAt \}\)/, "启动时没落")
  assert.match(tools, /saveBgTask\(\{ id, pid: entry\.pid, command, logFile, cwd, startedAt: entry\.startedAt, endedAt: Date\.now\(\), exitCode: code \}\)/, "退出时没回填")
})

test("bg_read 列的是 磁盘∪内存，且对重启前的任务不猜退出码", () => {
  assert.match(tools, /for \(const r of listBgTasks\(\)\)/, "没有列磁盘记录")
  assert.match(tools, /状态未知（网关重启过，进程可能仍在运行）/, "重启前的任务必须说「状态未知」，不能冒充已结束")
  assert.equal(tools.includes('if (!bgTasks.size) return "暂无后台任务"'), false, "还在只读内存 Map")
})

test("bg_read 的 task_id 不能拼进路径（模型输入 = 任意文件读取面）", () => {
  assert.match(tools, /const rec = getBgTask\(task_id\)/, "没有先按 id 查记录")
  assert.match(tools, /if \(!logFile \|\| !existsSync\(logFile\)\)/, "logFile 可能为 undefined，没判空")
  assert.match(bgstore, /if \(!isValidBgId\(id\)\) return undefined/, "bgLogPath 没校验 id 形状")
  assert.match(bgstore, /export function isValidBgId/, "没有导出 isValidBgId")
})

test("记录数有上限，且日志没了记录一并清（记录不该比日志活得更久）", () => {
  assert.match(bgstore, /BG_MAX_RECORDS/)
  assert.match(tools, /sweepBgRecords\(\)/, "清理日志时没同步清记录")
})

// ---------- T93 B2 撤销快照落盘 ----------

const undostore = read("src/agent/undoStore.ts")
const backup = read("src/agent/backup.ts")

test("默认关（这是 B2 最重要的默认值——它复制的是用户文件内容）", () => {
  assert.match(undostore, /persist: over\?\.persist \?\? u\.persist === true/, "默认值必须是 false，不能反过来")
  assert.match(config, /persist\?: boolean/)
  assert.match(config, /\*\s*\n\s*\* T93 B2 撤销快照\*\*落盘\*\*。默认全关/, "配置注释要写清代价")
})

test("恢复逻辑只有一处出口（不许在网关里另写一套按 ts 找快照）", () => {
  assert.match(undostore, /export function resolveUndoTurn\(/, "没有 resolveUndoTurn")
  // 网关只调它，不再自己 per.get(ts) 之后遍历恢复
  assert.match(gateway, /resolveUndoTurn\(undoSnapshots\.get\(sessionId\)\?\.get\(ts\), sessionId, ts\)/)
  assert.equal(count(gateway, /per\.get\(ts\)!/g), 0, "网关里还有第二份「按 ts 取快照再恢复」的逻辑")
  // 磁盘侧复用内存侧同一个 planUndo，不另写一套决策
  assert.match(undostore, /planUndo\(e\)/, "磁盘侧没有复用 planUndo")
})

test("**绝不快照 ~/.yyagent/ 内部路径**（那里有 .master.key）", () => {
  assert.match(undostore, /const YYAGENT_ROOT = resolve\(homedir\(\), "\.yyagent"\)/)
  assert.match(undostore, /if \(insideYyagent\(e\.path\)\) \{[\s\S]{0,200}skippedOnDisk = "inside-yyagent"/)
  // 兄弟目录不能被误判（前缀匹配的经典坑）
  assert.match(undostore, /p === YYAGENT_ROOT \|\| p\.startsWith\(YYAGENT_ROOT \+ sep\)/, "边界判定要连分隔符一起比")
})

test("新建文件与「采不到快照」是两件事（混了就连删掉新建文件都做不到）", () => {
  assert.match(undostore, /rec\.newFile = true/)
  assert.match(undostore, /if \(rec\.newFile\) return \{ path: rec\.path, plan: \{ op: "delete" \} \}/)
})

test("硬上限都在：单轮 / 总预算 / 保留天数", () => {
  assert.match(undostore, /turnBytes \+ bytes > c\.maxTurnBytes/)
  assert.match(undostore, /bytes <= c\.maxTotalBytes/)
  assert.match(undostore, /now - t\.ts > c\.keepDays \* 24 \* 3600_000/)
  // 单文件上限沿用采集侧常量，不设第二个来源
  assert.match(undostore, /bytes > MAX_SNAPSHOT_BYTES/)
  assert.equal(/maxFileBytes/.test(config), false, "又造了一个单文件上限的配置项——那是第二份来源")
})

test("原子写 + 结构版本号；坏文件读不出来", () => {
  assert.match(undostore, /export const UNDO_VERSION = 1/)
  assert.match(undostore, /parsed\.v !== UNDO_VERSION/)
  assert.match(undostore, /renameSync\(tmp, file\)/)
})

test("**不加进 T83 备份**（派生数据，加进去备份体积最多翻倍）", () => {
  assert.equal(/snapshots/.test(backup), false, "backup.ts 里出现了 snapshots——它是派生数据，不该进备份")
  assert.equal(/"bg"/.test(backup), false, "backup.ts 里出现了 bg——同理")
})

test("落盘失败不影响主流程（保险丝不是主链路）", () => {
  assert.match(undostore, /export function saveUndoTurn[\s\S]*?\{[\s\S]*?try \{[\s\S]*?\} catch \{\s*\n\s*return false/, "saveUndoTurn 必须吞掉异常")
  // 网关调用处不该被 try 包住后影响主流程
  assert.match(gateway, /saveUndoTurn\(sessionId, assistantMsg\.ts, meta\.cwd, fileEdits\)/)
})

test("404 文案分三种情况（原来混成一句，用户没法行动）", () => {
  assert.match(gateway, /undoMissReason\(\(msg\?\.fileEdits\?\.length \?\? 0\) > 0\)/)
  assert.match(undostore, /export function undoMissReason/)
})

test("启动扫一次过期/超预算（只清派生数据，不碰 checkpoint 那种用户判断）", () => {
  assert.match(gateway, /const n = sweepUndoSnapshots\(\)/)
  assert.match(gateway, /\[快照\] 清理了 \$\{n\} 个过期\/超预算的撤销快照轮次/)
})

// ---------- T93 B3 撤销按钮前置置灰 ----------

test("undo-state 用嵌套形状（和 compact/rename 一致），不是平铺 ?sid=", () => {
  assert.match(gateway, /mt = p\.match\(\/\^\\\/api\\\/sessions\\\/\(\[\\w-\]\+\)\\\/undo-state\$\/\)/)
  assert.equal(gateway.includes('p === "/api/sessions/undo-state"'), false, "又做成了平铺路由——和 /api/longtask 一样是历史遗留形状")
  assert.match(web, /fetch\(`\/api\/sessions\/\$\{encodeURIComponent\(activeId\)\}\/undo-state`\)/)
})

test("undo-state 复用唯一的恢复出口，不另写一套按 ts 找快照", () => {
  assert.match(gateway, /resolveUndoTurn\(per\?\.get\(msg\.ts\), sid, msg\.ts\)/, "撤销状态没用 resolveUndoTurn")
  assert.match(gateway, /canUndo: target\.files\.some\(\(f\) => f\.plan\.op !== "refuse"\)/)
  // 查不到时说清原因，不能只给一个 false
  assert.match(gateway, /\{ canUndo: false, reason: undoMissReason\(true\) \}/)
})

test("前端：不可撤的按钮置灰并带原因，而不是点下去才报错", () => {
  assert.match(web, /async function syncUndoState\(\)/)
  assert.match(web, /fetch\(`\/api\/sessions\/\$\{encodeURIComponent\(activeId\)\}\/undo-state`\)/)
  assert.match(web, /window\.__undoState = \(r && r\.states\) \|\| \{\}/)
  // 渲染分支：已撤销 / 不可撤销(disabled + 原因) / 可撤销
  assert.match(web, /ust\.canUndo === false/)
  assert.ok(web.includes('disabled title="${esc(ust.reason || "该轮没有可撤销的快照")}"'), "置灰按钮没带原因")
  assert.ok(web.includes("无法撤销</button>"), "置灰按钮的文案不是「无法撤销」")
  assert.match(web, /\.fo-undo:disabled/)
  // 换会话要拉；撤成功也要刷新
  assert.match(web, /syncUndoState\(\) \/\/ T93 B3：换会话同步/)
  assert.match(web, /syncUndoState\(\) \/\/ 撤过的轮次要置灰/)
})

test("前端：拉不到 undo-state 时不能把按钮全置灰（兜底是点击时报错）", () => {
  // catch 里置空对象 → ust 为 {} → canUndo 不是 false → 按钮照常可点
  assert.match(web, /catch \{ window\.__undoState = \{\} \}/)
  assert.match(web, /\(window\.__undoState \?\? \(window\.__undoState = \{\}\)\)\[undoKey\] \|\| \{\}/)
})
