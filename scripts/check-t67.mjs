// T67 校验：去掉回复末尾「产物」面板（与「修改 N 个文件」重复），fileOps 下拉文件行加 fmIcon 图标 + 点击预览
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

console.log('=== ① 产物面板已移除 ===')
ok('无 .artifacts CSS 规则（面板样式已删）', !/\.artifacts\s*\{/.test(cssNoCmt))
ok('JS 不再拼 artifactsBlock / art-item / art-title',
  !script.includes('artifactsBlock') && !script.includes('art-item') && !script.includes('art-title'))
ok('反向：fileOps 的 file-cards 仍在（内联内容路径卡未误删）', script.includes('class="file-cards"') && script.includes('class="file-card"'))

console.log('=== ② fo-file 图标 + 预览 ===')
const foFileGen = script.slice(script.indexOf('m.fileEdits.map'), script.indexOf('m.fileEdits.map') + 400)
ok('fo-file 带 data-path + fmIcon 图标 + 标题提示点击预览',
  /class="fo-file" data-path="\$\{esc\(f\.path\)\}" title="\$\{esc\(f\.path\)\}（点击预览）"/.test(foFileGen) &&
  /<span class="aico">\$\{fmIcon\(fn\)\}<\/span>/.test(foFileGen), foFileGen.slice(0, 160))
ok('fo-file 点击处理：可预览 openPreview / 否则 downloadFile（bindMediaEvents 里）',
  /\.fileops \.fo-file/.test(script) && /if \(!PREVIEWABLE\.test\(name\)\) \{ downloadFile\(p\); return \}/.test(script) && /openPreview\(p, name\)/.test(script))
ok('点击不劫持撤销按钮（.fo-undo 早返回）', /if \(e\.target\.closest\("\.fo-undo"\)\) return/.test(script))
ok('fo-file cursor:pointer（可点提示）', /cursor:\s*pointer/.test(rule('.fileops .fo-file')), rule('.fileops .fo-file'))
ok('fo-file aico flex 居中不撑破行', /display:\s*flex/.test(rule('.fileops .fo-file .aico')))

console.log('=== ③ 文案与语法配平 ===')
ok('预览空态文案去掉「产物」（改「修改的文件」）', !html.includes('「文件管理」「产物」') && html.includes('在「文件管理」或「修改的文件」里点击文件在此预览'))
try { writeFileSync('scripts/.t67-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t67-tmp.mjs']); unlinkSync('scripts/.t67-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== ④ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('网关下发首页已无 .artifacts 规则、含 fo-file 预览',
    !/\.artifacts\s*\{/.test(served.replace(/\/\*[\s\S]*?\*\//g, '')) && served.includes('class="fo-file" data-path'))
  setTimeout(() => process.exit(fail ? 1 : 0), 60)
} catch { console.log('SKIP 网关未运行，跳过活体检查'); setTimeout(() => process.exit(fail ? 1 : 0), 60) }
