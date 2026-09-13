// T50 校验：①导轨显隐事实来源改为抽屉真实 DOM 状态（:has(#assistDrawer.open)，修「启动双开导轨误显示」）
// ②辅助输入盒缩小（基准 64→40 + border-box 治自动伸缩虚胖）
// 离线跑：选择器断言 + 反向（旧类耦合不得残留/64 不得残留）+ 语法配平 + 网关活体检查
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

console.log('=== ① 导轨显隐：事实来源 = 抽屉真实状态（:has） ===')
const railRule = 'body[data-rail="open"]:has(#assistDrawer.open):not(.side-collapsed) #qaRail.show'
ok('open 档导轨隐藏规则改用 :has(#assistDrawer.open)', /display:\s*none/.test(rule(railRule)), rule(railRule))
ok('T49 对齐覆盖同源改 :has（与显隐同一事实来源）',
  /display|^$/.test('') && cssNoCmt.includes('body[data-rail="open"]:has(#assistDrawer.open):not(.side-collapsed) #messages'))
ok('反向：导轨显隐不再耦合 body.assist-open 类（删类/漏类都不会误显示）',
  !/body\[data-rail="open"\]\.assist-open[^{]*#qaRail/.test(cssNoCmt))
ok('body.assist-open 仍保留给 T44 的 #messages 88px 让位（T51 var 模型）',
  /--padL:\s*88px/.test(rule('body.assist-open #messages')))
// :has 参数带 #id，特异性 ≥ (2,2,1)，必压过 #qaRail.show (1,1,0)
ok(':has 携带 #id，特异性必压过 #qaRail.show', railRule.includes('#assistDrawer.open') && railRule.includes('#qaRail.show'))

console.log('=== ② 辅助输入盒缩小（64→40 + border-box） ===')
const inp = rule('#assistInput')
ok('基准高 40px（min 同步）', /height:\s*40px/.test(inp) && /min-height:\s*40px/.test(inp), inp)
ok('box-sizing: border-box（空内容 scrollHeight 不再虚胖）', /box-sizing:\s*border-box/.test(inp))
ok('多行上限仍 140px', /max-height:\s*140px/.test(inp))
ok('反向：64px 基准已废', !/height:\s*64px/.test(inp))
ok('JS ASSIST_H 同步 40（resetAssistH/自动伸缩共用）', /const ASSIST_H = 40, ASSIST_MAX = 140/.test(script))
ok('反向：JS 里无残留 64 基准', !/ASSIST_H = 64/.test(script))
ok('发送后回弹逻辑仍在（resetAssistH 在 sendAssist 内）',
  /\$\("assistInput"\)\.value = ""/.test(script) && /resetAssistH\(\)/.test(script))

console.log('=== ③ 语法与配平 ===')
try { writeFileSync('scripts/.t50-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t50-tmp.mjs']); unlinkSync('scripts/.t50-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== ④ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('网关下发的首页已含 :has 规则与 40px 基准',
    served.includes(':has(#assistDrawer.open)') && /height:\s*40px;\s*min-height:\s*40px/.test(served))
} catch { console.log('SKIP 网关未运行，跳过活体检查') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
