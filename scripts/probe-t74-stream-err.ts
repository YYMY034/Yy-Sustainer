/**
 * T74 探针：AI SDK 在「上游连不上」时，真实错误到底待在哪儿？
 *  1) fullStream 会不会吐出 {type:"error"} chunk？里面装的是什么？
 *  2) result.text  reject 出来的又是什么？
 * 目的：确认修 runAgentStream 时该从哪取真实 message。
 *
 * 跑法：npx tsx scripts/probe-t74-stream-err.ts
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { streamText } from "ai"

async function probe(name: string, baseURL: string, apiKey: string) {
  console.log(`\n=== ${name}  ${baseURL} ===`)
  const p = createOpenAICompatible({ name: "probe", baseURL, apiKey })
  const result = streamText({ model: p.chatModel("probe-model"), prompt: "你好" })

  const chunkTypes: string[] = []
  const errorChunks: any[] = []
  try {
    for await (const chunk of result.fullStream as any) {
      chunkTypes.push(chunk.type)
      if (chunk.type === "error" || chunk.type === "tool-error") errorChunks.push(chunk)
    }
    console.log("  fullStream 正常结束，chunk 类型:", chunkTypes.join(",") || "(空)")
  } catch (e) {
    console.log("  fullStream 抛出:", describe(e))
  }
  for (const c of errorChunks) {
    console.log(`  [error chunk] type=${c.type} name=${c.error?.name} message=${c.error?.message}`)
    console.log(`    statusCode=${c.error?.statusCode} url=${c.error?.url} responseBody=${String(c.error?.responseBody ?? "").slice(0, 200)}`)
    console.log(`    cause=${describe(c.error?.cause)}`)
  }
  try {
    const t = await result.text
    console.log("  result.text 成功:", JSON.stringify(t))
  } catch (e) {
    console.log("  result.text reject:", describe(e))
  }
}

function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const a = e as any
  const bits = [`${e.name}: ${e.message}`]
  if (a.statusCode) bits.push(`statusCode=${a.statusCode}`)
  if (a.url) bits.push(`url=${a.url}`)
  if (a.responseBody) bits.push(`body=${String(a.responseBody).slice(0, 160)}`)
  if (a.cause) bits.push(`cause=${a.cause?.name ?? ""}:${a.cause?.message ?? a.cause}`)
  return bits.join(" | ")
}

async function main() {
  // 1) 死端口（连接拒绝）—— 本地 8899 无监听
  await probe("死端口", "http://127.0.0.1:8899/v1", "sk-x")
  // 2) 域名解析不了
  await probe("坏域名", "http://no-such-host-yyagentd.invalid/v1", "sk-x")
}

main().catch((e) => {
  console.error("探针崩溃:", e)
  process.exit(1)
})
