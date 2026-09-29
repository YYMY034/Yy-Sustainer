// T86 校验：钩子扩充（6 内置）/ 分段控件滑块系统 / 用量双图翻转卡 / todo 任务卡片常驻可展开
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const config = readFileSync('src/agent/config.ts', 'utf8')
const cssNoCmt = css.replace(/\/\*[\s\S]*?\*\//g, '')
const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = cssNoCmt.match(new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

let pass = 0, fail = 0
const ok = (n, v, extra) => { if (v) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + (extra ? '  → ' + extra : '')) } }

console.log('=== ① 内置钩子扩充（6 个，新 4 个默认关） ===')
for (const id of ['builtin-safety', 'builtin-format', 'builtin-paths', 'builtin-complete', 'builtin-deps', 'builtin-chinese']) {
  ok(`内置钩子 ${id} 存在`, config.includes(`id: "${id}"`))
}
ok('新 4 个内置钩子默认关闭（成本可控）', ['builtin-paths', 'builtin-complete', 'builtin-deps', 'builtin-chinese'].every((id) => {
  const i = config.indexOf(`id: "${id}"`)
  return i > -1 && /enabled: false/.test(config.slice(i, i + 160))
}))
ok('种子幂等逻辑不变（缺失补回）', config.includes('BUILTIN_HOOKS.filter((b) => !builtinIds.has(b.id))'))

console.log('=== ② 分段控件滑块系统 ===')
ok('slideAllSegs 定义（offsetLeft/offsetWidth 定位，兼容不等宽与 hdel）',
  script.includes('function slideAllSegs()') && script.includes('slots[idx].offsetLeft - 2') && script.includes('slots[idx].offsetWidth'))
ok('hdel 不计入槽位', script.includes("!b.classList.contains(\"hdel\")"))
ok('隐藏容器跳过（offsetWidth < 10）', script.includes('if (seg.offsetWidth < 10) return'))
ok('CSS：.seg-slide 滑块（transform 过渡 + z-index 层级）',
  /transition:\s*transform \.18s cubic-bezier\(\.22,\.61,\.36,1\)/.test(rule('.seg-slide .seg-thumb')) &&
  /z-index:\s*0/.test(rule('.seg-slide .seg-thumb')))
ok('CSS：active 按钮透明底交由滑块、只变色', /background:\s*transparent !important/.test(rule('.seg-slide > button')))
ok('接线：applyTheme/applyRailMode/renderWatchSeg/renderHooks/loadDataSec/renderUsageCharts 都有 slideAllSegs',
  (script.match(/slideAllSegs\(\)/g) || []).length >= 8)
// 反向：滑块助手本体是纯视觉层（抽函数体检查，不碰 localStorage）
const slideFn = script.slice(script.indexOf('function slideAllSegs()'), script.indexOf('function applyTheme('))
ok('反向：滑块助手本体不碰 localStorage', !slideFn.includes('localStorage'))

console.log('=== ③ 用量双图翻转卡 ===')
ok('flip-card 结构（front 热力图 / back 环形图 / 点卡翻面带交互排除）',
  script.includes('id="usageFlip"') && script.includes('class="flip-face front"') && script.includes('class="flip-face back"') && script.includes('closest("button, a, input, .seg, #hmSeg, #usageRefresh")'))
// T91 调整：翻转轴从左右（rotateY）改成上下（rotateX）——左右翻转视觉上像"换了内容"，
// 上下翻转像"同一张卡翻了个面"，更符合卡片直觉。三板斧（preserve-3d + backface-visibility）不变。
ok('CSS：preserve-3d + backface-visibility + rotateX(180deg)',
  /transform-style:\s*preserve-3d/.test(rule('.flip-inner')) &&
  /backface-visibility:\s*hidden/.test(rule('.flip-face')) &&
  /rotateX\(180deg\)/.test(rule('.flip-card.flipped .flip-inner')))
ok('翻面按钮点击 toggle .flipped', /classList\.toggle\("flipped"\)/.test(script))

console.log('=== ④ todo 任务卡片常驻可展开 ===')
ok('语义：全部完成后 10s 收拢为摘要条（不再整体消失）',
  /bar\.className = todoExpanded \? "show expanded" : "show"/.test(script))
ok('空闲无任务才隐藏', /!todoShownForBusy && !has/.test(script))
// 反向：todoToggle 的 ▾ 文本字形换成 chevron SVG（范围限定 todoBar，别处下拉箭头不连坐）
const todoToggle = html.match(/<button id="todoToggle"[\s\S]*?<\/button>/)?.[0] ?? ""
ok('展开动画 todoUnfold + chevron SVG（禁文本 ▾）',
  /@keyframes todoUnfold/.test(cssNoCmt) && todoToggle.includes('<svg') && !todoToggle.includes('▾'))

console.log('=== ⑤ 语法与配平 ===')
try { writeFileSync('scripts/.t86-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t86-tmp.mjs']); unlinkSync('scripts/.t86-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
