/**
 * 测试 HOME 结构性护栏（T142）。
 *
 * ## 为什么放在 src 而不是 tests
 *
 * 隔离原本靠「每个测试文件自己记得 import `tests/helpers/isolated-home.js`」。
 * 但仓库里有 6 个文件（attachments / bgStore / checkpoint / memoryIndex /
 * todoPrompt / undoStore）用 `homedir()` 定位 `~/.yyagent` 却**完全没隔离**——
 * `memoryIndex.test.ts` 的注释还写着「worker 已隔离 HOME」，那只是 `npm test`
 * 走跑批器时的假象。一旦这些文件被**单独**运行（外部测试循环/agent 自查就是这么跑的），
 * 它们直接读写、甚至删掉用户真实的会话、附件与快照。
 *
 * 实测证据：`~/.yyagent/sessions-trash/` 里 40+ 个垃圾文件全是测试夹具
 * （`cwd: "C:\\p"`、标题「附件清理」「保守跳过」——正是 `tests/attachments.test.ts`
 * 第 185/197 行的产物），时间为 10-07 与 10-11 的多轮循环。
 *
 * 把闸门移到**被调用方**：src 的破坏性 API 在真正动手前自己检查。忘掉 import 也拦得住。
 *
 * ## 设计取舍：只在破坏性操作处检查，不在模块加载时检查
 *
 * 模块加载时检查会误伤那些「只是 import 了 store 但只读不写」的测试文件（直接崩）。
 * 放在破坏性操作入口则精准：读操作随便跑，真要删用户数据时才拦。
 */
import { homedir, tmpdir } from "node:os"
import { resolve, sep } from "node:path"

/** 路径是否落在临时目录里（Windows 大小写不敏感，统一小写比较） */
function underTmp(p: string): boolean {
  const h = resolve(p).toLowerCase()
  const t = resolve(tmpdir()).toLowerCase()
  return h === t || h.startsWith(t + sep)
}

/** 是否处于测试进程（node:test 会自动设 NODE_TEST_CONTEXT） */
function isTestProcess(): boolean {
  return !!process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === "test" || !!process.env.YYAGENT_TEST_MODE
}

/**
 * 破坏性操作（删会话 / 清目录 / 移动用户文件）的守卫。
 *
 * 仅在「测试进程 + HOME 未隔离」时抛错——即测试正准备动用户真实数据的那一刻。
 * 正常运行（非测试进程）与隔离良好的测试都直接放行，零误伤。
 *
 * @param op 操作名，报错时指出被哪一步拦下
 */
export function guardTestHome(op: string): void {
  if (!isTestProcess()) return
  if (underTmp(homedir())) return
  // 逃生舱：确实需要在真实 HOME 上跑的端到端验证可显式声明（自担风险）
  if (process.env.YYAGENT_ALLOW_REAL_HOME_IN_TEST === "1") return
  throw new Error(
    `[测试安全] 已阻止一次针对真实用户目录的破坏性操作：${op}\n` +
      `  测试进程的 HOME 指向真实目录 ${homedir()}，不是沙箱。\n` +
      `  继续下去会删掉用户真实的会话/附件/快照，所以这里主动中止。\n` +
      `  正确做法：测试文件首行 import "./helpers/isolated-home.js"，或用 npm test。\n` +
      `  确实需要在真实 HOME 上跑：设 YYAGENT_ALLOW_REAL_HOME_IN_TEST=1。`,
  )
}
