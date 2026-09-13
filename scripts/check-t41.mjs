// T41 校验：文件管理「上一级 / 刷新」与「回到底部」三个图标的形状与外壳样式
// 离线跑：结构断言 + 内联 SVG 合法性（viewBox / 路径字符合法性 / 坐标范围 / currentColor）+ 语法与括号
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]

let pass = 0, fail = 0
const ok = (n, v, extra) => { if (v) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + (extra ? '  → ' + extra : '')) } }

const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = css.match(new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}
const noComment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
// 抓某个静态按钮的 HTML 片段（按钮内部只有 svg，没有嵌套按钮）
const btnHtml = (id) => {
  const m = html.match(new RegExp(`<button id="${id}"[^>]*>([\\s\\S]*?)</button>`))
  return m ? m[1] : ''
}
const svgOf = (frag) => (frag.match(/<svg[\s\S]*?<\/svg>/) || [''])[0]

console.log('=== ① 文件管理：上一级 / 刷新 ===')
const fmBtn = rule('#fmBar button'), fmHov = rule('#fmBar button:hover')
ok('#fmBar button 去掉了白底（background: transparent）', /background:\s*transparent/.test(fmBtn), fmBtn)
ok('#fmBar button 去掉了描边（border: none）', /border:\s*none/.test(fmBtn))
ok('#fmBar button 图标色 = var(--dim)（与顶栏图标按钮一致）', /color:\s*var\(--dim\)/.test(fmBtn))
ok('#fmBar button 已无 font-size（不再靠文本字形）', !/font-size/.test(fmBtn))
ok('#fmBar button:hover 浮出浅底 + accent（侧栏 hover 规矩）',
  /background:\s*var\(--panel\)/.test(fmHov) && /color:\s*var\(--accent\)/.test(fmHov), fmHov)

const fmBarFull = (html.match(/<div id="fmBar">[\s\S]*?<\/div>/) || [''])[0]
ok('#fmBar 里不再有 ↑ / ⟳ 文本字形', !/[↑⟳]/.test(fmBarFull))
const upSvg = svgOf(btnHtml('fmUp')), rfSvg = svgOf(btnHtml('fmRefresh'))
ok('#fmUp 已换成内联 SVG', upSvg.startsWith('<svg'))
ok('#fmRefresh 已换成内联 SVG', rfSvg.startsWith('<svg'))
ok('#fmUp 是「向上箭头 + 顶横线」三笔（竖轴/箭头/横线）',
  (upSvg.match(/<path/g) || []).length === 3, `path 数 = ${(upSvg.match(/<path/g) || []).length}`)
ok('#fmRefresh 是环形箭头（弧 + 箭头拐角两笔）',
  (rfSvg.match(/<path/g) || []).length === 2 && /a5\.5 5\.5 0 11/.test(rfSvg))

// 全站统一：刷新按钮复用回复操作条 REGEN_SVG 的同一条弧路径
const regen = script.match(/const REGEN_SVG = '([^']+)'/)
ok('刷新图标与回复操作条 REGEN_SVG 用同一条弧路径（全站统一）',
  !!regen && rfSvg.includes('M13.5 8a5.5 5.5 0 11-1.6-3.9') && regen[1].includes('M13.5 8a5.5 5.5 0 11-1.6-3.9'),
  regen ? regen[1].slice(0, 60) : '(REGEN_SVG 未找到)')

console.log('\n=== ② 回到底部 ===')
const jb = rule('#jumpBottom'), jbHov = rule('#jumpBottom:hover')
ok('#jumpBottom 硬描边改半透明（color-mix 60%）', /border:\s*1px solid color-mix\(in srgb, var\(--border\) 60%, transparent\)/.test(jb), jb.slice(0, 160))
ok('#jumpBottom 保留柔投影', /box-shadow:/.test(jb))
ok('#jumpBottom 已无 font-size（不再靠文本字形）', !/font-size/.test(jb))
ok('#jumpBottom hover 边框转 accent 混色 + 浮出 panel 底',
  /color-mix\(in srgb, var\(--accent\) 45%, var\(--border\)\)/.test(jbHov) && /background:\s*var\(--panel\)/.test(jbHov), jbHov)
const jbSvg = svgOf(btnHtml('jumpBottom'))
ok('#jumpBottom 已换成内联 SVG（不再是 ↓ 文本）', jbSvg.startsWith('<svg') && !/>↓</.test(html))
ok('#jumpBottom 是「向下箭头 + 底横线」三笔',
  (jbSvg.match(/<path/g) || []).length === 3, `path 数 = ${(jbSvg.match(/<path/g) || []).length}`)

console.log('\n=== ③ 内联 SVG 合法性（三个图标逐个查） ===')
const svgs = [['上一级', upSvg], ['刷新', rfSvg], ['回到底部', jbSvg]]
for (const [name, s] of svgs) {
  const vb = /viewBox="0 0 16 16"/.test(s)
  const fillNone = /fill="none"/.test(s)
  const cur = !/stroke="(?!currentColor)/.test(s) && !/fill="(?!none|currentColor)/.test(s)
  const selfClosed = (s.match(/<path/g) || []).length === (s.match(/\/>/g) || []).length
  // 路径 d 只允许合法指令字母与数字/分隔符
  const ds = [...s.matchAll(/ d="([^"]*)"/g)].map(m => m[1])
  const legal = ds.length > 0 && ds.every(d => /^[MmLlHhVvCcSsQqTtAaZz0-9.,\-\s]+$/.test(d))
  // 坐标范围：viewBox 16，留 1 单位余量（防止笔误写出 160 这种天外数值）
  const nums = ds.flatMap(d => (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number))
  const inRange = nums.every(n => Math.abs(n) <= 20)
  ok(`${name}：viewBox/fill/currentColor/自闭合/路径字符合法/坐标在界内`,
    vb && fillNone && cur && selfClosed && legal && inRange,
    `vb=${vb} fill=${fillNone} cur=${cur} closed=${selfClosed} legal=${legal} range=${inRange} nums=${nums.join(',')}`)
}

console.log('\n=== ④ 接线未破坏 ===')
ok('fmUp 的 visibility 显隐逻辑仍在', /\$\("fmUp"\)\.style\.visibility = d\.parent \? "visible" : "hidden"/.test(script))
ok('fmUp / fmRefresh 的 onclick 仍在', /\$\("fmUp"\)\.onclick/.test(script) && /\$\("fmRefresh"\)\.onclick/.test(script))
ok('jumpBottom 的绑定函数未改动（onclick + show 切换）',
  /jb\.onclick = \(e\) =>/.test(script) && /jb\.classList\.toggle\("show", !nearBottom\(120\)\)/.test(script))
ok('SVG 里没有 <text> 元素（确认不再是文本字形）', svgs.every(([, s]) => !/<text/.test(s)))

console.log('\n=== ⑤ 静态完整性 ===')
writeFileSync('.tmp-t41.js', script)
try {
  execFileSync(process.execPath, ['--check', '.tmp-t41.js'], { stdio: 'pipe' })
  ok('整段 <script> 语法可解析（node --check）', true)
} catch (e) { ok('整段 <script> 语法可解析（node --check）', false) } finally { try { unlinkSync('.tmp-t41.js') } catch {} }

let d = 0, bal = true
for (const c of noComment(css)) { if (c === '{') d++; else if (c === '}') { d--; if (d < 0) { bal = false; break } } }
ok('CSS 括号配对', bal && d === 0)

// 三个按钮都渲染在页面里（标签配对）
ok('#fmBar 与 #jumpBottom 的 HTML 标签配对完整',
  (html.match(/<div id="fmBar">[\s\S]*?<\/div>/) || [''])[0].includes('</div>') && /id="jumpBottom"[^>]*>[\s\S]*?<\/button>/.test(html))

console.log(`\n${fail === 0 ? '全部通过' : '存在失败项'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
