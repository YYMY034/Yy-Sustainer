// T39 校验：文件行图标与「文件管理」共用同一套 fmIcon
// T67 起：回复末尾的「产物」面板（.artifacts）已移除，其文件展示职责由「修改 N 个文件」下拉
// （.fileops .fo-file）承接——同款 fmIcon 类型图标 + 点击进实时预览/下载。断言随之重定向到 fo-file。
// 离线跑，不依赖浏览器：① 整段脚本语法检查 ② fmIcon 可独立执行 ③ 接线/样式断言 ④ TDZ 顺序断言
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]

let pass = 0, fail = 0
const ok = (name, v) => { if (v) { pass++; console.log('OK   ' + name) } else { fail++; console.log('FAIL ' + name) } }

// ① 整段 <script> 语法检查（临时文件 + node --check，能捕获模板串/注释整段写坏的情况）
writeFileSync('.tmp-t39.js', script)
try {
  execFileSync(process.execPath, ['--check', '.tmp-t39.js'], { stdio: 'pipe' })
  ok('整段 <script> 语法可解析（node --check）', true)
} catch (e) {
  ok('整段 <script> 语法可解析（node --check）', false)
  console.log(String(e.stderr ?? e).slice(0, 800))
} finally {
  try { unlinkSync('.tmp-t39.js') } catch {}
}

// ② fmIcon 独立执行（纯函数）
const start = script.indexOf('const FM_FOLDER_PATH')
const end = script.indexOf('\n}', script.indexOf('function fmIcon')) + 2
const { fmIcon } = new Function(script.slice(start, end) + '; return { fmIcon }')()
ok('fmIcon 可独立执行', typeof fmIcon === 'function')

// ③ 文件行接线（T67：fileOps 的 fo-file 承接原产物区）：用 fmIcon、带 data-path、点击预览接线在
ok('fo-file 用 fmIcon 生成图标', /<span class="aico">\$\{fmIcon\(fn\)\}<\/span>/.test(script))
ok('fo-file 带 data-path（点击预览接线）', /class="fo-file" data-path="\$\{esc\(f\.path\)\}"/.test(script))
ok('fo-file 点击预览处理在（可预览 openPreview，否则 downloadFile）',
  /\.fileops \.fo-file/.test(script) && /PREVIEWABLE\.test\(name\)\) \{ downloadFile\(p\); return \}/.test(script) && /openPreview\(p, name\)/.test(script))
ok('反向：产物面板 .artifacts 已移除（T67），不再有 art-item/art-title 生成', !/class="art-item"/.test(script) && !/artifactsBlock/.test(script))
ok('旧的 aico 手写 SVG 已移除', !/class="aico"><svg width="13" height="13"/.test(script))

// ④ TDZ 顺序：FM 常量块必须在 function render() 之前（render 会在脚本尾部同步执行）
const iFm = script.indexOf('const FM_FOLDER_PATH')
const iRender = script.indexOf('function render(')
ok('FM 图标块位于 render() 之前（无 TDZ 风险）', iFm > 0 && iRender > 0 && iFm < iRender)

// ⑤ 样式：文件行 aico flex 居中（T67 fo-file）；文件管理图标规则仍在
ok('fo-file aico flex 居中', /\.fileops \.fo-file \.aico \{ display: flex; align-items: center; flex-shrink: 0; \}/.test(css))
ok('文件管理图标规则未动', /\.fm-item > svg \{ flex-shrink: 0; \}/.test(css))

// ⑥ 两侧图标像素完全一致（同一函数同一入参 → 字符串相等）
const names = ['a.py', 'b.html', 'c.ts', 'd.png', 'e.xlsx', 'f.zip', 'g.md', 'h.json', 'i.sh', 'j.unknown', 'k.pdf']
let same = 0
for (const n of names) {
  const inArtifacts = fmIcon(n)
  const inFileManager = fmIcon(n, undefined)
  if (inArtifacts === inFileManager && inArtifacts.includes('</svg>')) same++
}
ok(`抽样 ${names.length} 个文件名两侧图标完全一致`, same === names.length)

// ⑦ CSS 括号配对
let d = 0, bal = true
for (const c of css) { if (c === '{') d++; else if (c === '}') { d--; if (d < 0) { bal = false; break } } }
ok('CSS 括号配对', bal && d === 0)

console.log(`\n${fail === 0 ? '全部通过' : '存在失败项'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
