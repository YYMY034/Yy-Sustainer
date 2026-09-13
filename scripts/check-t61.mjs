// T61 校验：问答导轨全窗高居中——updateQaRailOffset 不再写 style.top/height（旧逻辑锁 #messages
// 导致导轨整体偏高），恢复 CSS top:0/height:100%（#main 整条内容区）+ justify-content:center
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

console.log('=== ① CSS：全高居中基准 ===')
const rail = rule('#qaRail')
ok('#qaRail 全窗居中（top 上移半个顶栏 + height:100%，T64）',
  /top:\s*calc\(var\(--topbar-h, 37px\) \/ -2\)/.test(rail) && /height:\s*100%/.test(rail), rail)
ok('启动即写 --topbar-h（导轨 top 偏移依赖）', script.includes('setProperty("--topbar-h", $("topbar").offsetHeight'));
ok('短横列 justify-content: center（中线即整窗高中线）', /justify-content:\s*center/.test(rail))

console.log('=== ② JS：不再写 style.top/height ===')
const fn = script.slice(script.indexOf('function updateQaRailOffset'), script.indexOf('function updateQaRailOffset') + 1400)
ok('反向：updateQaRailOffset 不再写 rail.style.top/height（T61 前的偏高根源）',
  !/rail\.style\.top\s*=/.test(fn) && !/rail\.style\.height\s*=/.test(fn), fn.slice(0, 200))
ok('保留活跃轮 transform 平移能力（T64 起仅超长列钳制滑动）', /rail\.style\.transform/.test(fn))
ok('cur 判定与 .cur 高亮逻辑保留', /el\.classList\.toggle\("cur", i === cur\)/.test(script))
// T64：列整体居中模型——短横列与导轨上下留白相等；只有列比导轨长才滑动且钳制 ±(colH-railH)/2
ok('T64：列整体居中 + 超长钳制滑动（colH/railH/maxShift）',
  /const colH = dashEls\.length \* step - gap/.test(script) &&
  /const railH = rail\.clientHeight/.test(script) &&
  /let offset = 0/.test(script) &&
  /const maxShift = \(colH - railH\) \/ 2/.test(script) &&
  /offset = Math\.max\(-maxShift, Math\.min\(maxShift, desired\)\)/.test(script))
ok('T64 反向：旧「cur 条压中线」的无钳制公式已死',
  !/offset = -\(\(cur - \(dashEls\.length - 1\) \/ 2\) \* \(dashH \+ gap\)\)/.test(script))
ok('T64：offset 为 0 时不写 transform（交给 justify-content:center 居中）',
  script.includes('rail.style.transform = offset ?') && script.includes('translateY'))

console.log('=== ③ 语法与配平 ===')
try { writeFileSync('scripts/.t61-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t61-tmp.mjs']); unlinkSync('scripts/.t61-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== ④ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('网关下发的首页已不含 rail.style.top/height 写入',
    !served.includes('rail.style.top = `${box.offsetTop}') && served.includes('T61：rail 覆盖范围 = #main 整条内容区'))
} catch { console.log('SKIP 网关未运行，跳过活体检查') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
