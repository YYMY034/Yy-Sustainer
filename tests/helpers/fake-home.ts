/**
 * 测试 HOME 隔离：必须在任何 ../src import 之前导入（副作用模块）。
 * store.ts 等模块在加载时用 homedir() 锁定 ~/.yyagent 路径——不隔离的话测试会
 * 直接读写真实用户目录（T142 教训：reset() 曾把用户的真实会话目录整个删掉）。
 */
import { rmSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const FAKE = mkdtempSync(join(tmpdir(), "yy-store-test-"))
process.env.USERPROFILE = FAKE
process.env.HOME = FAKE

process.on("exit", () => {
  try { rmSync(FAKE, { recursive: true, force: true }) } catch { /* 临时目录 */ }
})
