/**
 * T91 提示词分层回归：内部调用走精简层、面向用户的调用必须走完整层。
 * 运行：npx tsx scripts/check-t91-prompt-base.ts
 *
 * 为什么值得断言：精简基础层能省 ~11k tokens/次，但如果哪天有人手滑把 compactBase 传到
 * 主对话/子代理/质检路径上，模型就会丢掉工具纪律与记忆规则——这种退化不会报错，只会变笨。
 */
import { COMPACT_BASE, SCOPE_NOTE, SYSTEM_PROMPT, composeSystem } from "../src/agent/prompt.js"

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { pass++; console.log(`  PASS  ${name}`) } else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`) }
}

const full = SYSTEM_PROMPT.length
const compact = COMPACT_BASE.length
console.log("1. 体量")
console.log(`  完整基础层 ${full} 字符 ≈ ${Math.round(full / 1.6)} tokens`)
console.log(`  精简基础层 ${compact} 字符 ≈ ${Math.round(compact / 1.6)} tokens`)
ok("精简层至少小一个数量级", full / compact > 10, `实际 ${(full / compact).toFixed(1)}×`)

console.log("\n2. 精简层必须保留的硬约束")
for (const [label, kw] of [
  ["裸 JSON 契约", "JSON"],
  ["PASS/FAIL 契约", "PASS"],
  ["不编造", "编造"],
  ["密钥不外泄", "API key"],
] as const) {
  ok(`含「${label}」`, COMPACT_BASE.includes(kw))
}

console.log("\n3. 拼接行为")
{
  const fullSys = composeSystem({ role: "你是压缩器" })
  const compactSys = composeSystem({ role: "你是压缩器", compactBase: true })
  ok("默认（不传 compactBase）= 完整层", fullSys.startsWith(SYSTEM_PROMPT.slice(0, 40)))
  ok("compactBase=true = 精简层", compactSys.startsWith(COMPACT_BASE.slice(0, 20)))
  ok("专用指令仍在最末（优先级最高）", compactSys.trimEnd().endsWith("你是压缩器"))
  ok("作用域声明仍在（严格输出契约不被冲散）", compactSys.includes(SCOPE_NOTE.slice(0, 20)))
  ok("精简层不含完整层内容", !compactSys.includes("## 工具全景"))
  ok("完整层含工具纪律", fullSys.includes("## 工具全景"))
  ok("精简层更短", compactSys.length < fullSys.length)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0
