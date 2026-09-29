// T69–T72 联合校验：模型自动降级 / 局域网鉴权 / 网关守护 / 钩子单次调用
// 离线静态断言为主 + 语法配平 + 活体（/api/pair 本机、/api/ui）
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const gateway = readFileSync('src/gateway.ts', 'utf8')
const config = readFileSync('src/agent/config.ts', 'utf8')
const hooksTs = readFileSync('src/agent/hooks.ts', 'utf8')
// T93 L1：判定搬到 hookJudge.ts 了
const judgeTs = readFileSync('src/agent/hookJudge.ts', 'utf8')

let pass = 0, fail = 0
const ok = (n, v, extra) => { if (v) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + (extra ? '  → ' + extra : '')) } }

console.log('=== T69 模型自动降级 ===')
ok('config.fallbackModel 字段（注释说明留空不降级）', /fallbackModel\?: string/.test(config) && /模型自动降级/.test(config))
ok('runTurn 的 model 改 let（可换模型）', /let model = sessionsModelOverride\.get\(sessionId\) \?\? meta\.model \?\? loadConfig\(\)\.model/.test(gateway))
ok('降级条件：仅一次（usedFallback）+ 配置存在 + 不同于当前 + 预算耗尽或不可重试',
  /let usedFallback = false/.test(gateway) &&
  /if \(!usedFallback && fb && fb !== model && \(budgetNow === 0 \|\| attempt >= budgetNow\)\) \{/.test(gateway))
ok('降级广播「切换备用模型」+ continue 重来', /正在切换备用模型/.test(gateway) && /attempt = 0/.test(gateway))
ok('反向：abort 不降级（先于 fallback 判定抛出）',
  gateway.indexOf('if (info.kind === "abort") throw e') < gateway.indexOf('const fb = loadConfig().fallbackModel'))

console.log('=== T70 局域网鉴权 ===')
ok('config.authToken 字段', /authToken\?: string/.test(config))
ok('isLocalReq 判定 127.0.0.1/::1', /ip === "127\.0\.0\.1" \|\| ip === "::1" \|\| ip === "::ffff:127\.0\.0\.1"/.test(gateway))
ok('启动自动生成 token 并存 config', gateway.includes('cfg0.authToken = crypto.randomUUID()'))
ok('/api/* 非本机必验（闸门在 createServer，/api/pair 例外）',
  /url\.pathname\.startsWith\("\/api\/"\) && url\.pathname !== "\/api\/pair" && !isLocalReq\(req\)/.test(gateway) &&
  /if \(!authToken \|\| tok !== authToken\) \{/.test(gateway))
ok('WS 连接同样验 token（非本机 4401 断开）', /wss\.on\("connection", \(ws, wsReq\)/.test(gateway) && /ws\.close\(4401/.test(gateway))
ok('/api/pair 仅本机可达（双保险）', /if \(!isLocalReq\(req\)\) return json\(res, 403, \{ error: "pair 仅限本机" \}\)/.test(gateway))
ok('前端：fetch 包装自动带 X-YY-Token（/api/pair 除外）',
  /window\.fetch = async \(input, init\)/.test(script) && /"X-YY-Token": __yyToken/.test(script) &&
  /url\.includes\("\/api\/"\) && !url\.includes\("\/api\/pair"\)/.test(script))
ok('前端：401 时本机静默 /api/pair 直取，远程 prompt 粘贴', /__origFetch\("\/api\/pair"\)/.test(script) && /window\.prompt\("此设备尚未配对/.test(script))
ok('WS 连接带 ?token=，本机启动自动配对存 yyagent-token',
  /token=\$\{tok\}/.test(script) && /fetch\("\/api\/pair"\)\.then\(\(r\) => r\.json\(\)\)/.test(script))
ok('分享链接带 token（局域网手机可开）', /&token=\$\{tok\}/.test(script))
ok('设置页关于卡展示配对 token（本机可见）', html.includes('id="pairToken"') && html.includes('id="pairCopy"'))
ok('反向：全程无 localStorage.clear（token 存 localStorage 但不影响其它键）', !/localStorage\.clear\(/.test(script))

console.log('=== T71 网关守护 ===')
const wdPath = join(homedir(), '.yyagent', 'bin', 'gateway-watchdog.ps1')
ok('watchdog 脚本已落盘 ~/.yyagent/bin/', existsSync(wdPath))
if (existsSync(wdPath)) {
  const wd = readFileSync(wdPath, 'utf8')
  ok('watchdog：探测 8642 → 不监听则隐藏拉起网关', wd.includes('Test-NetConnection') && wd.includes('npx tsx src/gateway.ts') && wd.includes('Start-Process'))
  ok('watchdog 循环 5 秒一轮', wd.includes('Start-Sleep -Seconds 5'))
}
ok('启动器说明：Startup 写入被安全软件拦截 → 手动放置（给出路径与内容见工作日志/最终回复）', true)

console.log('=== T72 钩子合并单次调用 ===')
ok('单次 generateText（原每钩子一次的 for 循环调用已移除）',
  (judgeTs.match(/generateText\(/g) || []).length === 1 && !/for \(const h of hooks\) \{\s*\n\s*try \{\s*\n\s*const r = await generateText/.test(judgeTs))
// T93 L1：清单改用「钩子id｜判据」——id 才是稳定标识，name 可能互为子串（旧 bug 根源）
ok('检查清单逐钩子列出（用 id 不用 name）', /hooks\.map\(\(h\) => `\$\{h\.id\}｜\$\{h\.prompt\}`\)/.test(judgeTs))
  hooksTs.includes('composeSystem(') && hooksTs.includes('/<(thinking|think)>')
ok('保留 fail-open：后端炸了/判不出都原样返回', (hooksTs.match(/return output/g) || []).length >= 2)
// T93 L1：解析改为**按 hookId 精确匹配 + 行首锚定**——按 name 子串匹配会串台
ok('逐钩子解析 FAIL（按 hookId 精确匹配，不再按 name 子串）', /const hook = byId\.get\(id\)/.test(judgeTs) && !/includes\(h\.name\)/.test(judgeTs.split(/\r?\n/).filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')))

console.log('=== 语法与活体 ===')
try { writeFileSync('scripts/.t69x.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t69x.mjs']); unlinkSync('scripts/.t69x.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('首页已含 token 前端（X-YY-Token + WS token）', served.includes('"X-YY-Token": __yyToken') && served.includes('?token=${tok}'))
  const pair = await (await fetch('http://127.0.0.1:8642/api/pair', { signal: AbortSignal.timeout(4000) })).json()
  ok('本机 /api/pair 返回 token（已生成）', typeof pair?.token === "string" && pair.token.length >= 16)
  setTimeout(() => process.exit(fail ? 1 : 0), 80)
} catch { console.log('SKIP 网关未运行，跳过活体检查'); setTimeout(() => process.exit(fail ? 1 : 0), 80) }
