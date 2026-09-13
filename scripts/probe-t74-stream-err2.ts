/**
 * T74 探针 v2：本地假 provider，测三类真实世界错误下 AI SDK 的表现
 *  A) 401 鉴权失败（带 JSON body）
 *  B) 402 余额不足
 *  C) 500 服务端错误
 *  D) 流已开始吐字后中途断掉（TCP 半途关闭）
 * 关心两件事：error chunk 里有无可读原因；已流出的正文会不会被丢掉。
 *
 * 跑法：npx tsx scripts/probe-t74-stream-err2.ts
 */
import http from "node:http"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { streamText } from "ai"

const PORT = 18899

const server = http.createServer((req, res) => {
  const url = req.url ?? ""
  let data = ""
  req.on("data", (c) => (data += c))
  req.on("end", () => {
    if (url.includes("case401")) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Invalid API key provided", type: "invalid_request_error" } }))
    } else if (url.includes("case402")) {
      res.writeHead(402, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Insufficient balance, please top up", type: "insufficient_quota" } }))
    } else if (url.includes("case500")) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "internal server error: model overloaded" } }))
    } else if (url.includes("caseMid")) {
      // 先吐两帧合法 SSE，然后暴力断连
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "我正" }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "在回答" }, finish_reason: null }] })}\n\n`)
      setTimeout(() => res.destroy(), 120)
    } else {
      res.writeHead(404, { "content-type": "application/json" })
      res.end("{}")
    }
  })
})

async function probe(name: string, path: string) {
  console.log(`\n=== ${name} ===`)
  const p = createOpenAICompatible({ name: "probe", baseURL: `http://127.0.0.1:${PORT}${path}`, apiKey: "sk-x" })
  const result = streamText({ model: p.chatModel("m"), prompt: "你好" })
  const seen: string[] = []
  let text = ""
  let errChunk: any = null
  try {
    for await (const chunk of result.fullStream as any) {
      seen.push(chunk.type)
      if (chunk.type === "text-delta") text += chunk.text ?? ""
      if (chunk.type === "error") errChunk = chunk.error
    }
    console.log("  fullStream 正常结束")
  } catch (e) {
    console.log("  fullStream 抛出:", (e as Error)?.message)
  }
  console.log("  chunk:", seen.join(","))
  console.log("  已流出正文:", JSON.stringify(text))
  if (errChunk) {
    console.log(`  [error] name=${errChunk.name}`)
    console.log(`    message=${errChunk.message}`)
    console.log(`    statusCode=${errChunk.statusCode} url=${errChunk.url}`)
    console.log(`    responseBody=${String(errChunk.responseBody ?? "").slice(0, 200)}`)
    console.log(`    cause=${errChunk.cause?.name}:${errChunk.cause?.message}`)
    if (errChunk.errors?.length) {
      const le = errChunk.errors[errChunk.errors.length - 1]
      console.log(`    lastError.name=${le.name} statusCode=${le.statusCode} body=${String(le.responseBody ?? "").slice(0, 200)}`)
    }
  }
  try {
    const t = await result.text
    console.log("  result.text 成功:", JSON.stringify(t))
  } catch (e) {
    console.log("  result.text reject:", (e as Error)?.name, "|", (e as Error)?.message)
  }
}

async function main() {
  await new Promise<void>((res) => server.listen(PORT, "127.0.0.1", () => res()))
  console.log(`假 provider 已监听 127.0.0.1:${PORT}`)
  await probe("A 401 鉴权失败", "/case401/v1")
  await probe("B 402 余额不足", "/case402/v1")
  await probe("C 500 服务端错误", "/case500/v1")
  await probe("D 流中途断掉", "/caseMid/v1")
  server.close()
}

main().catch((e) => {
  console.error("探针崩溃:", e)
  server.close()
  process.exit(1)
})
