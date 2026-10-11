/**
 * 测试 HOME 隔离（T142 加固版）。
 *
 * 必须在任何 `../src` import **之前**导入——store.ts / attachments.ts 等模块在加载时
 * 用 `homedir()` 把 `~/.yyagent/...` 锁成模块级常量，晚一步就锁到真实用户目录上了。
 *
 * 为什么要有这个文件（T142 事故复盘）：
 *   `tests/store.test.ts` 的 `reset()` 直接 `rmSync(~/.yyagent/sessions, {recursive:true})`，
 *   而且每个用例前都调一次。原先只有 `scripts/run-unit-tests.mjs` 提供隔离——
 *   **一旦有人直接跑单个测试文件**（`npx tsx --test tests/store.test.ts`，外部测试循环/自查时最自然的动作），
 *   隔离就不存在，测试会把**用户真实的会话目录**当自己的沙箱来读写：
 *   - `store.test.ts` 的 `rmSync` 是**硬删**，不进回收站，删了无法恢复；
 *   - `attachments.test.ts` / `bgStore.test.ts` 等会把夹具会话写进真实 sessions，
 *     再经 `deleteSession()` 移动进真实 `sessions-trash/`（这些垃圾文件是外部循环的指纹）。
 *   实测复现：真实用户的会话在 10-07、10-11 多轮消失，回收站里堆了 40+ 个测试夹具。
 *
 * 两道防线（缺一不可）：
 *   ① **重定向**：把 USERPROFILE/HOME 指到临时目录，让所有落盘发生在沙箱里（本文件自动做）；
 *   ② **断言**：`assertIsolatedHome()` 在真正执行删除前校验 homedir() 确实在临时目录下，
 *      不在就**抛错中止**，而不是把用户的文件删掉。破坏性操作前必须调它。
 *
 * 第三道防线在 src 侧：`src/shared/testHomeGuard.ts`——即使某个测试文件忘了 import 本模块，
 * 被隔离保护的模块在加载时也会自己抛错。**忘掉 import 也删不到用户数据。**
 */
import { mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

/** 重定向前记下真实 HOME，断言时用来报错提示 */
export const REAL_HOME = homedir()

const FAKE = mkdtempSync(join(tmpdir(), "yyagent-test-home-"))
process.env.USERPROFILE = FAKE
process.env.HOME = FAKE

process.on("exit", () => {
  try {
    rmSync(FAKE, { recursive: true, force: true })
  } catch {
    /* 临时目录，删不掉就算了 */
  }
})

/** 路径是否落在临时目录里（Windows 大小写不敏感，统一小写比较） */
function isUnderTmp(p: string): boolean {
  const h = resolve(p).toLowerCase()
  const t = resolve(tmpdir()).toLowerCase()
  return h === t || h.startsWith(t + sep)
}

/**
 * 断言当前 HOME 已被隔离到临时目录。**任何 rmSync / 清目录操作之前都要调它。**
 * 不在临时目录就抛错——宁可测试红，也不能删用户的真实数据。
 */
export function assertIsolatedHome(): void {
  if (isUnderTmp(homedir())) return
  throw new Error(
    `[测试安全] 拒绝在真实 HOME 上执行破坏性操作：homedir()=${homedir()}\n` +
      `  期望落在临时目录 ${tmpdir()} 下。\n` +
      `  正确跑法：npm test（跑批器 scripts/run-unit-tests.mjs 会隔离 HOME）\n` +
      `  直接跑单文件时：确保测试文件首行 import 了 "./helpers/isolated-home.js"`,
  )
}

/** 当前沙箱 HOME（调试用） */
export const SANDBOX_HOME = FAKE
