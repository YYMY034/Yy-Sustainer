// T83–T85 联合校验：自动备份 / 项目命令白名单 / 长任务模式与完成通知
// 离线静态断言（config/permissions/backup/loop/gateway/web）+ 语法配平 + 活体（/api/backup /api/longtask /api/notify）
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const gateway = readFileSync('src/gateway.ts', 'utf8')
const config = readFileSync('src/agent/config.ts', 'utf8')
const permissions = readFileSync('src/agent/permissions.ts', 'utf8')
const backupTs = readFileSync('src/agent/backup.ts', 'utf8')
const loop = readFileSync('src/agent/loop.ts', 'utf8')
const cssNoCmt = css.replace(/\/\*[\s\S]*?\*\//g, '')
const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = cssNoCmt.match(new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

let pass = 0, fail = 0
const ok = (n, v, extra) => { if (v) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + (extra ? '  → ' + extra : '')) } }

console.log('=== T83 自动备份 ===')
ok('config.backup 字段（enabled/keep/intervalHours）', /backup\?: \{ enabled\?: boolean; keep\?: number; intervalHours\?: number \}/.test(config))
ok('backup.ts：tar -a 打包 + 滚动保留', backupTs.includes('"-a", "-c", "-f"') && backupTs.includes('unlinkSync(join(BACKUP_DIR, old.file))'))
ok('备份条目含 sessions/config/usage 等核心资产', backupTs.includes('"sessions"') && backupTs.includes('"config.json"') && backupTs.includes('"usage.jsonl"'))
ok('网关路由：GET 列表+notify / POST run / POST config', gateway.includes('p === "/api/backup"') && gateway.includes('p === "/api/backup/run"') && gateway.includes('p === "/api/backup/config"'))
ok('启动挂载 startBackupSchedule', gateway.includes('startBackupSchedule()'))
ok('web：设置卡存在（segBackup/bkRun/notifyUrl/bkList）', html.includes('id="segBackup"') && html.includes('id="bkRun"') && html.includes('id="notifyUrl"') && html.includes('id="bkList"'))

console.log('=== T84 项目命令白名单 ===')
ok('config.allowlists 字段（key=归一化 cwd）', /allowlists\?: Record<string, string\[\]>/.test(config))
// T90 收口：原来的「首 token 前缀」等于给该命令永久免确认——白名单里写 `node`，
// 连 `node -e "任意代码"` 都免确认。现在单 token 前缀只对非解释器类生效。
ok(
  'commandAllowed：整串相等 / 前缀+空格 / 单 token 前缀仅限非解释器类（T90）',
  /export function commandAllowed/.test(permissions) &&
    /cmd === lp/.test(permissions) &&
    /cmd\.startsWith\(lp \+ " "\)/.test(permissions) &&
    /INTERPRETER_LIKE\.has\(lp\)/.test(permissions),
)
ok('gate：白名单命中免确认（优先于 danger 判定）',
  /if \(tool === "bash" && command && commandAllowed\(command, cwd\)\) return null/.test(permissions) &&
  permissions.indexOf('commandAllowed(command, cwd)') < permissions.indexOf('danger-confirm" && !danger'))
ok('确认框附「本项目总是允许」选项并落盘', /本项目总是允许 \$\{first\}/.test(permissions) && /saveConfig\(cfg\)/.test(permissions))
ok('bash 工具传 command + cwd 进 gate', /command,\s*\n\s*cwd: toolCtx\.getStore\(\)\?\.cwd/.test(readFileSync('src/agent/tools.ts', 'utf8')))
ok('网关路由：allowlist add/remove（小写归一）', gateway.includes('p === "/api/allowlist/add"') && gateway.includes('p === "/api/allowlist/remove"'))
ok('web：白名单卡与增删', html.includes('id="alList"') && html.includes('id="alAdd"') && script.includes('/api/allowlist/remove'))

console.log('=== T85 长任务模式与完成通知 ===')
ok('AgentOptions.convergeTimeoutMs + Prepared 透传', /convergeTimeoutMs\?: number/.test(loop) && /convergeTimeoutMs: number/.test(loop))
ok('长任务会话 → 收敛阈值 30 分钟（T93：开关改读会话 meta，持久化）', /convergeTimeoutMs: meta\.longTask \? 30 \* 60_000 : undefined/.test(gateway))
ok('收敛文案分钟数与阈值联动', /convergePrompt\(Math\.max\(1, Math\.round\(prep\.convergeTimeoutMs \/ 60_000\)\)\)/.test(loop))
ok('完成通知：≥30s 或长任务回合才提醒；出错也提醒',
  // T93 P2：超时不算「任务完成」，不该发完成通知（多一个 !timedOut 前置条件）
  /if \(!timedOut && \(durTurn >= 30_000 \|\| meta\.longTask\)\)/.test(gateway) && /notifyDone\("Yy Sustainer · 任务出错"/.test(gateway))
ok('定时任务完成走 notifyDone（toast + webhook）', /notifyDone\(`Yy Sustainer · \$\{t\.name\}`/.test(gateway))
ok('notify 配置字段与路由', /notify\?: \{ toast\?: boolean; url\?: string;[\s\S]{0,200}?onlyFailure\?: boolean \}/.test(config) && gateway.includes('p === "/api/notify"'))
ok('web：composerBar 长任务按钮 + 换会话同步', html.includes('id="longTaskBtn"') && /syncLongTask\(\) \/\/ T85/.test(script))

console.log('=== 语法与配平 ===')
try { writeFileSync('scripts/.t83-tmp.mjs', script + '\n'); execFileSync('node', ['--check', 'scripts/.t83-tmp.mjs']); unlinkSync('scripts/.t83-tmp.mjs'); ok('整段 <script> node --check 通过', true) }
catch (e) { ok('整段 <script> node --check 通过', false, String(e).slice(0, 200)) }
const bo = (cssNoCmt.match(/\{/g) || []).length, bc = (cssNoCmt.match(/\}/g) || []).length
ok('style 块去注释后括号配平', bo === bc, `${bo} vs ${bc}`)

console.log('=== 活体检查（网关在跑时） ===')
try {
  const served = await (await fetch('http://127.0.0.1:8642/', { signal: AbortSignal.timeout(4000) })).text()
  ok('首页已含长任务按钮与备份卡', served.includes('id="longTaskBtn"') && served.includes('id="secData"'))
  const bk = await (await fetch('http://127.0.0.1:8642/api/backup', { signal: AbortSignal.timeout(4000) })).json()
  ok('GET /api/backup 返回配置/通知/列表', bk && typeof bk.config === "object" && typeof bk.notify === "object" && Array.isArray(bk.backups))
  const lt = await (await fetch('http://127.0.0.1:8642/api/longtask?sid=x', { signal: AbortSignal.timeout(4000) })).json()
  ok('GET /api/longtask 返回开关状态', typeof lt?.on === "boolean")
  setTimeout(() => process.exit(fail ? 1 : 0), 80)
} catch { console.log('SKIP 网关未运行，跳过活体检查'); setTimeout(() => process.exit(fail ? 1 : 0), 80) }
