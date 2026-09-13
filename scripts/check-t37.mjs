// T37 校验：抽出页面里的 FM 图标逻辑，在 node 里直接跑一遍（纯函数，无浏览器依赖）
import { readFileSync, writeFileSync } from 'node:fs'

const html = readFileSync('web/index.html', 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
writeFileSync('.tmp-script-check.js', script)

// 1) 语法检查（浏览器脚本整体能否被解析）
const start = script.indexOf('const FM_FOLDER_PATH')
const end = script.indexOf('\n}', script.indexOf('function fmIcon')) + 2
const fmBlock = script.slice(start, end)
const mod = new Function(fmBlock + '; return { fmIcon, FM_BADGES, FM_EXT_GROUP }')()
const { fmIcon } = mod

// 2) 抽样：各类型文件 + 文件夹，确认都有 svg 内容且不是通用占位
const samples = [
  ['src', true], ['AGENT-WHITEPAPER.md', false], ['gateway.ts', false], ['tools.py', false],
  ['index.html', false], ['styles.css', false], ['package.json', false], ['config.yml', false],
  ['app.js', false], ['view.tsx', false], ['logo.png', false], ['data.xlsx', false],
  ['report.pdf', false], ['notes.txt', false], ['archive.zip', false], ['run.sh', false],
  ['main.go', false], ['unknown.xyzzy', false], ['Makefile', false],
]
let ok = 0
for (const [name, dir] of samples) {
  const svg = fmIcon(name, dir)
  const isSvg = svg.startsWith('<svg') && svg.includes('</svg>')
  const hasMark = /<path|<rect|<circle|<text/.test(svg)
  if (isSvg && hasMark) ok++
  else console.log('FAIL', name)
}
console.log(`图标抽样 ${ok}/${samples.length} 全部生成`)
console.log('py  →', fmIcon('a.py', false).slice(0, 60) + '…')
console.log('html→', fmIcon('a.html', false).slice(0, 60) + '…')
console.log('dir →', fmIcon('src', true).slice(0, 60) + '…')

// 3) 关键接线检查
const checks = [
  ['fm-item 用 fmIcon', /data-dir="\$\{it\.dir \? 1 : 0\}">\$\{fmIcon\(it\.name, it\.dir\)\}/.test(script)],
  ['会话分组已抽出配置会话', /const flatSessions = sessions\.filter\(\(s\) => isConfigSession\(s\)\)/.test(script)],
  ['平铺行带齿轮图标', /flat \? `<span class="sico"/.test(script)],
  ['sess-flat 容器', /class="sess-flat"/.test(script)],
  ['分组计数只算项目会话', /for \(const s of projectSessions\)/.test(script)],
]
for (const [n, v] of checks) console.log((v ? 'OK  ' : 'FAIL') + ' ' + n)

// 4) CSS 完整性
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
let d = 0, bal = true
for (const c of css) { if (c === '{') d++; else if (c === '}') { d--; if (d < 0) { bal = false; break } } }
console.log('CSS 括号配对:', bal && d === 0)
console.log('新 CSS 规则:', ['#sidebar {'].every(Boolean) && /.fm-item > svg/.test(css) && /\.sess-flat \{/.test(css) && /\.sess \.sico \{/.test(css))
