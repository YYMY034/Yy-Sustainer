// T74 追查：本地 provider 报 502 Bad Gateway（而非 ECONNREFUSED）——是不是 http_proxy 在转发？
console.log("环境变量:")
for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY"]) {
  console.log(`  ${k}=${process.env[k] ?? "(未设置)"}`)
}
console.log("node:", process.version)

// A) 裸 fetch 打 8899
try {
  const r = await fetch("http://127.0.0.1:8899/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-x" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 2 }),
  })
  console.log("A) 裸 fetch →", r.status, (await r.text()).slice(0, 200))
} catch (e) {
  console.log("A) 裸 fetch → 抛错:", (e as any)?.cause?.code ?? (e as Error).message)
}

// B) 裸 fetch 打代理端口本身
try {
  const r = await fetch("http://127.0.0.1:49743/", { method: "GET" })
  console.log("B) 代理端口 49743 →", r.status, (await r.text()).slice(0, 120))
} catch (e) {
  console.log("B) 代理端口 49743 → 抛错:", (e as any)?.cause?.code ?? (e as Error).message)
}

// C) 显式指定代理去打 8899（若走代理，会看到代理的回应而不是 ECONNREFUSED）
try {
  const { ProxyAgent } = await import("undici")
  const r = await fetch("http://127.0.0.1:8899/v1/chat/completions", {
    method: "POST",
    dispatcher: new ProxyAgent("http://127.0.0.1:49743"),
    headers: { "content-type": "application/json", authorization: "Bearer sk-x" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 2 }),
  } as RequestInit)
  console.log("C) 经代理 →", r.status, (await r.text()).slice(0, 200))
} catch (e) {
  console.log("C) 经代理 → 抛错:", (e as any)?.cause?.code ?? (e as Error).message)
}

// D) AI SDK streamText 打 8899（复现引擎路径）
try {
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible")
  const { streamText } = await import("ai")
  const p = createOpenAICompatible({ name: "local", baseURL: "http://127.0.0.1:8899/v1", apiKey: "sk-x" })
  const res = streamText({ model: p.chatModel("m"), prompt: "hi" })
  let err: any = null
  for await (const ch of res.fullStream as any) if (ch.type === "error") err = ch.error
  const d = err?.errors?.at(-1) ?? err
  console.log("D) AI SDK →", d?.name, "| status:", d?.statusCode, "| msg:", String(d?.message).slice(0, 160))
} catch (e) {
  console.log("D) AI SDK → 抛错:", (e as Error).message.slice(0, 160))
}
process.exit(0)
