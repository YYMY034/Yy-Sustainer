// T63 校验：思考过程折叠（<thinking> 源码标签不再裸露）——fmtBlock 折叠块（摘要=末行、点击展开全文）
// 流式与落库消息同款（流式走 fmtBlock(streamBuf) 自动同款）；展开状态按内容前缀哈希跨重绘记忆
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

console.log('=== ① fmtBlock：thinking 抽取与占位 ===')
// T63：用 includes 而非正则——本断言的正则自身要匹配"正则字面量源码"，转义自引用太脆
ok('闭合/未闭合/ think 变体都抽取（流式尾部未闭合也覆盖）',
  script.includes('s = s.replace(/<(thinking|think)>([\\s\\S]*?)(?:<\\/\\1>|$)/gi') &&
  script.includes('/gi, (m0, tag, inner) =>'))
ok('占位行标记 @@THINK<i>@@（thinkStore 闭包取回）',
  /return "\\n@@THINK" \+ \(thinkStore\.length - 1\) \+ "@@\\n"/.test(script))
ok('行循环处理占位行 → thinkBlockHtml', /const thinkM = line\.match\(\/\^\@\@THINK\(\\d\+\)\@\@\$\/\)/.test(script) &&
  /out\.push\(thinkBlockHtml\(thinkStore\[\+thinkM\[1\]\] \?\? ""\)\)/.test(script))
ok('反向：占位行不会被当普通文本漏出（占位匹配在围栏/表格处理之前）',
  script.indexOf('const thinkM = line.match') < script.indexOf('if (/^\\s*```/.test(line))'))

console.log('=== ② thinkBlockHtml：摘要=末行 + 点击展开 ===')
ok('摘要取思考末行（trim+filter 空行）并截断 120', /const last = \(ls\[ls\.length - 1\] \?\? "…"\)\.slice\(0, 120\)/.test(script))
ok('展开状态按内容前缀哈希（thinkHash 前 80 字符，流式增长稳定）',
  /for \(let i = 0; i < s\.length && i < 80; i\+\+\)/.test(script) && /window\.__thinkOpen \?\? \(window\.__thinkOpen = new Set\(\)\)\)\.has\(k\)/.test(script))
ok('think-full 常驻 DOM（esc 转义，CSS 控制显隐）', /<div class="think-full">\$\{esc\(inner\)\}<\/div>/.test(script))
ok('反向：inner 不以 HTML 注入（esc 包裹，防注入）', !/<div class="think-full">\$\{inner\}/.test(script))

console.log('=== ③ 委托：两处容器都可点击展开 ===')
ok('#messages 与 #assistMsgs 委托都有 think-head 处理',
  (script.match(/const thinkHead = t\.closest\("\.think-head"\)/g) || []).length === 2)
ok('点击切换 __thinkOpen + classList.open', /set\.has\(k\) \? set\.delete\(k\) : set\.add\(k\)/.test(script) &&
  /blk\.classList\.toggle\("open", set\.has\(k\)\)/.test(script))

console.log('=== ④ CSS ===')
ok('.think-block 折叠容器（圆角边框 panel2）',
  /border:\s*1px solid var\(--border\)/.test(rule('.think-block')) && /border-radius:\s*10px/.test(rule('.think-block')))
ok('摘要行单行省略（think-last ellipsis）', /text-overflow:\s*ellipsis/.test(rule('.think-last')))
ok('think-full 默认隐藏、open 显示 + 限高滚动',
  /display:\s*none/.test(rule('.think-full')) && /display:\s*block/.test(rule('.think-block.open .think-full')) && /max-height:\s*260px/.test(rule('.think-full')))
ok('chev 展开时旋转 90°', /transform:\s*rotate\(90deg\)/.test(rule('.think-block.open .think-head .chev')))
ok('反向：思考标签色用 accent 描边而非写死色值', /var\(--accent\)/.test(rule('.think-tag')))

console.log('=== ⑤ 语法与配平 ===')
try { writeFileSync('scripts/.t63-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t63-tmp.mjs']); unlinkSync('scripts/.t63-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== ⑥ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('网关下发的首页已含思考折叠', served.includes('@@THINK') && served.includes('thinkBlockHtml') && served.includes('.think-block'))
} catch { console.log('SKIP 网关未运行，跳过活体检查') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
