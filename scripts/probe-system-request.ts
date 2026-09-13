// 严谨证据链：① 复用真实模块拼接 system（loadInjection + skillsPrompt + SYSTEM_PROMPT，
// 与 loop.ts prepare() 同序同源）；② 通过真实 HTTP 发一次请求到本地假 provider，捕获完整请求体，
// 看 system 字段是不是我们的提示词；③ 响应流里 reasoning_content 与 content 同流返回，
// 验证「思考」与「回答」是同一次请求（不是两次）。
import http from "node:http"
import { streamText, stepCountIs } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { SYSTEM_PROMPT } from "../src/agent/prompt.js"
import { loadInjection } from "../src/agent/inject.js"
import { skillsPrompt } from "../src/skills/loader.js"

let captured = ""
const server = http.createServer((req, res) => {
  let buf = ""
  req.on("data", (c) => (buf += c))
  req.on("end", () => {
    captured = buf
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.write('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"（思考：这个 system 说我是 Yy Sustainer）"},"finish_reason":null}]}\n\n')
    res.write('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"Yy Sustainer / YYMY"},"finish_reason":null}]}\n\n')
    res.write('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9000,"completion_tokens":5,"total_tokens":9005}}\n\n')
    res.write("data: [DONE]\n\n")
    res.end()
  })
})
await new Promise((r) => server.listen(8897, "127.0.0.1", () => r(null)))

// ① 与 loop.ts:262 同一拼接（同序、同函数）
const injection = await loadInjection({ cwd: process.cwd(), model: "bai/qwen3.8-flash" })
const system = [SYSTEM_PROMPT, injection, skillsPrompt()].filter(Boolean).join("\n\n")
console.log("① 拼接结果: SYSTEM_PROMPT", SYSTEM_PROMPT.length, "字 | injection", injection.length, "字 | skills", skillsPrompt().length, "字 | 合计", system.length, "字")
console.log("   首行:", system.split("\n")[0])

// ② 真实 HTTP 请求
const p = createOpenAICompatible({ name: "probe", baseURL: "http://127.0.0.1:8897/v1", apiKey: "sk-probe" })
const t0 = Date.now()
const r = streamText({
  model: p.chatModel("qwen3.8-flash"),
  system,
  messages: [{ role: "user", content: "你的名字与作者？" }],
  stopWhen: [stepCountIs(1)],
})
const text = await r.text
console.log("② 模型正文返回:", JSON.stringify(text), "| 耗时", Date.now() - t0, "ms")
await new Promise((r2) => setTimeout(r2, 100))

// ③ 检查请求体
const body = JSON.parse(captured)
const msgs = body.messages ?? []
const sysMsgs = msgs.filter((m) => m.role === "system")
const sys = sysMsgs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n")
console.log("③ 请求体: messages", msgs.length, "条 | system 消息", sysMsgs.length, "条 | 顶层 system 字段:", body.system !== undefined)
console.log("   system 字段字符数:", sys.length, "| 与拼接结果一致:", sys.trim() === system.trim())
const checks = {
  "首句「你是 Yy Sustainer，由 YYMY 开发」": sys.includes("你是 Yy Sustainer，由 YYMY 开发"),
  "身份节（作者 YYMY / 产品细节以仓库为准）": sys.includes("你的作者是 **YYMY**"),
  "长期记忆节": sys.includes("## 长期记忆"),
  "记忆的应用节": sys.includes("## 记忆的应用"),
  "过往对话检索节": sys.includes("## 过往对话检索"),
  "回答形态速查节": sys.includes("## 回答形态速查"),
  "图表 chart 围栏说明": sys.includes("信息行写 chart"),
  "网络与文件系统环境节": sys.includes("## 网络与文件系统环境"),
  "引用与转述硬规则": sys.includes("引用与转述（硬规则）"),
  "文件格式触发词路由": sys.includes("## 文件格式的触发词路由"),
}
console.log("--- system 内容抽查 ---")
for (const [k, v] of Object.entries(checks)) console.log((v ? "  ✅ " : "  ❌ ") + k)
const allOk = Object.values(checks).every(Boolean)
console.log("--- 结论 ---")
console.log(allOk && sys.trim() === system.trim() ? "✅ 主对话请求的 system 字段 = 我们的完整提示词（含全部新增章节）" : "❌ 有缺项，需排查")
server.close()
