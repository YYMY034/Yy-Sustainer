import { readFileSync } from 'node:fs'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]

// 1) 解析两套主题变量
function vars(block) {
  const out = {}
  for (const m of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}
const dark = vars(css.match(/:root \{([\s\S]*?)\}/)[1])
const light = vars(css.match(/html\.light \{([\s\S]*?)\}/)[1])

// 2) 取选择器的 background 声明
function bgOf(sel) {
  const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
  const m = css.match(re)
  if (!m) return 'NOT-FOUND'
  const b = m[1].match(/background:\s*([^;]+);/)
  return b ? b[1].trim() : '(inherit)'
}
function resolve(decl, V) {
  const m = decl.match(/var\(--([\w-]+)\)/)
  return m ? (V[m[1]] ?? '?' + m[1]) : decl
}

const targets = [
  ['侧栏 #sidebar', '#sidebar'],
  ['会话项 hover .sess:hover', '.sess:hover'],
  ['快捷项 hover .qitem:hover', '.qitem:hover'],
  ['输出区 #messages', '#messages'],
  ['输入区 #inputArea', '#inputArea'],
  ['输入框 #composer', '#composer'],
  ['红绿灯 hover #ctxLight:hover', '#ctxLight:hover'],
  ['右抽屉 #assistDrawer', '#assistDrawer'],
  ['辅助聊天 #assistPane', '#assistPane'],
  ['辅助气泡 .amsg .abody', '.amsg .abody'],
  ['辅助输入行 #assistInputRow', '#assistInputRow'],
  ['辅助输入框 #assistInput', '#assistInput'],
  ['监工卡 #assistWatchRow', '#assistWatchRow'],
  ['文件栏按钮 #fmBar button', '#fmBar button'],
  ['文件项 hover .fm-item:hover', '.fm-item:hover'],
  ['顶栏 #topbar', '#topbar'],
]
console.log('区域                      | 暗色主题        | 亮色主题')
console.log('-'.repeat(78))
for (const [label, sel] of targets) {
  const d = bgOf(sel)
  console.log(label.padEnd(24) + ' | ' + resolve(d, dark).padEnd(14) + ' | ' + resolve(d, light))
}
const lightBubble = css.match(/html\.light \.msg\.user > \.bubble \{([^}]*)\}/)
console.log('\n亮色用户气泡: ' + (lightBubble ? lightBubble[1].match(/background:\s*([^;]+);/)[1] : 'NOT-FOUND'))
