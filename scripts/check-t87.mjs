// T87–T89 联合校验：shimmer 思考动效 / Docker 沙箱执行 / 超长输出卸载
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const gateway = readFileSync('src/gateway.ts', 'utf8')
const config = readFileSync('src/agent/config.ts', 'utf8')
const tools = readFileSync('src/agent/tools.ts', 'utf8')
const sandboxTs = readFileSync('src/agent/sandbox.ts', 'utf8')
const cssNoCmt = css.replace(/\/\*[\s\S]*?\*\//g, '')
const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = cssNoCmt.match(new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

let pass = 0, fail = 0
const ok = (n, v, extra) => { if (v) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + (extra ? '  → ' + extra : '')) } }

console.log('=== T87 shimmer 思考动效 ===')
ok('shimmer CSS（渐变 clip text + 扫光动画）',
  /background-clip:\s*text/.test(rule('.shimmer-text')) && /@keyframes shimmerSweep/.test(cssNoCmt))
ok('旧三点 thinkspin 样式已移除', !cssNoCmt.includes('.thinkspin i'))
// T90 修正：模型行不再另挂「思考中」——只保留状态行一处（用户指定只留下面那个）
ok('反向：who 行不再有 thinkSpin span（思考中只显示在状态行一处）',
  !html.includes('id="thinkSpin"') && !html.includes('think-shimmer'))
ok('stream-status 无圆形 spinner（.stream-status .spinner 已删）', !/\.stream-status \.spinner/.test(cssNoCmt))
ok('流式状态文字 shimmer', /<span id="streamStatusText" class="shimmer-text">/.test(html))
ok('JS remove 点仍可用（thinkSpin id 不变）', (script.match(/\$\("thinkSpin"\)\?\.remove\(\)/g) || []).length >= 2)

console.log('=== T88 Docker 沙箱 ===')
ok('config.sandbox 字段（enabled/image）', /sandbox\?: \{ enabled\?: boolean; image\?: string \}/.test(config))
ok('sandbox.ts：docker 探测（10 分钟缓存）', /dockerCache/.test(sandboxTs) && /600_000/.test(sandboxTs))
ok('容器执行：工作区挂载 /workspace + 工作目录', sandboxTs.includes('"/workspace"') && sandboxTs.includes('"-w"'))
ok('bash 工具：sandbox 参数 + 会话沙箱模式 + 回退本机说明',
  /sandbox === true \|\| sandboxCfg\?\.enabled === true/.test(tools) &&
  tools.includes('未检测到 Docker，已在本机 PowerShell 执行') && tools.includes('已回退本机执行'))
ok('权限门仍在宿主侧先跑（沙箱不绕过 gate）',
  tools.indexOf('await gate({') < tools.indexOf('dockerAvailable()'))
ok('后台任务不进沙箱', /&& !background\) \{/.test(tools))
ok('网关路由：GET /api/sandbox + POST /api/sandbox/config', gateway.includes('p === "/api/sandbox"') && gateway.includes('p === "/api/sandbox/config"'))
ok('web：沙箱设置区（segSandbox/sbImage/sbDocker）', html.includes('id="segSandbox"') && html.includes('id="sbImage"') && html.includes('id="sbDocker"'))

console.log('=== T89 输出卸载 ===')
ok('包装层 OFFLOAD_EXCLUDE/CHARS（read/bg_read 排除，阈值 3000）',
  tools.includes('OFFLOAD_EXCLUDE = new Set(["read", "bg_read"])') && tools.includes('OFFLOAD_CHARS = 3000'))
ok('卸载落盘 .agent-outputs + 句柄提示（用 read 读取）', tools.includes('.agent-outputs') && tools.includes('需要时用 read 工具读取'))
ok('fail-open：卸载失败原样返回', /} catch \{ \/\* 卸载失败原样返回 \*\/ \}/.test(tools))

console.log('=== 语法与活体 ===')
try { writeFileSync('scripts/.t87-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t87-tmp.mjs']); unlinkSync('scripts/.t87-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
try {
  const sb = await (await fetch('http://127.0.0.1:8642/api/sandbox', { signal: AbortSignal.timeout(8000) })).json()
  ok('GET /api/sandbox 返回 docker 探测与配置', typeof sb?.docker === "boolean" && typeof sb?.config?.image === "string")
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('首页已含 shimmer 与沙箱设置区', served.includes('shimmer-text') && served.includes('id="segSandbox"'))
  setTimeout(() => process.exit(fail ? 1 : 0), 80)
} catch { console.log('SKIP 网关未运行，跳过活体检查'); setTimeout(() => process.exit(fail ? 1 : 0), 80) }
