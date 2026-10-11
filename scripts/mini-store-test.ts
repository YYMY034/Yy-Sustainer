/**
 * 手工探针：验证 T142 守卫自愈链路（主文件被外部进程删除 → listSessions 从守卫副本恢复）。
 *
 * ⚠️ 安全前提：**必须先把 HOME 指到临时目录**。
 * 这个脚本以前是直接 createSession / persist 的，还 `writeFileSync(真实 index.json, "[]")`——
 * 也就是说，谁在项目根 `tsx scripts/mini-store-test.ts` 跑一下，谁的**真实会话索引就被清空**。
 * 现在先建临时 HOME、再用**动态 import** 加载 src：静态 import 会被提升到赋值之前，
 * 起不到隔离作用（这正是 store.ts 把路径锁成模块级常量的坑）。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const SANDBOX = mkdtempSync(join(tmpdir(), "yyagent-mini-store-"))
process.env.USERPROFILE = SANDBOX
process.env.HOME = SANDBOX

const { createSession, listSessions, deleteSession, persist } = await import("../src/session/store.js")
const { existsSync, unlinkSync, writeFileSync } = await import("node:fs")

if (!homedir().startsWith(tmpdir())) {
  console.error(`[中止] HOME 未被隔离到临时目录：${homedir()}`)
  process.exit(1)
}

const S = join(homedir(), ".yyagent", "sessions")
const G = join(homedir(), ".yyagent", "sessions-guard")
const meta = createSession("C:\\t1")
persist(meta, [{ role: "user", content: "真实对话", ts: Date.now() }])
console.log("guard 存在:", existsSync(join(G, meta.id + ".json")))
unlinkSync(join(S, meta.id + ".json"))
writeFileSync(join(S, "index.json"), "[]")
const list = listSessions()
console.log("自愈恢复:", list.some((s) => s.id === meta.id), "| 主文件回位:", existsSync(join(S, meta.id + ".json")))
deleteSession(meta.id)
console.log("真删后 guard 移除:", !existsSync(join(G, meta.id + ".json")))
console.log("MINI_OK")
try {
  rmSync(SANDBOX, { recursive: true, force: true })
} catch {
  /* 临时目录清理失败不影响结果 */
}
process.exit(0)
