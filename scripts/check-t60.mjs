// T60 校验：轮询终态对账（回合结束但本地流式占位卡住 → 重拉会话消息重建，残留「执行中」状态行消除）
// + WS 推送 ts 去重（对账后迟到广播不产生双份气泡）
// 根因：终态消息只靠 WS 推送，断线重连/网关重启丢广播后占位永挂；按钮状态走 HTTP 轮询先变回发送
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const cssNoCmt = css.replace(/\/\*[\s\S]*?\*\//g, '')

let pass = 0, fail = 0
const ok = (n, v, extra) => { if (v) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + (extra ? '  → ' + extra : '')) } }

console.log('=== ① 对账重建（refreshState） ===')
ok('对账条件：!busy && streamingOn && activeId（只在终态泄漏时触发）',
  /if \(!busy\(\) && streamingOn && activeId\) \{/.test(script))
ok('重拉最近一页并重建（messages/totalMessages/olderTotal 三件套同步）',
  /messages = f\.messages \?\? \[\]/.test(script) && /totalMessages = f\.total \?\? messages\.length/.test(script) && /olderTotal = totalMessages - messages\.length/.test(script))
ok('落地前二次确认没有新一轮开始（拉取期间 busy 置 true 则放弃落地）',
  /if \(!busy\(\)\) \{[\s\S]{0,260}streamingOn = false[\s\S]{0,80}streamStatusText = ""/.test(script))
ok('对账清除残留状态行', /streamingOn = false\s*\n\s*streamStatusText = ""/.test(script))
ok('拉取失败静默（下一轮轮询再试）', /catch \{ \/\* 下一轮轮询再试 \*\/ \}/.test(script))
ok('对账位于 refreshState 内（async 函数体，可 await）',
  /async function refreshState\(\)[\s\S]*?if \(!busy\(\) && streamingOn && activeId\)/.test(script))

console.log('=== ② WS 推送去重 ===')
ok('message 事件按 ts+role 去重（对账后迟到广播不产生双份气泡）',
  /messages\.some\(\(x\) => x\.ts === m\.message\.ts && x\.role === m\.message\.role\)\) return/.test(script))
ok('反向：去重不影响正常追加（push 路径仍在）', /messages\.push\(m\.message\)/.test(script))

console.log('=== ③ 语法与配平 ===')
try { writeFileSync('scripts/.t60-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t60-tmp.mjs']); unlinkSync('scripts/.t60-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== ④ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('网关下发的首页已含对账逻辑', served.includes('!busy() && streamingOn && activeId') && served.includes('x.ts === m.message.ts'))
} catch { console.log('SKIP 网关未运行，跳过活体检查') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
