// T73 行为层验证：注入 18k 主提示词后，拆分器还能不能只输出 JSON。
// 用公网 provider 真实调用一次（与 gateway 拆分器同样的 system/参数/解析逻辑）。
import { runAgent } from "../src/agent/loop.js"

const MODEL = process.env.PROBE_MODEL || "siliconflow/zai-org/GLM-5.2"
const ROLE = "你是任务拆分器。只输出 JSON，不要输出任何其他内容。"
const PROMPT =
  `把这条用户诉求拆分成按项目独立的子任务。用户诉求原文：\n` +
  `帮我给搭子小程序加上语音输入，另外 yyagentd 那边把白皮书补一下语音模块的说明\n\n` +
  `已知项目工作区（cwd 只能从这里选）：\n` +
  `C:\\Users\\YYMY\\Documents\\Catpaw\\YYAgent\\yyagentd\n` +
  `C:\\Users\\YYMY\\Documents\\Catpaw\\YYAgent\\搭子\\partner-match\n\n` +
  `规则：1) 只拆「确实要分别在不同项目里执行」的独立任务；跨项目的关联部分归入最相关的那个子任务说明里；2) 每个子任务一段自包含的清晰指令（不引用其他子任务的上下文）；3) 拆不出 ≥2 个独立子任务、或诉求不属于任何已知项目时，输出 {"tasks":[]}；4) 只输出 JSON：{"tasks":[{"cwd":"完整路径","task":"子任务指令"}]}`

const t0 = Date.now()
const r = await runAgent(PROMPT, { model: MODEL, system: ROLE, disableInjection: true, maxSteps: 1 })
const raw = (r.text ?? "").trim()
console.log("模型:", r.model, "| 耗时", Date.now() - t0, "ms | 输入 tokens:", r.usage?.in)
console.log("--- 原始输出（前 300 字）---")
console.log(raw.slice(0, 300))
console.log("--- 解析侧容错（与 gateway 同逻辑）---")
const clean = raw.replace(/<(thinking|think)>[\s\S]*?<\/\1>/gi, "")
const m = clean.match(/\{[\s\S]*\}(?!\s*\{)/g)
let ok = false, parsed = null
try {
  parsed = JSON.parse((m ?? [clean])[m ? m.length - 1 : 0])
  ok = Array.isArray(parsed?.tasks)
} catch { ok = false }
console.log("纯 JSON（首字符 {）:", raw.startsWith("{"))
console.log("含代码围栏:", raw.includes("```"))
console.log("夹带解释文字:", raw.length > 0 && !raw.startsWith("{"))
console.log("解析成功且含 tasks 数组:", ok, "| 子任务数:", parsed?.tasks?.length ?? 0)
if (parsed?.tasks) console.log(JSON.stringify(parsed.tasks, null, 1).slice(0, 600))
console.log("--- 判定 ---")
console.log(ok ? "✅ 注入基础层后拆分器仍能正常产出结构化 JSON（解析侧容错兜底）" : "❌ 需加强约束或解析容错")
process.exit(ok ? 0 : 1)
