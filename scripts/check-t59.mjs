// T59 校验：辅助对话 assistant 消息用 fmtBlock 渲染（不再显示 * ### 源码符号）+ #assistMsgs 事件委托
// + markdown 样式桥接（.amsg .abody 与 .msg .body 同规则）+ 过程状态一律进输出区（顶栏零过程状态）
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

console.log('=== ① 辅助对话 markdown 渲染 ===')
ok('renderAssistMsg：assistant 用 fmtBlock，user/monitor 保持 esc 纯文本',
  /const body = m\.role === "assistant" \? fmtBlock\(m\.content\) : esc\(m\.content\)/.test(script))
ok('反向：abody 不再整体 esc（源码符号 * ### 的根源已拔）',
  !/abody">\$\{esc\(m\.content\)\}/.test(script))

console.log('=== ② #assistMsgs 事件委托（导图保存/xlsx 导出在辅助区可用） ===')
ok('#assistMsgs 委托存在（mm-save + mdt-xlsx 同款处理）',
  /\$\("assistMsgs"\)\.addEventListener\("click"/.test(script) &&
  (script.match(/const svgBtn = t\.closest\("\.mm-save"\)/g) || []).length >= 2 &&
  (script.match(/const xlsxBtn = t\.closest\("\.mdt-xlsx"\)/g) || []).length >= 2)
ok('委托调用同一处理函数（saveMindmapPng / exportTableXlsx）',
  (script.match(/saveMindmapPng\(svg, svgBtn\)/g) || []).length >= 2 &&
  (script.match(/exportTableXlsx\(table, xlsxBtn\)/g) || []).length >= 2)

console.log('=== ③ markdown 样式桥接（.amsg .abody 与 .msg .body 同规则） ===')
for (const tail of ['.mdtable th', '.mdtwrap', '.mindmap .mm-save', 'strong', 'code']) {
  const bridged = cssNoCmt.match(new RegExp('\\.amsg(?:\\.assistant)? \\.abody [^{]*' + tail.replace(/\./g, '\\.') + ''))
  ok(`样式桥接覆盖 ${tail}（后代形式）`, !!bridged)
}
// T62 反向：桥接绝不能把规则命中到 .abody 本体——xlsx 悬浮按钮的 position:absolute 曾因此
// 让整个气泡浮到 #main 右上角（用户截图的大框）
const abodyAbsHits = []
cssNoCmt.replace(/([^{}]+)\{([^}]*)\}/g, (m, sel, body) => {
  if (!/position:\s*absolute/.test(body)) return m
  sel.split(',').forEach((x) => { const t = x.trim(); if (t === '.amsg .abody' || t === '.amsg.assistant .abody') abodyAbsHits.push(t) })
  return m
})
ok('反向：.abody 本体零 position:absolute 命中（大框逃逸根源已死）', abodyAbsHits.length === 0, JSON.stringify(abodyAbsHits))
ok('反向：桥接未产生选择器畸变（无 ", ," / ",,"）', !/, ,|,,/.test(cssNoCmt.replace(/,\s*"/g, ',"')))

console.log('=== ④ 过程状态零顶栏（与 check-t57 呼应的独立断言） ===')
ok('status 分支无顶栏写入', !/\$ \{0,0\}/.test("") && !/m\.text \?\? ""; \n?\s*\}\s*\n\s*else if/.test(script) &&
  !/if \(!streamingOn\) \$\("status"\)\.textContent = streamStatusText/.test(script))
ok('refreshState busy 兜底走 ensureStream', /if \(busy\(\)\) \{ streamStatusText = streamStatusText \|\| "任务进行中"; ensureStream\(\) \}/.test(script))

console.log('=== ⑤ 语法与配平 ===')
try { writeFileSync('scripts/.t59-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t59-tmp.mjs']); unlinkSync('scripts/.t59-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== ⑥ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('网关下发的首页已含 fmtBlock 渲染与委托', served.includes('const body = m.role === "assistant" ? fmtBlock(m.content) : esc(m.content)') && served.includes('$("assistMsgs").addEventListener'))
} catch { console.log('SKIP 网关未运行，跳过活体检查') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
