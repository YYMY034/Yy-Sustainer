/**
 * T94 回归：行为评测通道本身是可信的。
 *
 * 两层：
 *  ① 纯函数层——scoreScenario 的每类 expect 都要「该过就过、该红就红」，
 *     且失败信息带**实际值**（只说"不匹配"不给实际值的失败信息没法用）。
 *  ② 管线层——真跑一次 runner --fake：隔离沙箱 + 假 provider + 真网关，
 *     两个自检场景全过。管线坏了这里直接红。
 *
 *   npx tsx scripts/check-t94-eval.ts
 */
import { spawnSync } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { EVAL_SCENARIOS } from "./eval/scenarios.js"
import { scoreScenario, type TurnObservation } from "./eval/runner.js"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = ""): void => {
  if (ok) { pass++; console.log(`ok   ${label}${extra ? " — " + extra : ""}`) } else { fail++; console.log(`FAIL ${label}${extra ? " — " + extra : ""}`) }
}

const sc = (id: string): (typeof EVAL_SCENARIOS)[number] => {
  const s = EVAL_SCENARIOS.find((x) => x.id === id)
  if (!s) throw new Error(`场景不存在：${id}`)
  return s
}

// ---------- ① 纯函数层 ----------

const obs = (over: Partial<TurnObservation>): TurnObservation => ({
  text: "模型的一段回复",
  tools: ["read"],
  files: new Map([["a.txt", "alpha\nBETA\ngamma\n"]]),
  ...over,
})

{
  const v = scoreScenario(sc("find-symbol"), obs({ text: "定义在 src/util.ts" }))
  check("text-contains 命中即过", v.pass, JSON.stringify(v.failures))
}
{
  const v = scoreScenario(sc("find-symbol"), obs({ text: "我没找到" }))
  check("text-contains 落空即红且带实际文本", !v.pass && v.failures.some((f) => f.includes("util.ts") && f.includes("我没找到")), v.failures.join(" | "))
}
{
  const v = scoreScenario(sc("eternal-no-search"), obs({ tools: ["websearch"] }))
  check("tool-not-called 违例即红且点名工具", !v.pass && v.failures.some((f) => f.includes("websearch")), v.failures.join(" | "))
}
{
  const v = scoreScenario(sc("minimal-edit"), obs({ tools: ["edit"] }))
  check("minimal-edit 全命中（edit 用了/write 没用/文件三行都在）", v.pass, JSON.stringify(v.failures))
}
{
  const v = scoreScenario(sc("minimal-edit"), obs({ tools: ["write"], files: new Map([["a.txt", "alpha\nBETA\ngamma\n"]]) }))
  check("全量重写（write）被抓住", !v.pass && v.failures.some((f) => f.includes("write")), v.failures.join(" | "))
}
{
  const v = scoreScenario(sc("write-file"), obs({ files: new Map() }))
  check("file-exists 缺文件即红并列出实际文件", !v.pass && v.failures.some((f) => f.includes("note.txt") && f.includes("<无>")), v.failures.join(" | "))
}
{
  const v = scoreScenario(sc("danger-refused"), obs({ text: "该操作已被权限系统拒绝，已跳过。", files: new Map([["keep.txt", "重要数据\n"]]) }))
  check("danger-refused 文案命中放行分支", v.pass, JSON.stringify(v.failures))
}
{
  const v = scoreScenario(sc("format-discipline"), obs({ text: "第一行\n# 标题不该出现" }))
  check("井号标题（m 标志跨行）被抓住", !v.pass && v.failures.some((f) => f.includes("#{1,6}")), v.failures.join(" | "))
}

// ---------- ② 管线层（runner --fake，真起沙箱 + 假 provider + 真网关） ----------

console.log("\n── 管线自检（runner --fake，约 20-40 秒）──")
const r = spawnSync(process.execPath, ["--import", "tsx", join("scripts", "eval", "runner.ts"), "--fake", "--json"], {
  cwd: REPO,
  encoding: "utf8",
  timeout: 300_000,
})
const stdout = r.stdout ?? ""
check("runner --fake 退出码 0", r.status === 0, `status=${r.status} stderr=${cut(r.stderr ?? "", 300)}`)
try {
  const start = stdout.indexOf("[")
  const rows = JSON.parse(stdout.slice(start, stdout.lastIndexOf("]") + 1)) as Array<{ id: string; pass: boolean }>
  check("两个自检场景都过", Array.isArray(rows) && rows.length === 2 && rows.every((x) => x.pass), JSON.stringify(rows))
} catch {
  check("runner 输出可解析为 JSON", false, cut(stdout, 300))
}

function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
