// T68 校验：个人化设置服务端化（localStorage 降级为镜像，config.ui 为持久真相）+ 输入框改纯白
// 覆盖 config.ui 字段、gateway /api/ui GET/POST、前端 PREF_KEYS/setItem 镜像/启动对账(服务端优先+收编)/
// 重应用(主题仅在有存值时)、composer 白；反向：无 localStorage.clear、拉取失败不清空；语法配平；活体
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const gateway = readFileSync('src/gateway.ts', 'utf8')
const config = readFileSync('src/agent/config.ts', 'utf8')
const cssNoCmt = css.replace(/\/\*[\s\S]*?\*\//g, '')
const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = cssNoCmt.match(new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

let pass = 0, fail = 0
const ok = (n, v, extra) => { if (v) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + (extra ? '  → ' + extra : '')) } }

console.log('=== ① 服务端：config.ui + /api/ui ===')
ok('config 有 ui?: Record<string,string> 字段', /ui\?: Record<string, string>/.test(config))
ok('GET /api/ui 返回 config.ui', gateway.includes('if (m === "GET" && p === "/api/ui") return json(res, 200, { ui: loadConfig().ui ?? {} })'))
ok('POST /api/ui 浅合并写回 + saveConfig',
  /p === "\/api\/ui"/.test(gateway) && /const ui: Record<string, string> = \{ \.\.\.\(cfg\.ui \?\? \{\}\) \}/.test(gateway) && /cfg\.ui = ui/.test(gateway) && /saveConfig\(cfg\)/.test(gateway))

console.log('=== ② 前端桥接：镜像 + 对账 + 重应用 ===')
ok('PREF_KEYS 覆盖九项个人化（含 theme/font/rail/hotkeys/side/宽度/cwd/tasks）',
  /"yyagent-theme": "theme"/.test(script) && /"yyagent-font": "font"/.test(script) &&
  /"yyagent-rail": "rail"/.test(script) && /"yyagent-hotkeys": "hotkeys"/.test(script) &&
  /"yyagent-side": "side"/.test(script) && /"yyagent-w-side": "w-side"/.test(script) &&
  /"yyagent-w-assist": "w-assist"/.test(script) && /"yyagent-cwd-groups": "cwd-groups"/.test(script) &&
  /"yyagent-tasks-collapsed": "tasks-collapsed"/.test(script))
ok('setItem 包装：管理键写本地同时镜像入队上推',
  /localStorage\.setItem = function \(k, v\)/.test(script) && /__lsSet\(k, v\)/.test(script) && /if \(PREF_KEYS\[k\]\) \{ __uiBuf\[PREF_KEYS\[k\]\] = String\(v\); __uiSchedulePush\(\) \}/.test(script))
ok('启动对账：服务端优先覆盖本地 + 本地独有值收编上推',
  /if \(ui\[key\] != null\) \{ if \(ui\[key\] !== local\) __lsSet\(ls, ui\[key\]\) \}/.test(script) && /else if \(local != null\) pushUp\[key\] = local/.test(script))
ok('拉取失败 return，绝不清空本地（catch 后不 __uiReapply）',
  /catch \{ return \} \/\/ 拉不到就维持本地，绝不清空/.test(script))
ok('重应用：主题仅在存了值时才 applyTheme（不覆盖系统浅色默认）', /const th = localStorage\.getItem\("yyagent-theme"\); if \(th\) applyTheme\(th\)/.test(script))
ok('重应用覆盖 font/rail/side/宽度 + render', /applyFont\(localStorage\.getItem\("yyagent-font"\)/.test(script) &&
  /applyRailMode\(localStorage\.getItem\("yyagent-rail"\)/.test(script) && /classList\.toggle\("side-collapsed"/.test(script) && /\$\("sidebar"\)\.style\.width = ws \+ "px"/.test(script))
ok('反向：全程无 localStorage.clear', !/localStorage\.clear\(/.test(script))
ok('debounce 上推（600ms 合并连续写）', /setTimeout\(__uiFlush, 600\)/.test(script))

console.log('=== ③ 输入框纯白 ===')
ok('#composer 背景 = var(--panel)（纯白），非 panel2', /background:\s*var\(--panel\)/.test(rule('#composer')), rule('#composer'))

console.log('=== ④ 语法与配平 ===')
try { writeFileSync('scripts/.t68-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t68-tmp.mjs']); unlinkSync('scripts/.t68-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== ⑤ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('首页已含桥接（PREF_KEYS + setItem 包装）', served.includes('PREF_KEYS') && served.includes('__uiSchedulePush'))
  const r = await (await fetch('http://127.0.0.1:8642/api/ui', { signal: AbortSignal.timeout(4000) })).json()
  ok('GET /api/ui 返回对象', r && typeof r.ui === "object")
  setTimeout(() => process.exit(fail ? 1 : 0), 80)
} catch { console.log('SKIP 网关未运行，跳过活体检查'); setTimeout(() => process.exit(fail ? 1 : 0), 80) }
