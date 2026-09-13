// T65 校验：搜索重做（居中命令面板 + 粗黑框 + 分类 chips 全部/操作/任务/文件）
// 网关 /api/search 分类参数（task/ops/file/all）+ 前端结构 + 委托渲染 + 反向断言 + 语法配平 + 活体
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const gateway = readFileSync('src/gateway.ts', 'utf8')
const cssNoCmt = css.replace(/\/\*[\s\S]*?\*\//g, '')
const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = cssNoCmt.match(new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

let pass = 0, fail = 0
const ok = (n, v, extra) => { if (v) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + (extra ? '  → ' + extra : '')) } }

console.log('=== ① 网关：/api/search 分类 ===')
ok('cat 参数读取（默认 all）', gateway.includes('const cat = (url.searchParams.get("cat") ?? "all").toLowerCase()'))
ok('task 分类：任务名/cron 命中，type:"task"',
  /cat === "task"/.test(gateway) && /t\.name\.toLowerCase\(\)\.includes\(q\) \|\| t\.cron\.toLowerCase\(\)\.includes\(q\)/.test(gateway) &&
  /type: "task"/.test(gateway))
ok('ops 分类：步骤 name+argsSummary 匹配', /\(cat === "ops" \|\| cat === "all"\) && msg\.steps\?\.length/.test(gateway))
ok('file 分类：fileEdits + 正文路径串（允许空格，反引号为界）',
  /const pathRe = \/\(\[A-Za-z\]:\[\\\\\/\]\[\^`"'，。；）\]\{4,\}\)\/g/.test(gateway), gateway.match(/const pathRe = .*/)?.[0])
ok('all 分类：标题/正文/步骤/文件全参与', /cat !== "ops" && cat !== "file" && meta\.title/.test(gateway))
ok('反向：旧版无 cat 参数的单参 fetch 形态已死（前端旧 URL 拼接不再存在）',
  !script.includes('fetch(`/api/search?q=${encodeURIComponent(q)}`)'))

console.log('=== ② 前端结构：居中面板 + 粗黑框 + chips ===')
const pop = rule('#searchPop')
ok('居中（left 50% + translateX(-50%)）而非贴侧栏', /left:\s*50%/.test(pop) && /translateX\(-50%\)/.test(pop), pop)
ok('不再贴左下（旧 left:12px/top:52px/bottom:12px 已死）', !/left:\s*12px/.test(pop) && !/bottom:\s*12px/.test(pop))
const field = rule('#searchField')
ok('输入框粗黑框（2px solid var(--text)）', /border:\s*2px solid var\(--text\)/.test(field), field)
ok('放大镜图标在输入框内（searchIco）', rule('#searchIco').length > 0 && html.includes('id="searchIco"'))
ok('四个分类 chips（all/ops/task/file）',
  ['all', 'ops', 'task', 'file'].every((c) => script.includes(`data-cat="${c}"`) || html.includes(`data-cat="${c}"`)))
ok('chips 为手绘 SVG 图标（四个 data-cat 按钮各含 svg）',
  [...html.matchAll(/class="scat[^"]*" data-cat="(\w+)"><svg/g)].length === 4)
ok('chips 激活态（.scat.active 边框 + panel2 底）',
  /border-color:\s*var\(--text\)/.test(rule('.scat.active')) && /background:\s*var\(--panel2\)/.test(rule('.scat.active')))
ok('placeholder = 搜索操作、任务或文件', html.includes('placeholder="搜索操作、任务或文件"'))

console.log('=== ③ JS：分类状态 + 任务命中渲染 ===')
ok('searchCat 状态 + chips 点击切换并重搜', /let searchCat = "all"/.test(script) &&
  /\$\("searchInput"\)\.dispatchEvent\(new Event\("input"\)\)/.test(script))
ok('fetch 带 cat 参数', /\/api\/search\?q=\$\{encodeURIComponent\(q\)\}&cat=\$\{searchCat\}/.test(script))
ok('任务命中：data-task + 点击进自动化页（showPage autoPage）',
  /data-task="1"/.test(script) && /el\.dataset\.task\) \{ closeSearch\(\); showPage\("autoPage"\); return \}/.test(script))
ok('会话命中仍走 openSession', /openSession\(el\.dataset\.id, Number\(el\.dataset\.idx\)\)/.test(script))

console.log('=== ④ 语法与配平 ===')
try { writeFileSync('scripts/.t65-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t65-tmp.mjs']); unlinkSync('scripts/.t65-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== ⑤ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('网关下发的首页已含新版搜索面板', served.includes('id="searchCats"') && served.includes('translateX(-50%)'))
} catch { console.log('SKIP 网关未运行，跳过活体检查') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
