// T92 单元测试跑批器：node:test + tsx，零新增依赖。
//
// 为什么不用 vitest/jest：这个项目已经有一套 40+ 个 `scripts/check-*.ts` 断言脚本，
// 但它们是「一次性、无框架、靠人肉 diff 输出」的——适合端到端冒烟，不适合
// 「每次改一行都想立刻知道有没有破坏」的细粒度回归。引入 Node 内置 test runner
// （`node --test`）能拿到断言/子测试/退出码，且**不装任何依赖**。
//
// 关键一：**隔离 HOME**。
// 被测模块（store / attachments / usage）都用 `os.homedir()` 定位 `~/.yyagent`，
// 是模块级常量、无法注入。所以这里给子进程换一个临时 USERPROFILE/HOME，
// 让所有落盘都发生在沙箱里——**绝不碰用户真实的会话、密钥与附件**。
//
// 关键二：**每个测试文件一个沙箱，且串行跑**。
// 起初是「一个沙箱 + `node --test` 一次跑全部文件」，结果出现偶发失败：
// `store.test.ts` 的 `reset()` 会 `rmSync` 掉整个 `~/.yyagent/sessions`，
// 而 `--test` 默认**并行**跑多个文件、它们共用同一个 HOME——一个文件在清目录，
// 另一个文件正在往里写会话文件，于是随机报 `ENOENT`（每次失败的用例还不一样，
// 正是竞态的特征）。
// 修法不是加 `--test-concurrency=1` 了事（那只是把竞态压成顺序依赖，后来者仍会踩），
// 而是让文件之间**不共享任何可变状态**：一个文件一个沙箱。
// 代价是多几次 tsx 冷启动；换来的是「新增测试文件不会莫名其妙弄坏别的文件」。
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = "tests"
if (!existsSync(dir)) {
  console.log("没有 tests/ 目录，跳过单测")
  process.exit(0)
}
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => join(dir, f))

if (!files.length) {
  console.log("没有单测文件，跳过")
  process.exit(0)
}

console.log(`用例文件 ${files.length} 个：${files.map((f) => f.replace(/^tests[\\/]/, "")).join(", ")}\n`)

const sandboxes = []
const failed = []

for (const file of files) {
  const sandbox = mkdtempSync(join(tmpdir(), "yyagent-test-"))
  sandboxes.push(sandbox)
  console.log(`──── ${file} ${"─".repeat(Math.max(0, 46 - file.length))}`)
  console.log(`     沙箱 HOME=${sandbox}`)

  const r = spawnSync(process.execPath, ["--import", "tsx", "--test", file], {
    stdio: "inherit",
    env: {
      ...process.env,
      // Windows 上 os.homedir() 优先读 USERPROFILE；POSIX 走 HOME。两个都换掉，双保险。
      USERPROFILE: sandbox,
      HOME: sandbox,
      // 测试里不该弹系统凭据库（DPAPI）之外的交互；主密钥直接用环境变量，避免读用户真实 .master.key
      YYAGENT_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    },
    shell: false,
  })
  if (r.status !== 0) failed.push(file)
  console.log("")
}

for (const s of sandboxes) {
  try {
    rmSync(s, { recursive: true, force: true })
  } catch {
    /* 沙箱清理失败不影响结果 */
  }
}

if (failed.length) {
  console.log(`❌ 单测失败：${failed.join(", ")}（共 ${files.length} 个文件）`)
  process.exit(1)
}
console.log(`✅ 单测全绿：${files.length} 个文件全部通过`)
process.exit(0)
