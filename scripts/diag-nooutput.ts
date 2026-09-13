// 诊断：完整链路（含默认全工具/MCP）调用真实模型，捕获 No output generated 的真实原因。
import { runAgentStream } from "../src/agent/loop.js"

const MODEL = process.env.MODEL || "sensenova/glm-5.2"
console.log("模型:", MODEL)
let text = ""
const t0 = Date.now()
try {
  const r = await runAgentStream(
    "只回复两个字：你好",
    { model: MODEL, cwd: process.cwd() },
    { onText: (d) => { text += d }, onStatus: (s) => console.log("  [status]", s), onToolEvent: (e) => console.log("  [tool]", e.type, e.name) },
  )
  console.log("✅ 成功 | 耗时", Date.now() - t0, "ms | text:", JSON.stringify(r.text), "| steps:", r.steps, "| usage:", JSON.stringify(r.usage))
} catch (e) {
  const err = e as Record<string, unknown> & { name?: string; message?: string; cause?: { message?: string } }
  console.log("❌ 失败 | 耗时", Date.now() - t0, "ms")
  console.log("  name:", err.name)
  console.log("  message:", err.message)
  console.log("  cause:", (err.cause as { message?: string })?.message ?? err.cause)
  console.log("  statusCode:", err.statusCode)
  const rb = err.responseBody
  console.log("  responseBody:", typeof rb === "string" ? rb.slice(0, 1000) : rb)
  console.log("  全部自有属性:", JSON.stringify(err, Object.getOwnPropertyNames(err)).slice(0, 2000))
  console.log("  已流出文本:", JSON.stringify(text))
}
process.exit(0)
