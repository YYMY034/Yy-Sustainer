// T48 校验：辅助对话发送按钮收进输入盒内（composer 式灰盒 + 32px 小钮，与主对话同规格）
// 离线跑：CSS 结构断言 + 与主对话同规格比对 + 图标同源 + JS 接线不变 + 语法配平 + 网关活体检查
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const cssNoCmt = css.replace(/\/\*[\s\S]*?\*\//g, '')

let pass = 0, fail = 0
const ok = (n, v, extra) => { if (v) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + (extra ? '  → ' + extra : '')) } }
const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = cssNoCmt.match(new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

console.log('=== ① 盒子：#assistInputRow 变 composer 式灰盒 ===')
const row = rule('#assistInputRow')
ok('本体灰盒 panel2 + 描边 + 14px 圆角', /background:\s*var\(--panel2\)/.test(row) && /border:\s*1px solid var\(--border\)/.test(row) && /border-radius:\s*14px/.test(row), row)
ok('纵向布局（输入在上、按钮行在下）', /flex-direction:\s*column/.test(row))
ok('T52 与抽屉边缘留距（左右下 12px、上 6px）', /margin:\s*6px 12px 12px/.test(row), row)
ok('反向：不再贴满抽屉底部（无零外边距）', !/margin:\s*0[;\s]/.test(row))
ok('反向：不再是白行（旧 background: var(--panel) 已废）', !/background:\s*var\(--panel\)\s*;/.test(row), row)
ok('focus 亮描边移到盒上（:focus-within → accent，同 #composer）',
  /border-color:\s*var\(--accent\)/.test(rule('#assistInputRow:focus-within')))
ok('反向：旧「盒在行内、行在盒外」结构不残留（#assistInput 不再自带 panel2 盒）', (() => {
  const inp = rule('#assistInput')
  return /background:\s*transparent/.test(inp) && !/var\(--panel2\)/.test(inp) && /border:\s*none/.test(inp)
})(), rule('#assistInput'))

console.log('=== ② 按钮：32×32 入盒，与主对话同规格 ===')
const send = rule('#assistSend')
const roundBtn = rule('.roundBtn')
ok('32×32、10px 圆角（= .roundBtn 规格）',
  /width:\s*32px/.test(send) && /height:\s*32px/.test(send) && /border-radius:\s*10px/.test(send), send)
ok('规格与主对话 .roundBtn 一致', (send.match(/width:\s*32px/) && roundBtn.match(/width:\s*32px/)) !== null, `assist=${send.slice(0, 60)}`)
ok('配色同主对话实心钮（text 底 bg 字）', /background:\s*var\(--text\)/.test(send) && /color:\s*var\(--bg\)/.test(send))
ok('贴盒内右下（align-self: flex-end）', /align-self:\s*flex-end/.test(send))
ok('反向：64px 大方钮已废', !/width:\s*64px/.test(send))
ok('hover 同主对话（brightness 1.18）', /filter:\s*brightness\(1\.18\)/.test(rule('#assistSend:hover')))
ok('disabled 同主对话（opacity .35）', /opacity:\s*\.35/.test(rule('#assistSend:disabled')))
ok('stop 态带 pulseStop 脉冲（同 #btnSend.stop）', /animation:\s*pulseStop\s*1\.2s/.test(rule('#assistSend.stop')))

console.log('=== ③ 图标与 JS 接线不变 ===')
const sendSvg = script.match(/const SEND_SVG = '([^']+)'/)?.[1] ?? ''
const mainPlane = html.match(/id="btnSend"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? ''
const planePath = 'M14.2 1.8L7 9M14.2 1.8L9.6 14.2 7 9 2.2 6.4l12-4.6z'
ok('辅助发送图标与主对话 #btnSend 同一条纸飞机路径（全站统一）',
  sendSvg.includes(planePath) && mainPlane.includes(planePath))
ok('setAssistBusy 仍切换 stop 图标与标题（JS 未动）',
  /btn\.classList\.add\("stop"\)/.test(script) && /btn\.title = "停止"/.test(script))
ok('反向：没人再改 #assistSend 的尺寸（JS 不参与布局）', !/assistSend\.style\.(width|height)/.test(script))

console.log('=== ④ 语法与配平 ===')
try { writeFileSync('scripts/.t48-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t48-tmp.mjs']); unlinkSync('scripts/.t48-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== ⑤ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('网关下发的首页已含新版 assist 输入盒样式', served.includes('#assistInputRow:focus-within') && /#assistSend[^{]*\{[^}]*width:\s*32px/.test(served))
} catch { console.log('SKIP 网关未运行，跳过活体检查') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
