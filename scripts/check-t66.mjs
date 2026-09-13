// T66 校验：钩子系统（每步工具执行后用模型检查）+ 思考失败提示
// config 种子与类型 / hooks.ts fail-open / tools 包装 / gateway 路由与思考失败文案 / web 设置卡 / 语法配平 / 活体
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const gateway = readFileSync('src/gateway.ts', 'utf8')
const config = readFileSync('src/agent/config.ts', 'utf8')
const hooksTs = readFileSync('src/agent/hooks.ts', 'utf8')
const tools = readFileSync('src/agent/tools.ts', 'utf8')
const cssNoCmt = css.replace(/\/\*[\s\S]*?\*\//g, '')
const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = cssNoCmt.match(new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

let pass = 0, fail = 0
const ok = (n, v, extra) => { if (v) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + (extra ? '  → ' + extra : '')) } }

console.log('=== ① config.ts：类型与内置种子 ===')
ok('HookConfig 接口导出（id/name/builtin/enabled/prompt）',
  /export interface HookConfig \{[^}]*id: string[^}]*name: string[^}]*builtin\?: boolean[^}]*enabled: boolean[^}]*prompt: string/.test(config.replace(/\n/g, ' ')))
ok('YyagentConfig.hooks 字段', /hooks\?: HookConfig\[\]/.test(config))
ok('BUILTIN_HOOKS 种子（安全钩子默认开 / 输出格式默认关）',
  config.includes('id: "builtin-safety"') && config.includes('id: "builtin-format"') &&
  /builtin-safety[\s\S]{0,200}enabled: true/.test(config) && /builtin-format[\s\S]{0,200}enabled: false/.test(config))
ok('loadConfig 种子：缺失时补回内置钩子（幂等）',
  /const builtinIds = new Set\(\(cached\.hooks \?\? \[\]\)\.map\(\(h\) => h\.id\)\)/.test(config) &&
  /const missing = BUILTIN_HOOKS\.filter\(\(b\) => !builtinIds\.has\(b\.id\)\)/.test(config))
ok('BUILTIN_HOOKS 定义在 config（防循环导入：hooks.ts 从 config 导入）',
  config.indexOf('export const BUILTIN_HOOKS') < config.indexOf('loadConfig()') && hooksTs.includes('from "./config.js"') && !hooksTs.includes('BUILTIN_HOOKS: Array'))

console.log('=== ② hooks.ts：fail-open 检查器 ===')
ok('runHooksOnTool：只查启用的钩子', /filter\(\(h\) => h\.enabled\)/.test(hooksTs))
ok('超时上限（25s）+ 长输出截断（2000 字符）', /CHECK_TIMEOUT_MS = 25000/.test(hooksTs) && /SAMPLE_CHARS = 2000/.test(hooksTs))
// T73 更新：判定从「行首 ^FAIL」改为「先剥 thinking 块 + 按关键字找 FAIL」，容模型多嘴
ok('FAIL 解析（不通过才追加）', hooksTs.includes('thinking|think') && hooksTs.includes('FAIL[:：]?') && !hooksTs.includes('/^FAIL/i.test(txt)'))
ok('fail-open：模型解析失败/无模型/钩子超时都原样返回', (hooksTs.match(/return output/g) || []).length >= 3)
ok('FAIL 追加带「请立即修正后续行为」提示', /【钩子检查未通过】/.test(hooksTs) && /请立即修正后续行为/.test(hooksTs))
ok('使用 chatModel（与 loop.ts 同款取模方式）', /client\.chatModel\(modelId\)/.test(hooksTs))

console.log('=== ③ tools.ts：每步工具包装 ===')
ok('makeTools 末尾包装全部工具（execute 后跑钩子）',
  /if \(opts\.allowDelegate\) t\.delegate = delegateTool[\s\S]*?for \(const k of Object\.keys\(t\)\)/.test(tools) &&
  /const out = await orig\(input, options\)/.test(tools))
ok('包装调用 runHooksOnTool（工具名 + 输出）', /runHooksOnTool\(k, out as string\)/.test(tools))
ok('包装自身 try/catch fail-open', /return await runHooksOnTool\(k, out as string\)[\s\S]{0,40}catch \{[\s\S]{0,20}return out/.test(tools))

console.log('=== ④ gateway：/api/hooks 路由 + 思考失败文案 ===')
ok('GET /api/hooks 列表', gateway.includes('if (m === "GET" && p === "/api/hooks") return json(res, 200, { hooks: loadConfig().hooks ?? [] })'))
ok('toggle 开关持久化（saveConfig）', /p === "\/api\/hooks\/toggle"/.test(gateway) && /h\.enabled = !!body\.enabled/.test(gateway) && /saveConfig\(loadConfig\(\)\)/.test(gateway))
ok('create 校验非空 + 追加', /p === "\/api\/hooks\/create"/.test(gateway) && /名称与检查要求不能为空/.test(gateway))
ok('delete 反向：内置钩子不可删除', /内置钩子不可删除，可关闭/.test(gateway))
// T74 更新：不再拿 message 文案猜（`/No output generated/` 会漏掉真实原因，见坑 83），改判结构化 kind；
// 「思考失败」的可见反馈保留（挪到 !aborted 分支，且不再把真实错误误标成"已停止"）
ok('思考失败与用户停止分流（改用 describeFailure().kind，真实报错不再被误判为已停止）',
  gateway.includes('aborted = dinfo.kind === "abort"') && !gateway.includes('/No output generated/i.test(err.message'))
ok('思考失败且零步骤：落库可见提示（原来整条不落库）',
  gateway.includes('思考失败：模型没有返回任何内容。可点击重新生成，或换个说法重试。') && gateway.includes('const silent = dinfo.kind === "unknown"'))
ok('通知条只说「已停止」（思考失败改走 [出错] 落库路径，带真实原因）',
  gateway.includes('broadcast({ type: "notice", sessionId, text: "已停止" })') && gateway.includes('`[出错] ${err.message}`'))

console.log('=== ⑤ web：设置页钩子卡 ===')
ok('设置导航含钩子类别', html.includes('data-sec="secHooks"'))
ok('钩子卡存在（工作方式说明 + 列表 + 新建表单）',
  html.includes('id="secHooks"') && html.includes('id="hookList"') && html.includes('id="hookCreate"') && html.includes('会增加每步耗时与 token 消耗'))
ok('renderHooks 渲染开关 + 内置标签 + 删除按钮',
  /async function renderHooks\(\)/.test(script) && /data-h="\$\{h\.id\}"/.test(script) && /hook-tag/.test(script) && /data-del="\$\{h\.id\}"/.test(script))
ok('打开设置页即拉取钩子状态', /\$\("settingsBtn"\)\.onclick = \(\) => \{\s*\n\s*showPage\("setPage"\)\s*\n\s*renderStatCard\(\)[\s\S]{0,120}renderHooks\(\)/.test(script.replace(/\r/g, '')))
ok('反向：内置钩子前端无删除按钮（builtin 不渲染 data-del）',
  !/h\.builtin \? "" : `<button data-del/.test("") && /h\.builtin \? "" : `<button data-del="\$\{h\.id\}" class="hdel">删除<\/button>`/.test(script))
ok('新增 CSS（hook-tag / hook-form / hdel）',
  rule('.hook-tag').length > 0 && rule('.hook-form').length > 0 && /color:\s*var\(--err\)/.test(rule('.hseg button.hdel')))

console.log('=== ⑥ 语法与配平 ===')
try { writeFileSync('scripts/.t66-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t66-tmp.mjs']); unlinkSync('scripts/.t66-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== ⑦ 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('网关下发的首页已含钩子设置卡', served.includes('id="secHooks"') && served.includes('renderHooks'))
  const api = await (await fetch('http://127.0.0.1:8642/api/hooks', { signal: AbortSignal.timeout(4000) })).json()
  ok('GET /api/hooks 返回内置钩子（种子已生效）',
    Array.isArray(api.hooks) && api.hooks.some((h) => h.id === 'builtin-safety') && api.hooks.some((h) => h.id === 'builtin-format'))
} catch { console.log('SKIP 网关未运行，跳过活体检查') }

console.log(`\n${pass} passed, ${fail} failed`)
setTimeout(() => process.exit(fail ? 1 : 0), 60)
