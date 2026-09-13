// T54 校验：侧栏折叠外拉量动态化（-260px 写死 → calc(-1 * var(--side-w)) + ResizeObserver 同步），
// 修「左栏收起+右栏打开启动时输入框左缘超出窗口」——侧栏宽 180–420 可拖，写死任何值都会让 #main 偏出窗口
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

console.log('=== ① CSS：折叠外拉量动态化 ===')
const collapsed = rule('body.side-collapsed #sidebar')
ok('折叠 margin 改 calc(-1 * var(--side-w, 250px))', /margin-left:\s*calc\(-1 \* var\(--side-w, 250px\)\)/.test(collapsed), collapsed)
ok('反向：写死的 margin-left: -260px 已死', !cssNoCmt.includes('margin-left: -260px'))
ok('折叠态其余规则保留（opacity/pointer-events/overflow）',
  /opacity:\s*0/.test(collapsed) && /pointer-events:\s*none/.test(collapsed) && /overflow:\s*hidden/.test(collapsed))

console.log('=== ② JS：--side-w 同步 ===')
ok('syncSideCollapseVar 定义（读侧栏实际宽度写 body var）',
  /function syncSideCollapseVar\(\) \{ document\.body\.style\.setProperty\("--side-w", Math\.round\(\$\("sidebar"\)\.getBoundingClientRect\(\)\.width\) \+ "px"\) \}/.test(script))
ok('初始同步 + ResizeObserver 持续同步（宽度恢复/拖拽都覆盖）',
  /syncSideCollapseVar\(\)\nnew ResizeObserver\(syncSideCollapseVar\)\.observe\(\$\("sidebar"\)\)/.test(script))
ok('反向：collapseSidebar 不再写内联 margin（单一事实来源 = CSS calc + var）',
  !/sb\.style\.marginLeft = `-\$\{sb\.getBoundingClientRect\(\)\.width \+ 14\}px`/.test(script))
ok('反向：+14 过拉量已废（宽度≠260 时多拉出窗口的元凶）',
  !/getBoundingClientRect\(\)\.width \+ 14\}px/.test(script))
ok('expandSidebar 仍清内联 margin（拖拽期间可能残留）',
  /\$\("sidebar"\)\.style\.marginLeft = ""/.test(script))

console.log('=== ③ 语法与配平 ===')
try { writeFileSync('scripts/.t54-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t54-tmp.mjs']); unlinkSync('scripts/.t54-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== ④ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('网关下发的首页已含动态折叠量', served.includes('calc(-1 * var(--side-w, 250px))') && served.includes('syncSideCollapseVar'))
} catch { console.log('SKIP 网关未运行，跳过活体检查') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
