/**
 * T94：评测用假 provider（OpenAI 兼容 /chat/completions + /models）。
 *
 * 只在 --fake 模式用：按「最后一条 user 消息原文」找到对应场景的剧本，
 * 按对话里已有的 tool 消息数推进轮次——有工具就发 tool_calls，发完进下一轮，
 * 剧本走完就回文本收尾。流式/非流式都答（主代理走 streamText，内部调用走 generateText）。
 * 抄自 scripts/probe-subagent-steps.ts 的成熟写法，别发明新格式。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { EvalScenario, FakeTurn } from "./scenarios.js"

type Msg = { role: string; content: unknown }

const chunk = (delta: unknown, finish?: string, usage?: unknown): string =>
  "data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(usage ? { usage } : {}) }) + "\n\n"

const jsonText = (content: string): string =>
  JSON.stringify({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } })

const jsonTool = (name: string, args: Record<string, unknown>): string =>
  JSON.stringify({
    id: "c",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
  })

export function startFakeProvider(scenarios: EvalScenario[]): Promise<{ server: Server; port: number }> {
  const byPrompt = new Map<string, FakeTurn[]>()
  for (const sc of scenarios) {
    if (sc.fake?.turns?.length) byPrompt.set(sc.prompt, sc.fake.turns)
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "fake-1" }] }))
      return
    }
    let raw = ""
    req.on("data", (c) => { raw += String(c) })
    req.on("end", () => {
      let messages: Msg[] = []
      let stream = false
      try {
        const body = JSON.parse(raw) as { messages?: Msg[]; stream?: boolean }
        messages = body.messages ?? []
        stream = body.stream === true
      } catch { /* 按空处理 */ }

      const lastUser = [...messages].reverse().find((m) => m.role === "user")
      const prompt = typeof lastUser?.content === "string" ? lastUser.content : ""
      const turns = byPrompt.get(prompt)
      if (!turns) {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(jsonText(`[fake provider] 没有场景对得上这段 prompt：${prompt.slice(0, 80)}`))
        return
      }
      const done = messages.filter((m) => m.role === "tool").length
      const turn = turns[Math.min(done, turns.length - 1)]

      const sse = (lines: string[]): void => {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
        for (const l of lines) res.write(l)
        res.write("data: [DONE]\n\n")
        res.end()
      }
      const usage = { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 }
      if (turn.tool) {
        const call = JSON.stringify({ tool_calls: [{ index: 0, id: "fc", type: "function", function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) } }] })
        if (stream) sse([chunk({ role: "assistant", content: "" }), chunk(JSON.parse(call), "tool_calls", usage)])
        else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(jsonTool(turn.tool.name, turn.tool.args)) }
        return
      }
      if (stream) sse([chunk({ role: "assistant", content: "" }), chunk({ content: turn.text ?? "" }, "stop", usage)])
      else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(jsonText(turn.text ?? "")) }
    })
  }

  const server: Server = createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolve({ server, port })
    })
  })
}
