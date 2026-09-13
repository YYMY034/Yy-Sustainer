// T42 校验：① 输出区顶部与顶栏的过渡（#main 渐变 + 撤掉硬线）② 左右侧栏过渡区收到 8px
//           ③ 导轨伸长方向改回向右 ④ 流畅度（过渡参数 + 波纹重绘幂等）
// 离线跑：CSS 断言 + 几何净距 + 波纹函数「仿真执行」（含 enter/leave 事件顺序颠倒的回归用例）+ 语法
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const cssRaw = html.match(/<style>([\s\S]*?)<\/style>/)[1]
// 先剥注释再解析：否则 `.35s` 这类"只应出现在注释里的历史参数"会被断言误命中
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '')
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]

let pass = 0, fail = 0
const ok = (n, v, extra) => { if (v) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + (extra ? '  → ' + extra : '')) } }

// 注意：选择器前后的空白只能用 [ \t]*，不能用 \s*（\s 会吃掉换行，让匹配跨到上一条规则去）
const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = css.match(new RegExp('(?:^|\\n)[ \\t]*' + esc + '[ \\t]*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}
// 取「含该属性」的规则体；并且要认得出**逗号分组选择器**（`.a:hover,\n .a.near,\n .a.far { … }`
// 这种情况目标选择器不以 `{` 结尾，单选择器正则匹配不到）
const ruleWith = (sel, prop) => {
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sels = m[1].split(',').map(s => s.trim().replace(/[ \t\n]+/g, ' '))
    const hit = sels.some(s => s === sel) || sels.some(s => s.endsWith(sel))
    if (hit && new RegExp(prop).test(m[2])) return m[2]
  }
  return ''
}
// 逗号拆分要考虑括号（cubic-bezier(.22,.61,.36,1) 里也有逗号）
const splitCommas = (s) => {
  const out = []; let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out.map(x => x.trim()).filter(Boolean)
}
// 按大括号配平抽出一个顶层函数（比按行号切片稳）
const extractFn = (name) => {
  const i0 = script.indexOf('function ' + name + '(')
  if (i0 < 0) return ''
  let i = script.indexOf('{', i0), depth = 0
  for (; i < script.length; i++) {
    if (script[i] === '{') depth++
    else if (script[i] === '}' && --depth === 0) return script.slice(i0, i + 1)
  }
  return ''
}
const gradOf = (sel) => {
  const g = (rule(sel).match(/linear-gradient\(to bottom,\s*var\((--[\w-]+)\)\s*0,\s*var\((--[\w-]+)\)\s*(\d+)px\)/) || []).slice(1)
  return { from: g[0], to: g[1], px: g[2] ? +g[2] : NaN }
}

console.log('=== ① 输出区顶部 ↔ 顶栏：也要有过渡 ===')
const topbar = rule('#topbar'), main = rule('#main')
ok('#topbar 无满宽 border-bottom（沿用 T40）', !/border-bottom/.test(topbar))
ok('#main 已撤掉 T40 加的 border-top 硬线', !/border-top/.test(main), main)
const mg = gradOf('#main')
ok('#main 顶部渐变 = panel → bg（顶栏色渐变进画布底色）', mg.from === '--panel' && mg.to === '--bg', JSON.stringify(mg))
ok('#main 渐变高度 8px == #messages 上外边距（严丝合缝铺满那条缝、不留色带）', (() => {
  const mt = +(rule('#messages').match(/margin:\s*(\d+)px/) || [])[1]
  return mg.px === mt && mg.px === 8
})(), `grad=${mg.px}px marginTop=${(rule('#messages').match(/margin:\s*(\d+)px/) || [])[1]}px`)

console.log('\n=== ② 左右侧栏过渡区收小到 8px，且三条缝同长 ===')
const sg = gradOf('#sidebar'), dg = gradOf('#assistDrawer')
ok('#sidebar 渐变 8px（原 16px）', sg.from === '--panel' && sg.to === '--panel2' && sg.px === 8, JSON.stringify(sg))
ok('#assistDrawer 渐变 8px（原 16px）', dg.from === '--panel' && dg.to === '--panel2' && dg.px === 8, JSON.stringify(dg))
ok('三条缝渐变高度一致（视觉节奏统一）', mg.px === sg.px && sg.px === dg.px, `${mg.px}/${sg.px}/${dg.px}`)
ok('三条缝的渐变起点 token 都等于 #topbar 背景（同色 → 无硬边）',
  mg.from === '--panel' && sg.from === '--panel' && dg.from === '--panel' && /background:\s*var\(--panel\)/.test(topbar))
ok('#assistMonitor 仍是透明底（否则盖住抽屉渐变）', /background:\s*transparent/.test(rule('#assistMonitor')))

console.log('\n=== ③ 导轨伸长方向：向右 ===')
const rail = rule('#qaRail')
ok('#qaRail align-items: flex-start（左缘固定 → 向右长）', /align-items:\s*flex-start/.test(rail), rail)
ok('#qaRail left: 22px（T46 由 14px 再右移，明显离开窗口左缘）', /left:\s*22px/.test(rail))
ok('导轨块内没有 margin-left（横向位移全部交给 width）', (() => {
  const i0 = cssRaw.indexOf('D5 左侧问答短横线导航轨'), i1 = cssRaw.indexOf('P0-4 活动流')
  return i0 > 0 && i1 > i0 && !/margin-left/.test(cssRaw.slice(i0, i1).replace(/\/\*[\s\S]*?\*\//g, ''))
})())
const left = +(rail.match(/left:\s*(\d+)px/) || [])[1]
const hoverW = +((ruleWith('#qaRail .qa-dash:hover', 'width:\\s*\\d+px').match(/width:\s*(\d+)px/) || [])[1])
const msg = rule('#messages')
// T51：padding-left 变为 var(--padL)，正文起点改从 --padL 声明读取（保留旧字面量兜底）
const padLv = +((msg.match(/--padL:\s*(\d+)px/) || [])[1]) || (+(msg.match(/padding:[^;]*?(\d+)px;/) || [])[1] || 0)
const textLeft = +((msg.match(/margin:\s*[\d.]+px\s+(\d+)px/) || [])[1]) + padLv
ok(`向右最长到 ${left + hoverW}px，正文起点 ${textLeft}px，净距 ${textLeft - left - hoverW}px ≥ 8px`,
  textLeft - left - hoverW >= 8, `railRight=${left + hoverW} textLeft=${textLeft}`)

console.log('\n=== ④ 流畅度：过渡参数 + 波纹重绘 ===')
const dash = rule('#qaRail .qa-dash')
const grow = ruleWith('#qaRail .qa-dash:hover', 'cubic-bezier')
ok('缩回不再用老参数 .35s ease .12s（快速划过时跟不上）', !/\.35s/.test(dash) && !/\.35s/.test(grow), dash)
ok('缩回时长 .2s + 延迟 .05s（保留"顿一下再缩"但不拖）', /width \.2s[^;]*\.05s/.test(dash), dash)
ok('伸长用项目统一缓动 cubic-bezier(.22,.61,.36,1) + .16s', /width \.16s cubic-bezier\(\.22,\.61,\.36,1\)/.test(grow), grow || '(未取到 .qa-dash:hover 规则)')
ok('只过渡 width / background（无无关属性参与插值）',
  splitCommas((dash.match(/transition:\s*([^;]*)/) || ['', ''])[1]).every(p => /^(width|background)\b/.test(p)),
  (dash.match(/transition:\s*([^;]*)/) || ['', ''])[1])

ok('存在幂等的波纹重绘函数 paintQaRipple', /function paintQaRipple\(rail\)/.test(script))
// T76 修订：本条原为「波纹按当前真正 :hover 的那条重算」。T76 起主判据换成「按指针 Y 到各短横
// 中心的距离取最近」（短横高 3px、间距 6px，间隙比短横本身还宽，只认 :hover 时指针落在间隙里
// 一条都不命中 → 整片波纹熄灭）；下面这条断言现在守护的是**保底分支**：没有指针信息时仍按 :hover
// 重算。主判据的断言在 check-t76-rail-nearest.mjs，勿把这条删掉（它保证 T42 的兜底没被改坏）。
ok('波纹在没有指针信息时仍按 :hover 重算（T76 起为兜底分支，主判据见 check-t76）',
  /sibs\.findIndex\(\(s\) => s\.matches\(":hover"\)\)/.test(script))
ok('旧的无条件清空写法已移除（导致快速划过时波纹被抹掉）', !/querySelectorAll\("\.qa-dash\.near, \.qa-dash\.far"\)/.test(script))
ok('dash 的 enter / leave 都走 paintQaRipple', (script.match(/paintQaRipple\(rail\)/g) || []).length >= 4,
  `调用点 ${(script.match(/paintQaRipple\(rail\)/g) || []).length} 处`)
ok('滚动屏蔽 hover 的窗口 150ms → 90ms', /classList\.remove\("scrolling"\), 90\)/.test(script) && !/remove\("scrolling"\), 150\)/.test(script))

// ---- 仿真执行 paintQaRipple：证明「enter/leave 顺序颠倒」不再把波纹抹掉 ----
const fnBody = extractFn('paintQaRipple')
let paint = null
try { paint = new Function(fnBody + '; return paintQaRipple')() } catch (e) { paint = null }
ok('paintQaRipple 可独立执行', typeof paint === 'function')

// 极简假 DOM：rail.querySelectorAll 返回短横数组，短横 matches(":hover") 由 rail.hovered 决定，
// 因此可以在同一个 rail 上"移动指针"，真实复现 enter/leave 顺序颠倒的场景
const makeRail = (n, hovered = -1) => {
  const dashes = []
  const rail = { hovered, querySelectorAll: () => dashes }
  for (let i = 0; i < n; i++) {
    const set = new Set()
    dashes.push({
      classList: { toggle: (name, on) => { on ? set.add(name) : set.delete(name) } },
      matches: (sel) => sel === ':hover' && rail.hovered === i,
      cls: set,
    })
  }
  return { rail, dashes }
}
const readout = (dashes) => dashes.map(d => (d.cls.has('near') ? 'N' : d.cls.has('far') ? 'F' : '.')).join('')
const ripple = (n, hovered) => { const { rail: r, dashes } = makeRail(n, hovered); paint(r); return readout(dashes) }

if (typeof paint === 'function') {
  // 期望串说明：位置 i 的字符 = 该短横的类。hover 在第 3 条（idx=2）时：
  //   idx0 距离 2 → far=F，idx1 距离 1 → near=N，idx2 自身=.，idx3 距离 1 → N，idx4 距离 2 → F
  ok('hover 第 3 条（n=7）→ 波纹 FN.NF..（两侧 ±1 near、±2 far）', ripple(7, 2) === 'FN.NF..', ripple(7, 2))
  ok('hover 第 1 条 → 上边界收窄，只向右溢 .NF....', ripple(7, 0) === '.NF....', ripple(7, 0))
  ok('hover 最后一条 → 下边界收窄，只向左溢 ....FN.', ripple(7, 6) === '....FN.', ripple(7, 6))
  ok('指针离开整条导轨（hovered=-1）→ 波纹全清 .......', ripple(7, -1) === '.......', ripple(7, -1))
  ok('同一位置重复重绘结果不变（幂等）', (() => {
    const { rail: r, dashes } = makeRail(9, 4)
    paint(r); const a = readout(dashes); paint(r); const b = readout(dashes)
    return a === b
  })())
  // ★ 核心回归：指针从第 2 条滑到第 3 条。真实事件顺序是 B-enter 先于 A-leave，
  //   旧实现在 A-leave 里无条件清空 → 刚点亮的波纹被抹掉（用户看到的「不流畅」）。
  ok('★ 快速划过（enter/leave 顺序颠倒）后波纹仍落在新条上', (() => {
    const { rail: r, dashes } = makeRail(7, 1)
    paint(r)                 // 指针在第 2 条
    r.hovered = 2            // 滑到第 3 条
    paint(r)                 // = 上一条的 leave 重算
    paint(r)                 // = 新一条的 enter 重算（顺序颠倒也不影响）
    return readout(dashes) === ripple(7, 2)
  })(), '实际 ' + (() => { const { rail: r, dashes } = makeRail(7, 1); paint(r); r.hovered = 2; paint(r); paint(r); return readout(dashes) })() + ' vs 期望 ' + ripple(7, 2))
  ok('划出导轨后不留残留波纹', (() => {
    const { rail: r, dashes } = makeRail(7, 3)
    paint(r); r.hovered = -1; paint(r)
    return readout(dashes) === '.......'
  })())
}

console.log('\n=== ⑤ 静态完整性 ===')
writeFileSync('.tmp-t42.js', script)
try {
  execFileSync(process.execPath, ['--check', '.tmp-t42.js'], { stdio: 'pipe' })
  ok('整段 <script> 语法可解析（node --check）', true)
} catch (e) { ok('整段 <script> 语法可解析（node --check）', false) } finally { try { unlinkSync('.tmp-t42.js') } catch {} }

let d = 0, bal = true
for (const c of css.replace(/\/\*[\s\S]*?\*\//g, '')) { if (c === '{') d++; else if (c === '}') { d--; if (d < 0) { bal = false; break } } }
ok('CSS 括号配对', bal && d === 0)
// 两个主题下 panel/bg/panel2 两两不同（否则渐变不可见）
const tv = (b) => Object.fromEntries([...b.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]))
for (const [name, blk] of [['暗色', css.match(/:root\s*\{([\s\S]*?)\}/)[1]], ['亮色', css.match(/html\.light\s*\{([\s\S]*?)\}/)[1]]]) {
  const v = tv(blk)
  ok(`${name}主题 panel / panel2 / bg 两两不同（三处渐变都看得见）`,
    v.panel !== v.panel2 && v.panel !== v.bg && v.panel2 !== v.bg, JSON.stringify({ panel: v.panel, panel2: v.panel2, bg: v.bg }))
}

console.log(`\n${fail === 0 ? '全部通过' : '存在失败项'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
