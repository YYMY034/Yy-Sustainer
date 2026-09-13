// T53/T55 校验：同会话模型切换提示（切换瞬间即显示的灰字横线）
// T55 机制：网关 /api/model 会话级切换时落一条 role:"system" 提示消息并广播；前端把 system 渲染为
// .model-divider；toCoreMessages 过滤 system（绝不进 LLM 上下文）；WS 处理不因 system 重置流式状态。
// （T53 旧的「相邻消息模型比对」派生方案已废弃——要等回复落地才出现，用户明确不要）
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const cssNoCmt = css.replace(/\/\*[\s\S]*?\*\//g, '')
const store = readFileSync('src/session/store.ts', 'utf8')
const gateway = readFileSync('src/gateway.ts', 'utf8')

let pass = 0, fail = 0
const ok = (n, v, extra) => { if (v) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + (extra ? '  → ' + extra : '')) } }
const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = cssNoCmt.match(new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

console.log('=== ① store.ts：system 角色与 LLM 上下文过滤 ===')
ok('StoredMessage.role 扩展 "system"', /role:\s*"user" \| "assistant" \| "system"/.test(store))
ok('toCoreMessages 过滤 system（绝不进 LLM 上下文）',
  /\.filter\(\(m\) => m\.role !== "system" && m\.content\.trim\(\)\)/.test(store), store.slice(store.indexOf('toCoreMessages'), store.indexOf('toCoreMessages') + 200))
ok('反向：不做 system → system 轮的映射（过滤在前，map 只剩 user/assistant）',
  store.indexOf('m.role !== "system"') < store.indexOf('.map((m) => ({ role: m.role'))

console.log('=== ② gateway.ts：/api/model 落提示消息并广播 ===')
ok('会话分支先取旧生效模型', gateway.includes('const oldModel = effectiveModelOf(sid)'))
ok('变化才落提示（oldModel && oldModel !== spec）', /if \(oldModel && oldModel !== spec\) \{/.test(gateway))
ok('notice 为 role:"system"、文案「模型已从 X 更改为 Y」（T56 合并分支共享同一 content）',
  /role: "system", content/.test(gateway) &&
  /const content = `模型已从 \$\{short\(oldModel\)\} 更改为 \$\{short\(spec\)\}`/.test(gateway))
ok('入库 + persist + message 广播（切换瞬间即到前端）',
  /session\.messages\.push\(notice\)/.test(gateway) && /persist\(session\.meta, session\.messages\)/.test(gateway) &&
  /broadcast\(\{ type: "message", sessionId: sid, message: notice \}\)/.test(gateway))
// 反向：全局默认模型切换（无 sid）不落任何会话的提示消息
const modelRoute = gateway.slice(gateway.indexOf('"/api/model"'), gateway.indexOf('"/api/vision-model"'))
ok('反向：全局默认切换（无 sid）分支不含 notice 逻辑',
  !/notice/.test(modelRoute.slice(modelRoute.indexOf('setDefaultModel(spec)'))))
ok('compactNow 两处调用（网关压缩/TUI 压缩）都过滤 system（不进摘要 LLM 上下文）',
  gateway.includes('compactNow(f.messages.filter((m): m is StoredMessage & { role: "user" | "assistant" } => m.role !== "system"), model)') &&
  readFileSync('src/tui/App.tsx', 'utf8').includes('compactNow(messages.filter((m): m is StoredMessage & { role: "user" | "assistant" } => m.role !== "system"), active.model)'))

console.log('=== ②b T56 连续切换合并（只保留最后一条） ===')
ok('网关：上一条已是模型切换提示就原地替换（不堆叠）',
  /const last = session\.messages\[session\.messages\.length - 1\]/.test(gateway) &&
  /last && last\.role === "system" && last\.content\.startsWith\("模型已从"\)/.test(gateway) &&
  /last\.content = content/.test(gateway))
ok('反向：非提示消息仍走 push（正常追加不受影响）',
  /session\.messages\.push\(notice\)/.test(gateway))
ok('web WS：同样的合并规则（上一条 system 就替换）',
  /lastMsg\.role === "system"/.test(script) && /lastMsg\.content = m\.message\.content/.test(script))
ok('web 渲染：连续 system 折叠只渲染最后一条（历史堆叠数据的兜底）',
  /if \(messages\[i \+ 1\]\?\.role === "system"\) return ""/.test(script))
ok('T56 悬停浮层：ⓘ 内置固定说明文案 + hover 显示 + 指针提示',
  /在对话中途切换模型会使上下文缓存失效，积分消耗增加，背景信息可能会自动压缩，降低性能表现/.test(script) &&
  /\.model-divider \.ico:hover \.tip \{ display: block; \}/.test(cssNoCmt) &&
  /cursor:\s*help/.test(rule('.model-divider .ico')))
ok('浮层样式：深底浅字圆角 + 防闪烁（pointer-events:none）',
  /background:\s*var\(--text\); color:\s*var\(--bg\)/.test(rule('.model-divider .ico .tip')) &&
  /pointer-events:\s*none/.test(rule('.model-divider .ico .tip')), rule('.model-divider .ico .tip'))

console.log('=== ③ web：system 渲染为灰字横线 + 流式保护 ===')
ok('render 对 role "system" 早退渲染 .model-divider（含 T56 连续折叠行）',
  /if \(m\.role === "system"\) \{[\s\S]{0,140}return `<div class="model-divider" title="\$\{esc\(m\.content\)\}">/.test(script))
ok('ⓘ 为手绘 SVG（图标纪律）', !/>ⓘ<|>ⓘ /.test(html))
ok('反向：T53 派生比对方案已移除（prevAssistantModel / modelSwitch 不存在）',
  !script.includes('prevAssistantModel') && !script.includes('${modelSwitch}'))
ok('反向：user 消息不渲染为分隔线（早退在 user 分支之前）',
  script.indexOf('m.role === "system"') < script.indexOf('if (m.role === "user") {'))
ok('WS：system 不重置流式状态（流式中切模型不冲掉占位）',
  /m\.message\.role !== "user" && m\.message\.role !== "system"/.test(script))

console.log('=== ④ CSS：分隔线样式仍在（T53 建立沿用） ===')
const md = rule('.model-divider')
ok('.model-divider 存在（flex 横线 + 12px 灰字 + T51 右锚定列）',
  /display:\s*flex/.test(md) && /font-size:\s*12px/.test(md) && /max-width:\s*940px/.test(md) && /var\(--msg-mr\)/.test(md), md)

console.log('=== ⑤ 语法与配平 ===')
try { writeFileSync('scripts/.t53-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t53-tmp.mjs']); unlinkSync('scripts/.t53-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== ⑥ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('网关下发的首页已含 system 分隔线渲染', served.includes('m.role === "system"') && served.includes('.model-divider'))
} catch { console.log('SKIP 网关未运行，跳过活体检查') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
