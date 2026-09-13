// T47 校验：问答导轨显隐设置（设置页·外观，localStorage yyagent-rail，body[data-rail] 纯 CSS 联动）
// 离线跑：CSS 三条显隐规则 + 特异性压过 #qaRail.show + 旧 T40 无条件规则已死 + 分段控件四档 + JS 接线 + 语法配平
// 末尾活体检查：网关在跑时直接拉首页，确认下发的就是带新规则的版本（静态文件每请求现读）
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const cssNoCmt = css.replace(/\/\*[\s\S]*?\*\//g, '') // 坑 58①：断言前先剥注释

let pass = 0, fail = 0
const ok = (n, v, extra) => { if (v) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + (extra ? '  → ' + extra : '')) } }

const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = cssNoCmt.match(new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

console.log('=== ① CSS：三条 data-rail 显隐规则 ===')
ok('hidden 档规则存在且 display:none',
  /display:\s*none/.test(rule('body[data-rail="hidden"] #qaRail.show')), rule('body[data-rail="hidden"] #qaRail.show'))
ok('open 档（仅左右侧栏同时打开时让位）规则存在且 display:none',
  /display:\s*none/.test(rule('body[data-rail="open"]:has(#assistDrawer.open):not(.side-collapsed) #qaRail.show')), rule('body[data-rail="open"]:has(#assistDrawer.open):not(.side-collapsed) #qaRail.show'))
ok('closed 档（仅左侧栏收起时）规则存在且 display:none',
  /display:\s*none/.test(rule('body[data-rail="closed"]:not(.side-collapsed) #qaRail.show')), rule('body[data-rail="closed"]:not(.side-collapsed) #qaRail.show'))

// 反向：T40 的无条件旧规则不得复活（那会让「always」默认档也只在收起时显示）
ok('反向：T40 无条件旧规则 body:not(.side-collapsed) #qaRail.show 不存在',
  !/body:not\(\.side-collapsed\)\s*#qaRail\.show/.test(cssNoCmt))
// 反向：open 档的第一版错误语义（左栏收起就隐藏）不得残留
ok('反向：open 档旧语义规则 body.side-collapsed[data-rail="open"] 不存在',
  !/body\.side-collapsed\[data-rail="open"\]\s*#qaRail\.show/.test(cssNoCmt))
// 反向：always 是默认档，靠「无规则」成立 —— 不许有人给它写规则
ok('反向：always 档没有（也不需要有）CSS 规则', !cssNoCmt.includes('data-rail="always"'))

console.log('=== ② 特异性：三条规则必须压过 #qaRail.show (1,1,0) ===')
// 粗算特异性：id 数 / (类+属性+伪类) 数 / 元素数；:not(...) 按其参数计（坑 53 的教训用断言钉死）
const spec = (sel) => {
  const ids = (sel.match(/#[\w-]+/g) || []).length
  const cls = (sel.match(/\.[\w-]+|\[[^\]]+\]|:not\([^)]*\)/g) || []).length
  const els = (sel.match(/(^|[\s>+~])[a-z]+/g) || []).length
  return [ids, cls, els]
}
const beats = (sel) => {
  const [i, c, e] = spec(sel)
  return i > 1 || (i === 1 && (c > 1 || (c === 1 && e > 1))) // 目标 #qaRail.show = (1,1,0)
}
ok('hidden 档特异性 > (1,1,0)', beats('body[data-rail="hidden"] #qaRail.show'), JSON.stringify(spec('body[data-rail="hidden"] #qaRail.show')))
ok('open 档特异性 > (1,1,0)', beats('body[data-rail="open"]:has(#assistDrawer.open):not(.side-collapsed) #qaRail.show'), JSON.stringify(spec('body[data-rail="open"]:has(#assistDrawer.open):not(.side-collapsed) #qaRail.show')))
ok('closed 档特异性 > (1,1,0)', beats('body[data-rail="closed"]:not(.side-collapsed) #qaRail.show'), JSON.stringify(spec('body[data-rail="closed"]:not(.side-collapsed) #qaRail.show')))

console.log('=== ③ 设置页外观卡：四档分段控件 ===')
const segBlock = (html.match(/<div class="seg" id="segRail">[\s\S]*?<\/div>/) || [''])[0]
ok('#segRail 分段控件存在', segBlock.includes('segRail'))
const vals = (segBlock.match(/data-v="(\w+)"/g) || []).map((s) => s.match(/"(\w+)"/)[1])
ok('四档取值与顺序 = always/open/closed/hidden', JSON.stringify(vals) === JSON.stringify(['always', 'open', 'closed', 'hidden']), JSON.stringify(vals))
ok('恰好 4 个按钮', (segBlock.match(/<button/g) || []).length === 4)
const segIdx = html.indexOf('id="segRail"')
ok('位于外观卡内（主题行之后、界面字体行之前）',
  segIdx > html.indexOf('id="segTheme"') && segIdx < html.indexOf('id="fontSelect"'), `segIdx=${segIdx}`)
ok('行说明含「问答导轨」并写明双开让位语义',
  /问答导轨/.test(html.slice(segIdx - 500, segIdx)) && /同时打开/.test(html.slice(segIdx - 500, segIdx)))

console.log('=== ④ JS 接线 ===')
ok('RAIL_MODES 四值齐全', /const RAIL_MODES = \["always", "open", "closed", "hidden"\]/.test(script))
ok('脏值回退 always（同 applyTheme 写法）', /if \(!RAIL_MODES\.includes\(mode\)\) mode = "always"/.test(script))
ok('写 body.dataset.rail（CSS 联动的唯一入口）', /document\.body\.dataset\.rail = mode/.test(script))
ok('反向：dataset.rail 只写一处（不允许别处再改显隐）', (script.match(/dataset\.rail/g) || []).length === 1)
ok('反向：没有任何 JS 直接写 qaRail 的 display（显隐判定全在 CSS）', !/qaRail\.style\.display/.test(script))
ok('点击写 localStorage yyagent-rail', /localStorage\.setItem\("yyagent-rail", b\.dataset\.v\)/.test(script))
ok('启动应用 + 缺省 always', /applyRailMode\(localStorage\.getItem\("yyagent-rail"\) \?\? "always"\)/.test(script))
ok('分段控件高亮跟随当前档', /b\.classList\.toggle\("active", b\.dataset\.v === mode\)/.test(script))
ok('位置在字体块之后（无 TDZ 风险：只依赖 $ 与 document）',
  script.indexOf('function applyRailMode') > script.indexOf('applyFont(localStorage.getItem'))

console.log('=== ⑤ 语法与配平 ===')
const t47js = script.slice(script.indexOf('// ---- T47 问答导轨显隐'), script.indexOf('applyRailMode(localStorage.getItem("yyagent-rail") ?? "always")') + 'applyRailMode(localStorage.getItem("yyagent-rail") ?? "always")'.length)
try { writeFileSync('scripts/.t47-tmp.mjs', t47js + '\n'); execFileSync('node', ['--check', 'scripts/.t47-tmp.mjs']); unlinkSync('scripts/.t47-tmp.mjs'); ok('T47 JS 块 node --check 通过', true) }
catch (e) { ok('T47 JS 块 node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平（坑 69 自检）', bo === bc, `${bo} vs ${bc}`)

console.log('=== ⑥ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('网关下发的首页含 data-rail 规则（静态文件现读，刷新即生效）',
    served.includes('body[data-rail="closed"]:not(.side-collapsed)') && served.includes('body[data-rail="open"]:has(#assistDrawer.open):not(.side-collapsed)'))
  ok('网关下发的首页含 #segRail 四档控件', served.includes('id="segRail"') && served.includes('data-v="closed"'))
} catch { console.log('SKIP 网关未运行，跳过活体检查') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
