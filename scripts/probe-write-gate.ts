// 写盘权限门守卫：src/ 下任何会写盘的文件，必须二选一。
//
//   A) 引用了 `gateFileWrite(` / `gate(` —— 走了权限门
//   B) 在下面的 ALLOWLIST 里，且**写明为什么它的写盘路径不受模型控制**
//
// 为什么需要它：T90 给 write/edit 修好了「工作区外写盘按危险操作处理」，
// 但 `xlsx_write` / `docx_write` / `imggen` / `videogen` 这四个同样
// `resolve(cwd, path)` + `writeFileSync` 的工具**一处都没调 gate()**——
// 想绕开确认只要换个工具名就行，T90 那条规则形同虚设（本轮 T93 才补上）。
//
// 这类漏检靠人眼扫是扫不出来的：新增一个工具时，没人会记得去数「全项目还有哪些写盘点」。
// 所以做成脚本：新写盘文件出现 → 报红 → 强制过一遍那个问题
// ——「这个工具能拿模型给的路径写盘吗？能，就上 gateFileWrite。」
//
// 白名单会双向校验（已不写盘 / 已开始 gate 的条目报「过期」），
// 否则白名单会慢慢长成一张免责清单，而不是一张审查记录。
//
// 用法：npx tsx scripts/probe-write-gate.ts
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const SRC = "src"

/** 会改动磁盘的调用。宁可多列几个，漏一个等于守卫失效。 */
const WRITE_PATTERNS: RegExp[] = [
  /writeFileSync\(/,
  /appendFileSync\(/,
  /writeFile\(/,
  /createWriteStream\(/,
  /rmSync\(/,
  /unlinkSync\(/,
  /rmdirSync\(/,
  /renameSync\(/,
  /truncateSync\(/,
  /copyFileSync\(/,
]

/**
 * 允许「写盘但不走 gate」的文件 —— 每一条都必须回答一个问题：
 * **这里的路径能不能被模型（或请求体）指定？** 不能，才允许留在这里。
 */
const ALLOWLIST: Record<string, string> = {
  "src/agent/backup.ts": "T83 自动备份：写 ~/.yyagent/backups/，路径由时间戳生成，非模型可控",
  "src/agent/config.ts": "saveConfig：写 ~/.yyagent/config.json。调用方是设置 UI / 内部逻辑，模型无法指定路径",
  "src/agent/db.ts": "db_save 工具：写 ~/.yyagent/db/<name>.json，name 过网关白名单正则 [a-zA-Z][\\w-]{0,31}，不能带分隔符",
  "src/agent/memory.ts": "memory_save 工具：写 ~/.yyagent/memory/**，主题名过 safeTopic() 严格正则（无点无斜杠，逃不出去）",
  "src/agent/secrets.ts": "密钥库：写 ~/.yyagent/ 下固定文件（KEY_FILE / 加密配置），路径是模块常量",
  "src/agent/taskstore.ts": "定时任务存储：写 ~/.yyagent/tasks.json，路径是模块常量",
  "src/agent/todo.ts": "todo_write 工具：写 ~/.yyagent/todo/<sessionId>.json，sessionId 由运行时注入，模型只能给内容",
  "src/gateway.ts": "HTTP 层的写盘：/api/sessions/undo-files 把前端传来的快照写回 f.path —— 由用户点「撤销」触发（用户动作即授权），不是模型自主写盘",
  "src/session/attachments.ts": "附件：内容寻址（sha1 前 16 位）落到 ~/.yyagent/attachments/，路径由服务端构造",
  "src/agent/bgStore.ts": "T93 B1 后台任务元数据：写 ~/.yyagent/bg/tasks.json（固定路径）。id 由 nextBgId() 从磁盘最大序号产生，形状恒为 bg-<数字>；logFile 由服务端 join 构造。**模型能给 command 内容，给不了路径**——bg_read 的 task_id 虽来自模型，但 bgLogPath 对非 bg-<数字> 一律返回 undefined（tests/bgStore.test.ts 有路径穿越断言）",
  "src/agent/hookJudge.ts": "T93 L2 判定采样录制：appendFileSync 到 ~/.yyagent/hook-samples.jsonl（固定路径，模块常量）。内容是服务端构造的判定记录（工具名/输出采样/钩子判据/判定结果），模型能给工具输出内容、给不了路径；且默认关闭（config.hookRecord），是诊断数据不是主链路",
  "src/session/checkpoint.ts": "T93 P1 轮内 checkpoint：写 ~/.yyagent/checkpoints/<sessionId>.json。sessionId 过 ^[\\w-]{1,64}$ 严格正则（../../ 之类进不来，否则就是任意路径写入——tests/checkpoint.test.ts 有断言），内容全由服务端构造（流式正文/工具步骤/压缩结果）。模型能给内容，给不了路径",
  "src/agent/undoStore.ts": "T93 B2 撤销快照：写 ~/.yyagent/snapshots/<sessionId>/<ts>/<sha1前16位>.snap + index.json。**目录与会话 id 由服务端构造**（sessionId 来自 loadSession 的 uuid，ts 来自 assistant 消息）；路径只进 index.json 不进文件名。内容是被改文件的**改前全文**——所以另有硬约束：默认关（config.undo.persist）、绝不快照 ~/.yyagent/ 内部路径（有 .master.key）、单文件 512KB / 单轮 2MB / 总 64MB / 7 天，且不加进 T83 备份。模型能决定「改哪个文件」，但决定不了快照写到哪",
  "src/session/store.ts": "会话存储：~/.yyagent/sessions/<uuid>.json，uuid 由 randomUUID 生成",
  "src/session/usage.ts": "账本：~/.yyagent/usage.jsonl / usage-backfill.json，固定路径",
  "src/sidechat.ts": "侧聊收件箱：写 INBOX（模块常量），路径固定",
  "src/util/lock.ts": "锁文件：路径由调用方（服务端内部）传入，不是模型输入",
  "src/util/logfile.ts": "日志：路径由调用方（服务端内部）传入，不是模型输入",
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith(".ts")) out.push(p.replace(/\\/g, "/"))
  }
  return out
}

const files = walk(SRC).sort()
const writers: string[] = []
const gated = new Set<string>()

for (const f of files) {
  const src = readFileSync(f, "utf8")
  if (!WRITE_PATTERNS.some((re) => re.test(src))) continue
  writers.push(f)
  if (/gateFileWrite\(|\bgate\(/.test(src)) gated.add(f)
}

console.log(`扫描 ${files.length} 个源文件：会写盘的 ${writers.length} 个，其中走了权限门的 ${gated.size} 个\n`)

let bad = 0

// 规则 1：写盘但既不走门、也不在白名单
const unaccounted = writers.filter((f) => !gated.has(f) && !(f in ALLOWLIST))
if (unaccounted.length) {
  bad += unaccounted.length
  console.log(`❌ 会写盘、没走权限门、也不在白名单（${unaccounted.length} 个）：`)
  for (const f of unaccounted) console.log(`   ${f}`)
  console.log(`\n   逐个回答：这里的写盘路径能不能被模型指定？`)
  console.log(`   能 → 加 gateFileWrite()；不能 → 加进 ALLOWLIST 并写明理由。\n`)
} else {
  console.log(`✅ 每个写盘文件都有交代（走权限门 或 在带理由的白名单里）\n`)
}

// 规则 2：白名单过期（已经不走写盘了，或已经开始 gate 了）
const stale = Object.keys(ALLOWLIST).filter((f) => !writers.includes(f) || gated.has(f))
if (stale.length) {
  bad += stale.length
  console.log(`⚠️  白名单里过期/多余的条目（${stale.length} 个）—— 该删了，否则白名单会长成免责清单：`)
  for (const f of stale) console.log(`   ${f}${gated.has(f) ? "（已经开始 gate）" : "（已经不写盘了）"}`)
  console.log("")
}

// 规则 3：白名单条目的理由不能是空话
const lazy = Object.entries(ALLOWLIST).filter(([, r]) => r.trim().length < 10)
if (lazy.length) {
  bad += lazy.length
  console.log(`⚠️  白名单理由过短（${lazy.length} 个）：${lazy.map(([f]) => f).join(", ")}\n`)
}

console.log("=== 白名单（写盘但不走 gate，附理由）===")
for (const [f, reason] of Object.entries(ALLOWLIST)) {
  console.log(`  ${f}\n      ${reason}`)
}

process.exitCode = bad ? 1 : 0
