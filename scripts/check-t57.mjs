// T57 校验：执行中/思考中过程状态从顶栏挪进流式输出区（光标处状态行；无占位时回落顶栏）
// 离线跑：占位结构 + WS 路由 + 监工/换会话同步 + CSS + 反向（WS 流式中不得写顶栏）+ 语法配平 + 活体
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const cssNoCmt = css.replace(/\/\*[\s\S]*?\*\//g, '')
const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = cssNoCmt.match(new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

let pass = 0, fail = 0
const ok = (n, v, extra) => { if (v) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + (extra ? '  → ' + extra : '')) } }

console.log('=== ① 流式占位内状态行 ===')
ok('占位含条件渲染的 stream-status 行（spinner + esc(streamStatusText)）',
  /\$\{streamStatusText \? `<div class="stream-status" id="streamStatus"><span class="spinner"><\/span><span id="streamStatusText">\$\{esc\(streamStatusText\)\}<\/span><\/div>` : ""\}/.test(script))
ok('位于 .who（光标行）之后、#activity 之前',
  script.indexOf('id="streamStatus"') > script.indexOf('id="thinkSpin"') && script.indexOf('id="streamStatus"') < script.indexOf('<div id="activity"></div><div class="body" id="streamBody"'))
ok('状态行变量声明在 streamBuf 旁', /let streamBuf = ""\s*\nlet streamStatusText = ""/.test(script))

console.log('=== ② WS 路由：过程状态一律进输出区，顶栏零过程状态（T59 收紧） ===')
ok('status 事件写 streamStatusText 并同步 #streamStatusText',
  /streamStatusText = m\.text \?\? ""/.test(script) && /const sst = \$\("streamStatusText"\); if \(sst\) sst\.textContent = streamStatusText/.test(script))
ok('T59：有文本即 ensureStream 重建占位（步骤边界不漏回顶栏）',
  /if \(streamStatusText\) ensureStream\(\)/.test(script))
ok('T59 反向：status 分支完全不写顶栏（无任何回落）',
  !/streamStatusText[^)\n]*\n?\s*if \(!streamingOn\) \$\("status"\)/.test(script) &&
  !/if \(!streamingOn\) \$\("status"\)\.textContent = streamStatusText/.test(script))
ok('监工状态流式取输出区（refreshState 不再用顶栏顶掉 monitorStatus）',
  /monitorStatus = streamingOn \? streamStatusText : \(\$\("status"\)\.textContent \?\? ""\)/.test(script))
ok('换会话清空状态行', /streamStatusText = "" \/\/ T57：换会话清空流式状态行/.test(script))
ok('T59：refreshState busy 兜底走输出区（ensureStream），顶栏不再写「任务进行中」',
  /if \(busy\(\)\) \{ streamStatusText = streamStatusText \|\| "任务进行中"; ensureStream\(\) \}/.test(script) &&
  !/\$\("status"\)\.textContent = busy\(\)/.test(script))

console.log('=== ③ CSS ===')
ok('.stream-status 金色小字 + spinner（沿用 spin 关键帧）',
  /color:\s*var\(--warn\)/.test(rule('.stream-status')) &&
  /animation:\s*spin \.8s linear infinite/.test(rule('.stream-status .spinner')), rule('.stream-status .spinner'))

console.log('=== ④ 语法与配平 ===')
try { writeFileSync('scripts/.t57-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t57-tmp.mjs']); unlinkSync('scripts/.t57-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== ⑤ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('网关下发的首页已含输出区状态行', served.includes('id="streamStatus"') && served.includes('.stream-status'))
} catch { console.log('SKIP 网关未运行，跳过活体检查') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
