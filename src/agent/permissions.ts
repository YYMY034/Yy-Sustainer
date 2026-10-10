import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { QuestionBroker } from "./ask.js"
import { loadConfig, saveConfig } from "./config.js"

/**
 * 权限三档总开关（用户可配）：
 * - confirm-all:    全部更改前确认（写文件/编辑/bash 都要先问）
 * - danger-confirm: 只对危险操作（sudo/rm -rf/提权/密钥类）确认，其余放行
 * - full-auto:      完全允许，不做任何确认
 *
 * 交互模式（有 broker）：确认 = ask 用户，拒绝则工具返回拒绝说明。
 * 无人值守（无 broker）：危险操作一律拒绝（绝不挂起），其余放行。
 * T84 项目级白名单：bash 命令命中当前 cwd 的 allowlist 前缀 → 跳过确认（confirm-all/danger-confirm 都生效）。
 *      **T141 修正：白名单只在命令「不危险」时才免确认**——危险判定永远优先，且含 `&&`/`;`/`|`
 *      的命令链不享受前缀匹配（详见 DANGER_PATTERNS 与 commandAllowed 的注释）。
 * T90 会话级授权：MCP 写操作 / 桌面操控这类「逐次问太烦、不问又太危险」的动作，
 *      同一会话内只问一次（grantScope），用户批准后本会话免问；换档位或删会话即失效。
 */
export type PermissionMode = "confirm-all" | "danger-confirm" | "full-auto"

/**
 * 危险命令模式表——**大小写不敏感**，**PowerShell 优先**。
 *
 * 为什么这么写：运行环境是 Windows Terminal + PowerShell（沙箱模式才走 Linux bash），
 * 而历史版本整张表只认 POSIX 语法（`rm -rf`），导致 `Remove-Item -Recurse -Force`、
 * `del /s /q`、`diskpart` 这类本机真正不可逆的操作全部免确认通过；且正则没带 i 标志，
 * `rm -Rf` 这种常见大写写法直接漏网。
 *
 * 判据：不可逆（递归删除/磁盘/关机）、提权、越权碰凭据、下载即执行。
 * 宁可多问一句，不可静默执行。
 */
const DANGER_PATTERNS: RegExp[] = [
  // ---- 提权与权限改写 ----
  /(^|\s)sudo\b/i,
  /(^|\s)runas\b/i,
  /(^|\s)(takeown|icacls)\b/i,
  /(^|\s)chown\b/i,
  /(^|\s)chmod\s+(-[a-z]+\s+)*777/i,
  /(^|\s)set-executionpolicy\b/i,
  // ---- 递归 / 强制删除 ----
  // rm：要求「递归标志 + 强制标志」同时出现（-rf / -Rf / -fr / -r -f / --recursive --force 全覆盖）
  /(^|\s)rm\s+(?=[^|;&]*(-[a-z]*r|--recursive))(?=[^|;&]*(-[a-z]*f|--force))/i,
  // PowerShell 等价物：Remove-Item/ri/del/erase/rd/rmdir 带 -Recurse 或 /s
  /(^|\s)(remove-item|ri|del|erase|rd|rmdir)\b[^|;&]*(\s-recurse\b|\/s\b)/i,
  /(^|\s)(remove-item|ri|del|erase)\b[^|;&]*\s-force\b/i,
  // ---- 磁盘 / 系统级不可逆操作 ----
  /(^|\s)(diskpart|bcdedit|vssadmin|wbadmin|clear-disk|initialize-disk)\b/i,
  /(^|\s)format\s+[a-z]:/i,
  /(^|\s)(shutdown|stop-computer|restart-computer)\b/i,
  /(^|\s)net\s+(user|localgroup)\b/i,
  /(^|\s)reg\s+(delete|add|import|restore)\b/i,
  /(^|\s)schtasks\s+\/create\b/i,
  // ---- 任意代码执行 / 下载即执行 ----
  /(^|\s)(invoke-expression|iex)\b/i,
  /(^|\s)(invoke-webrequest|iwr|curl|wget)\b[^|;&]*\|\s*(iex|invoke-expression|sh|bash|zsh|powershell|pwsh|cmd|node|python)\b/i,
  /(^|\s)(certutil|bitsadmin)\b[^|;&]*-(urlcache|transfer)/i,
  // ---- 解释器内联代码（T141：黑名单的真实边界，必须按「调用形态」判）----
  // 为什么补这一组：危险表是**语法层黑名单**，它看得见命令名、看不见参数里的内容。
  // 而 `node -e "<任意代码>"` / `python -c "<任意代码>"` 把整个载荷藏在一个字符串里——
  // 正则表对内容是盲的，于是「node -e "fs.rmSync('C:/',{recursive:true,force:true})"」
  // 被判为「非危险」，在 danger-confirm 档**连问都不问直接执行**（实测复现）。
  // 追内容是不可能的（编码、变量拼接、管道无穷无尽），所以只追**形态**：
  // 只要出现「解释器 + 内联求值开关」，一律按危险处理——内联代码天然是不可审查的。
  // 副作用：`node -e` / `python -c` 这类命令从此每次都要确认。这是有意的：
  // 想跑脚本请写文件（`node ./x.mjs`），那至少留下可复查的产物。
  /(^|\s)(node|nodejs|deno|bun)\s+(--eval|-e)\b/i,
  /(^|\s)(python|python3|py|perl|ruby|php)\s+(-c|-e|-r)\b/i,
  /(^|\s)(powershell|pwsh)\s+(-\w*c\b|-command\b)/i,
  /(^|\s)(bash|sh|zsh)\s+-c\b/i,
  /(^|\s)cmd(\.exe)?\s+\/c\b/i,
  // ---- 凭据赋值（密钥覆盖 / 外泄）----
  // 踩坑：原写法 `\b[A-Z_]*TOKEN\s*=` 有**两个**毛病，且相邻两行只中了一个：
  //  ① 漏 `/i` → `token=` / `Token=` 全部漏网（同组另两行都带 i，这行是手误）；
  //  ② `\b[A-Z_]*` 里的 `_` 本身就是词字符 → `github_token=` 里 `_` 与 `t` 之间**不存在词边界**，
  //     所以只要变量名带前缀就永远匹配不到。改法：开头不写 `\b`，改成「任意词字符 + 关键字」。
  /[A-Za-z0-9_]*API_KEY\s*=/i,
  /[A-Za-z0-9_]*TOKEN\s*=/i,
  /[A-Za-z0-9_]*(SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*\s*=/i,
]

export function isDangerCommand(command: string): boolean {
  return DANGER_PATTERNS.some((re) => re.test(command))
}

export interface GateParams {
  tool: string
  summary: string
  danger: boolean
  mode: PermissionMode
  broker?: QuestionBroker
  /** T84：bash 传入完整命令与工作区 cwd，用于项目级白名单匹配 */
  command?: string
  cwd?: string
  /** T90：会话 id（会话级授权的归属） */
  sessionId?: string
  /** T90：授权范围（如 "computer"、"mcp:tabbit"、"fs:C:/other"）——同一会话同范围只问一次 */
  grantScope?: string
}

/** 归一化 cwd 做 allowlist 键（正斜杠、去尾斜杠、小写——与写入端约定一致） */
export function normalizeCwdKey(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase()
}

/**
 * 取该 cwd 在 allowlists 里的实际键：优先复用历史键（大写盘符等旧写法），
 * 没有才用归一化新键。读写都走它，既让旧数据继续生效，又不会写出重复键。
 */
export function allowlistKeyFor(cwd: string): string {
  const key = normalizeCwdKey(cwd)
  const lists = loadConfig().allowlists ?? {}
  return Object.keys(lists).find((k) => normalizeCwdKey(k) === key) ?? key
}

/**
 * T90：解释器类命令（能拿任意字符串当代码跑）不做前缀白名单。
 * 白名单里写了 `node` 就等于 `node -e "<任意代码>"` 永久免确认——那不是授权，是后门。
 * 想放行 `npm run build` 就写全 `npm run build`，别再写裸解释器名。
 */
const INTERPRETER_LIKE = new Set([
  "node", "nodejs", "deno", "bun", "python", "python3", "py", "ruby", "perl", "php",
  "powershell", "pwsh", "cmd", "bash", "sh", "zsh", "npx", "npm", "pnpm", "yarn", "wsl",
])

/**
 * T141：Shell 连接符。命令里一旦出现它们，白名单的**前缀**匹配就不能算数。
 *
 * 历史 bug（实测复现）：白名单里有 `npm run build`，于是
 * `npm run build && rm -rf C:/重要数据` 命中前缀 → 免确认放行。
 * 白名单授权的是「这条命令」，不是「以这条命令开头的任意命令链」——
 * 前缀匹配遇上 `&&` / `;` / `|` 就等于给尾巴开了后门。
 * 修法：含连接符的命令只认**整串相等**，不再享受前缀匹配。
 */
const SHELL_CONNECTORS = /[;&|\n]/

/** 命令是否命中白名单：整串相等、以「前缀+空格」开头，或（非解释器类）首 token 相等 */
export function commandAllowed(command: string, cwd: string | undefined): boolean {
  if (!cwd) return false
  const lists = loadConfig().allowlists ?? {}
  const prefixes = lists[allowlistKeyFor(cwd)] ?? []
  const cmd = command.trim().toLowerCase()
  if (!cmd) return false
  // T141：含连接符 → 只能整串相等才算命中（前缀/首 token 匹配一律作废）
  const chained = SHELL_CONNECTORS.test(cmd)
  const head = cmd.split(/\s+/)[0] ?? ""
  return prefixes.some((p) => {
    const lp = p.trim().toLowerCase()
    if (!lp) return false
    if (cmd === lp) return true
    if (chained) return false
    if (cmd.startsWith(lp + " ")) return true
    // 单 token 前缀：只有非解释器类才允许「首 token 相等即放行」
    return head === lp && !lp.includes(" ") && !INTERPRETER_LIKE.has(lp)
  })
}

// ---- T90 会话级授权（只问一次）----
// 为什么需要：桌面操控 / MCP 写操作逐次确认会把正常使用变成折磨，完全不问又等于没门。
// 折中：同一会话内对同一范围只问一次；用户点「允许」即视为本会话的持续授权。
const sessionGrants = new Set<string>()

function grantKey(sessionId: string | undefined, scope: string | undefined): string | null {
  return sessionId && scope ? `${sessionId}::${scope}` : null
}

export function hasSessionGrant(sessionId: string | undefined, scope: string | undefined): boolean {
  const k = grantKey(sessionId, scope)
  return !!k && sessionGrants.has(k)
}

/** 清授权：带 scope 只清该范围，不带则清该会话全部（换权限档位 / 删会话时调用） */
export function clearSessionGrants(sessionId: string, scope?: string): void {
  if (scope) {
    sessionGrants.delete(`${sessionId}::${scope}`)
    return
  }
  const prefix = `${sessionId}::`
  for (const k of [...sessionGrants]) if (k.startsWith(prefix)) sessionGrants.delete(k)
}

export async function gate({
  tool,
  summary,
  danger,
  mode,
  broker,
  command,
  cwd,
  sessionId,
  grantScope,
}: GateParams): Promise<string | null> {
  if (mode === "full-auto") return null
  // T141：**危险判定优先于白名单**（顺序曾经反着，是 T90 留下的真 bug）。
  // 原顺序是「白名单命中 → 直接放行」，而白名单短路排在危险判定之前，
  // 于是 `npm run build && rm -rf C:/数据` 这种命令：危险表**明明命中了** `rm -rf`，
  // 却因为前缀命中白名单而被短路放行——**判了也白判**（实测复现）。
  // 白名单是「免打扰」授权，不是「免危险」授权：用户说「这条命令别再问我」，
  // 不等于说「以它开头的危险命令链也别问」。
  if (tool === "bash" && command && !danger && commandAllowed(command, cwd)) return null
  // T90：本会话此前已授权过该范围 → 免确认
  const gk = grantKey(sessionId, grantScope)
  if (gk && sessionGrants.has(gk)) return null
  if (mode === "danger-confirm" && !danger) return null
  // 到这里：需要确认
  if (!broker) {
    return danger ? `[权限拒绝] ${tool} 属危险操作，无人值守模式下被拒绝：${summary}` : null
  }
  // T84：确认框附「本项目总是允许 X」选项——选中即把首 token 前缀写入当前 cwd 的白名单
  const first = command?.trim().split(/\s+/)[0]
  const alwaysOpt = tool === "bash" && first ? `本项目总是允许 ${first}` : null
  const options = alwaysOpt ? ["允许（y）", alwaysOpt, "拒绝"] : ["允许（y）", "拒绝"]
  const answer = await broker.ask({
    question: `允许执行 ${tool}？\n${summary}`,
    options,
    // T90：默认项是「拒绝」——长任务里习惯性回车不能等于开门；
    // 同时 QuestionBroker.cancel()（用户按停止/撤回）也按默认项应答，停在半路不会变成默认放行。
    defaultOption: "拒绝",
  })
  const a = answer.trim()
  if (alwaysOpt && a.startsWith("本项目总是允许")) {
    if (cwd) {
      const cfg = loadConfig()
      const key = allowlistKeyFor(cwd)
      const list = cfg.allowlists ?? {}
      const set = new Set(list[key] ?? [])
      set.add(first!.toLowerCase())
      cfg.allowlists = { ...list, [key]: [...set] }
      saveConfig(cfg)
    }
    if (gk) sessionGrants.add(gk)
    return null
  }
  if (/^(y|yes|是|允许|ok|允许（y）)/i.test(a)) {
    if (gk) sessionGrants.add(gk)
    return null
  }
  return `[用户拒绝] ${tool} 操作被用户拒绝：${summary}`
}

/** T90：目标路径是否落在工作区内（相对 cwd 解析后不逃逸）——写操作越界即按危险处理 */
export function insideWorkspace(p: string, cwd: string): boolean {
  const rel = relative(resolve(cwd), resolve(p))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * T93：**文件写入的统一权限门**。所有会往磁盘写文件的工具都必须走这里。
 *
 * 为什么必须抽成单一出口：T90 给 `write` / `edit` 修好了「工作区外写盘按危险操作处理」，
 * 但 `xlsx_write` / `docx_write` / `imggen` / `videogen` 这四个**同样**
 * `resolve(cwd, path)` + `writeFileSync` 的工具一处都没调 `gate()` ——
 * 它们能覆盖任意路径，却比 `write` 少一道确认。
 * 后果是 T90 那条规则形同虚设：想绕开确认，把 `write` 换成 `xlsx_write` 就行。
 * **规则存在两份就会漂**（本文件与 tools.ts 各写一遍 `insideWorkspace` 就是漂的开始），
 * 所以合成这一个出口，谁要写盘谁调它。
 *
 * 判据与 T90 一致：
 * - 工作区内：不算危险（正常干活），但 `confirm-all` 档仍会问
 * - 工作区外：按危险操作处理，并按**目录**粒度记会话授权（同目录第二次起免问，
 *   否则往一个目录写十个文件要问十次，正常用起来变成折磨）
 */
export async function gateFileWrite(opts: {
  /** 工具名，会出现在确认框里（"write" / "docx_write" …） */
  tool: string
  /** 解析后的绝对目标路径 */
  target: string
  /** 当前工作区 */
  cwd: string
  mode: PermissionMode
  broker?: QuestionBroker
  sessionId?: string
}): Promise<string | null> {
  const outside = !insideWorkspace(opts.target, opts.cwd)
  return gate({
    tool: opts.tool,
    summary: opts.target,
    danger: outside,
    mode: opts.mode,
    broker: opts.broker,
    sessionId: opts.sessionId,
    grantScope: outside ? `fs:${dirname(opts.target).toLowerCase()}` : undefined,
  })
}
