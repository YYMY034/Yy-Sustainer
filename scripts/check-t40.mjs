// T40 校验：① 左右侧栏与顶栏的颜色过渡 ② 导轨间距 + 仅侧栏收起时显示
// 离线跑：CSS 规则断言 + 几何净距计算 + 整段脚本语法 + CSS 括号配对
// 【T42 修订过的 4 条断言】已在原处标注：过渡区 16→8px；#main 硬线撤销改渐变；
// 导轨 align-items flex-end→flex-start（方向改回向右长）；净距改按 hover 最大宽计算。
// 本脚本保持"当前正确状态"的回归价值，不保留已被用户否掉的旧方向。
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]

let pass = 0, fail = 0
const ok = (n, v, extra) => { if (v) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + (extra ? '  → ' + extra : '')) } }

// 颜色变量表（两个主题）
const themeVars = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]))
const dark = themeVars(css.match(/:root\s*\{([\s\S]*?)\}/)[1])
const light = themeVars(css.match(/html\.light\s*\{([\s\S]*?)\}/)[1])

const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = css.match(new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}
// 同名选择器可能出现在「分组过渡规则」里（如 #qaRail .qa-dash:hover,\n .near,\n .far { transition… }），
// 取第一个「带该属性」的规则体，避免被分组块抢先匹配
const ruleWith = (sel, prop) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}', 'g')
  for (const m of css.matchAll(re)) if (new RegExp(prop).test(m[1])) return m[1]
  return ''
}
const noComment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

console.log('=== T40a 侧栏/抽屉 与 顶栏 的颜色过渡 ===')
const topbar = rule('#topbar')
ok('#topbar 已去掉满宽 border-bottom（否则硬线切断过渡）', !/border-bottom/.test(topbar), 'topbar = ' + topbar)
ok('#topbar 底色仍是 var(--panel)', /background:\s*var\(--panel\)/.test(topbar))

const main = rule('#main')
// T42 修订：中部那条 border-top 撤掉了，改成和左右侧栏同一套「无硬线 + 顶色渐变」（panel → bg 8px）
ok('#main 已无硬分隔线（border-top 已撤）', !/border-top/.test(main), 'main = ' + main)
ok('#main 顶部渐变 = panel → bg（8px，正好铺满 8px 上外边距）', (() => {
  const g = (main.match(/linear-gradient\(to bottom,\s*var\((--[\w-]+)\)\s*0,\s*var\((--[\w-]+)\)\s*(\d+)px\)/) || []).slice(1)
  return g[0] === '--panel' && g[1] === '--bg' && g[2] === '8'
})(), 'main = ' + main)

const sb = rule('#sidebar')
const grad = (sel) => (rule(sel).match(/linear-gradient\(to bottom,\s*var\((--[\w-]+)\)\s*0,\s*var\((--[\w-]+)\)\s*(\d+)px\)/) || []).slice(1)
// T42 修订：过渡区 16px → 8px（用户反馈太长）；与中部 #main 的 8px 一致
const sbG = grad('#sidebar')
ok('#sidebar 顶部渐变 = panel → panel2（8px）', sbG[0] === '--panel' && sbG[1] === '--panel2' && sbG[2] === '8', JSON.stringify(sbG))
const drG = grad('#assistDrawer')
ok('#assistDrawer 顶部渐变 = panel → panel2（8px）', drG[0] === '--panel' && drG[1] === '--panel2' && drG[2] === '8', JSON.stringify(drG))
ok('#assistMonitor 改透明底（否则自己的 panel2 会盖住抽屉渐变）', /background:\s*transparent/.test(rule('#assistMonitor')), 'monitor = ' + rule('#assistMonitor'))

// 接缝无缝：渐变 0% 处用的 token 必须与顶栏背景 token 相同 → 交接处同色，无色带
for (const [name, v] of [['暗色', dark], ['亮色', light]]) {
  const same = v.panel && v.panel2 && v.panel !== v.panel2
  ok(`${name}主题 panel≠panel2（渐变肉眼可见）`, same, `panel=${v.panel} panel2=${v.panel2}`)
}
ok('渐变起点 token 与 #topbar 背景 token 严格相同（接缝同色、无硬边）',
  sbG[0] === '--panel' && /background:\s*var\(--panel\)/.test(topbar))

console.log('\n=== T40b 导轨：间距 + 仅在侧栏收起时显示 ===')
const rail = rule('#qaRail')
// T42 修订：T40 曾改成 flex-end（向左长），用户反馈方向反了 → 改回 flex-start 向右长；
// 因为 #messages 左内边距已提到 32px，向右最长 22px（右缘 32px）仍距正文（42px）10px，不会压字
ok('#qaRail 左缘对齐（align-items: flex-start，向右伸长）', /align-items:\s*flex-start/.test(rail), 'rail = ' + rail)
ok('#qaRail 基准位置 left: 22px / width: 44px（T46 再右移再加宽，给 44px hover 留位）', /left:\s*22px/.test(rail) && /width:\s*44px/.test(rail))
ok('侧栏展开时隐藏导轨（body:not(.side-collapsed) #qaRail.show { display:none }）',
  /body:not\(\.side-collapsed\)\s+#qaRail\.show\s*\{\s*display:\s*none/.test(css))

// 选择器特异性：guard(1,2,1) 必须 > #qaRail.show(1,1,0)，否则 .show 会把 display:flex 反压回来
const spec = (sel) => {
  const ids = (sel.match(/#[\w-]+/g) || []).length
  const cls = (sel.match(/\.[\w-]+/g) || []).length + (sel.match(/:not\(/g) || []).length
  const el = (sel.match(/(^|\s)[a-z]+/g) || []).length
  return ids * 100 + cls * 10 + el
}
ok('guard 特异性高于 #qaRail.show', spec('body:not(.side-collapsed) #qaRail.show') > spec('#qaRail.show'),
  `${spec('body:not(.side-collapsed) #qaRail.show')} > ${spec('#qaRail.show')}`)

// 导轨规则块内不得再有 margin-left（横向位移全交给宽度，杜绝伸进正文）
const railStart = css.indexOf('D5 左侧问答短横线导航轨')
const railEnd = css.indexOf('P0-4 活动流')
const railBlock = noComment(css.slice(railStart, railEnd))
ok('导轨块内已无 margin-left（不再靠位移变长）', !/margin-left/.test(railBlock), (railBlock.match(/margin-left[^;]*/g) || []).join(' | '))

const w = (sel) => (ruleWith(sel, 'width:\\s*\\d+px').match(/width:\s*(\d+)px/) || [])[1]
ok('短横基准宽 20px（T44 由 14 加长）', w('#qaRail .qa-dash') === '20', w('#qaRail .qa-dash'))
ok('hover 最长 44px（= 导轨宽度，T46 再加长一档）', w('#qaRail .qa-dash:hover') === '44', w('#qaRail .qa-dash:hover'))
ok('near 32px / far 24px（向外递减，T46 near 也加长）', w('#qaRail .qa-dash.near') === '32' && w('#qaRail .qa-dash.far') === '24',
  `near=${w('#qaRail .qa-dash.near')} far=${w('#qaRail .qa-dash.far')}`)

// 几何净距：flex-start → 短横左缘固定在 left，向右的最远处 = left + hover 最大宽
const left = +(rail.match(/left:\s*(\d+)px/) || [])[1]
const railW = +(rail.match(/width:\s*(\d+)px/) || [])[1]
const hoverW = +((ruleWith('#qaRail .qa-dash:hover', 'width:\\s*\\d+px').match(/width:\s*(\d+)px/) || [])[1])
const msg = rule('#messages')
const msgMarginL = +((msg.match(/margin:\s*[\d.]+px\s+(\d+)px/) || [])[1])
const msgPad = msg.match(/padding:\s*([\d.]+px\s+[\d.]+px\s+[\d.]+px\s+(\d+)px|([\d.]+px\s+[\d.]+px))/)
const padL = +((msg.match(/--padL:\s*(\d+)px/) || [])[1]) || (msgPad ? +msgPad[2] || +msgPad[3] : NaN)
const railRight = left + hoverW
const textLeft = msgMarginL + padL
const gap = textLeft - railRight
ok(`hover 最大宽(${hoverW}px) 不超出导轨容器(${railW}px)`, hoverW <= railW, `hoverW=${hoverW} containerW=${railW}`)
ok(`导轨最右(${railRight}px) 仍在正文起点(${textLeft}px) 左侧，净距 ${gap}px ≥ 8px`, gap >= 8,
  `railRight=${railRight} textLeft=${textLeft} gap=${gap}`)

console.log('\n=== 静态完整性 ===')
writeFileSync('.tmp-t40.js', script)
try {
  execFileSync(process.execPath, ['--check', '.tmp-t40.js'], { stdio: 'pipe' })
  ok('整段 <script> 语法可解析（node --check）', true)
} catch (e) { ok('整段 <script> 语法可解析（node --check）', false) } finally { try { unlinkSync('.tmp-t40.js') } catch {} }

let d = 0, bal = true
for (const c of css) { if (c === '{') d++; else if (c === '}') { d--; if (d < 0) { bal = false; break } } }
ok('CSS 括号配对', bal && d === 0)

console.log(`\n${fail === 0 ? '全部通过' : '存在失败项'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
