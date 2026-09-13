// T51 校验：用户气泡右缘对齐输入框右缘（.msg 右锚定 + calc 补偿：不对称 padding / 滚动条 / 居中富余一次算平）
// 离线跑：公式断言 + 反向（旧居中写法不残留、--sbw 与 ::-webkit-scrollbar 同步）+ 语法配平 + 活体检查
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

console.log('=== ① 右锚定公式 ===')
const msgs = rule('#messages')
ok('#messages 定义 --msg-s（composer 居中富余的镜像：max(0, (100%+padL+padR+sbw-996)/2)）',
  /--msg-s:\s*max\(0px,\s*\(100% \+ var\(--padL\) \+ var\(--padR\) \+ var\(--sbw\) - 996px\) \/ 2\)/.test(msgs), msgs)
ok('#messages 定义 --msg-mr（28 基准 - padR - sbw + s）',
  /--msg-mr:\s*calc\(28px - var\(--padR\) - var\(--sbw\) \+ var\(--msg-s\)\)/.test(msgs))
const msg = rule('.msg')
ok('.msg 右锚定：margin-right = var(--msg-mr)', /margin-right:\s*var\(--msg-mr\)/.test(msg), msg)
ok('.msg 左侧 auto（可见态贴导轨让位量，宽窗与 composer 同宽同位）', /margin:\s*0 auto 14px/.test(msg), msg)
ok('.msg 列宽仍 940（与 #composer 一致）', /max-width:\s*940px/.test(msg))
ok('.turn-divider 同一右锚定（分隔线与列同缘）',
  /margin:\s*22px var\(--msg-mr\) 20px auto/.test(rule('.turn-divider')), rule('.turn-divider'))
// 反向：旧「纯居中」写法不得残留（它是对齐偏差的根源之一）
ok('反向：.msg 不再是纯居中写法（旧 margin: 0 auto 14px + 无 margin-right 已废）',
  !/^\.msg \{ margin: 0 auto 14px; max-width: 940px; \}$/m.test(cssNoCmt))

console.log('=== ② 滚动条补偿前提 ===')
ok('scrollbar-gutter: stable（滚动条占位恒定，公式在有无滚动条时都成立）',
  /scrollbar-gutter:\s*stable/.test(msgs), msgs)
const sbwVar = msgs.match(/--sbw:\s*(\d+)px/)?.[1]
const sbwCss = cssNoCmt.match(/::-webkit-scrollbar\s*\{[^}]*width:\s*(\d+)px/)?.[1]
ok('--sbw 与 ::-webkit-scrollbar width 数值一致（不同步则对齐差整数像素）',
  !!sbwVar && sbwVar === sbwCss, `--sbw=${sbwVar} scrollbar=${sbwCss}`)

console.log('=== ③ 几何组前提不回归 ===')
ok('--padL 状态化：基准 76 / assist-open 88 / 隐藏态 28',
  /--padL:\s*76px/.test(msgs) && /--padL:\s*88px/.test(rule('body.assist-open #messages')) && /--padL:\s*28px/.test(cssNoCmt))
ok('反向：用户气泡没有被单独硬补偿（对齐由列完成，双层补偿会叠加过头）',
  !/--msg-mr[^;]*\+[^;]*10px/.test(cssNoCmt) && !/\.msg\.user[^{]*\{[^}]*margin-right/.test(cssNoCmt))

console.log('=== ④ 语法与配平 ===')
try { writeFileSync('scripts/.t51-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t51-tmp.mjs']); unlinkSync('scripts/.t51-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== ⑤ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('网关下发的首页已含右锚定公式与 gutter',
    served.includes('--msg-mr: calc(28px - var(--padR) - var(--sbw)') && served.includes('scrollbar-gutter: stable'))
} catch { console.log('SKIP 网关未运行，跳过活体检查') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
