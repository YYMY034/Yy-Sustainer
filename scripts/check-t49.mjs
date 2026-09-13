// T49 校验：导轨隐藏态正文与输入框对齐 + 输入框留白加大（940 统一列 + 28px 侧 padding）
// 离线跑：列宽统一断言 + padding 断言 + 隐藏态覆盖规则及其特异性/顺序 + 反向（可见态基准不动、#question/.page-inner 不连坐）+ 配平 + 活体
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

console.log('=== ① 统一 940 列（正文 = 输入框，同宽才可能对齐） ===')
for (const sel of ['.msg', '.turn-divider', '#composer', '#queueInfo', '#queueList', '#ctxRow']) {
  ok(`${sel} max-width 940`, /max-width:\s*940px/.test(rule(sel)), rule(sel))
}
ok('反向：#question 保持 860（T46 用户要求，不连坐）', /max-width:\s*860px/.test(rule('#question')))
ok('反向：.page-inner 保持 860（设置页无关）', /max-width:\s*860px/.test(rule('.page-inner')))

console.log('=== ② padding：留白加大 + 可见态基准不动（T51 var 模型） ===')
ok('#inputArea 侧 padding 18→28（留白加大）', /padding:\s*6px 28px 8px/.test(rule('#inputArea')), rule('#inputArea'))
const msgs = rule('#messages')
ok('#messages padding 走 --padL/--padR 变量', /padding:\s*18px var\(--padR\) 18px var\(--padL\)/.test(msgs), msgs)
ok('基准 --padL: 76px（可见态让位导轨）', /--padL:\s*76px/.test(msgs), msgs)
ok('T51 对齐公式就位（--msg-s 富余镜像 + --msg-mr 右锚定 + --sbw）',
  /--msg-s:\s*max\(0px/.test(msgs) && /--msg-mr:\s*calc\(28px - var\(--padR\) - var\(--sbw\)/.test(msgs) && /--sbw:\s*10px/.test(msgs), msgs)
ok('assist-open 88px 让位规则仍在（--padL: 88px）', /--padL:\s*88px/.test(rule('body.assist-open #messages')))

console.log('=== ③ 隐藏态覆盖：三种组合 + 特异性/顺序 ===')
const hideBlockIdx = cssNoCmt.indexOf('body[data-rail="hidden"] #messages')
const assistIdx = cssNoCmt.indexOf('body.assist-open #messages')
ok('三条隐藏态覆盖规则存在（hidden / open+双开 / closed+左开）',
  hideBlockIdx > -1 &&
  cssNoCmt.includes('body[data-rail="open"]:has(#assistDrawer.open):not(.side-collapsed) #messages') &&
  cssNoCmt.includes('body[data-rail="closed"]:not(.side-collapsed) #messages'))
ok('⚠️顺序：覆盖块在 body.assist-open 觴则之后（hidden 档同 (1,1,1) 靠后胜出）', hideBlockIdx > assistIdx && assistIdx > -1, `hide=${hideBlockIdx} assist=${assistIdx}`)
ok('覆盖值 = --padL: 28px（与 #inputArea 内缩一致 → 列重合 → 对齐）',
  /--padL:\s*28px/.test(cssNoCmt.slice(hideBlockIdx, hideBlockIdx + 400)))
// 特异性：open/closed 两档必须压过 body.assist-open #messages (1,1,1)
const spec = (sel) => [
  (sel.match(/#[\w-]+/g) || []).length,
  (sel.match(/\.[\w-]+|\[[^\]]+\]|:not\([^)]*\)/g) || []).length,
  (sel.match(/(^|[\s>+~])[a-z]+/g) || []).length,
]
const beatsAssist = (sel) => { const [i, c, e] = spec(sel); return i > 1 || (i === 1 && (c > 1 || (c === 1 && e > 1))) }
ok('open 档覆盖特异性 > body.assist-open #messages (1,1,1)',
  beatsAssist('body[data-rail="open"]:has(#assistDrawer.open):not(.side-collapsed) #messages'), JSON.stringify(spec('body[data-rail="open"]:has(#assistDrawer.open):not(.side-collapsed) #messages')))
ok('closed 桷覆盖特异性 > body.assist-open #messages (1,1,1)',
  beatsAssist('body[data-rail="closed"]:not(.side-collapsed) #messages'), JSON.stringify(spec('body[data-rail="closed"]:not(.side-collapsed) #messages')))

console.log('=== ④ 几何组不变量（可见态） ===')
// 导轨右缘 66 < 正文起点 86（#messages margin 10 + padding-left 76）—— 基准 padding-left 必须仍是 76
ok('基准 --padL 仍为 76（10+76=86 > 66，check-t44 的不等式成立前提）', /--padL:\s*76px/.test(msgs))

console.log('=== ⑤ 语法与配平 ===')
try { writeFileSync('scripts/.t49-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t49-tmp.mjs']); unlinkSync('scripts/.t49-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== ⑥ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('网关下发的首页已含 940 列与隐藏态对齐规则',
    served.includes('max-width: 940px') && served.includes('body[data-rail="hidden"] #messages'))
} catch { console.log('SKIP 网关未运行，跳过活体检查') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
