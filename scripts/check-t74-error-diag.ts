// T74 断言：API 出错必须暴露真实原因、且不该重试的绝不白重试
//  第一部分：源码结构（接线是否到位）
//  第二部分：真实错误分类（用本地假 provider 造 401/402/500/死端口/流中断，跑真的 describeFailure）
import { readFileSync } from "node:fs"
import http from "node:http"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { streamText } from "ai"
import { describeFailure, retryBudget, asDiagnosedError } from "../src/agent/errors.js"

let pass = 0
let fail = 0
const ok = (n, v) => {
  if (v) {
    pass++
    console.log("OK   " + n)
  } else {
    fail++
    console.log("FAIL " + n)
  }
}
const R = (p) => readFileSync(p, "utf8")

const errors = R("src/agent/errors.ts")
const loop = R("src/agent/loop.ts")
const gateway = R("src/gateway.ts")
const html = R("web/index.html")
const tools = R("src/agent/tools.ts")

console.log("A. 诊断模块本体（errors.ts）")
ok("A1 按 statusCode 分类鉴权/欠费/未找到/限流/服务端", /status === 401 \|\| status === 403\) kind = "auth"/.test(errors) && /status === 402\) kind = "quota"/.test(errors) && /status === 404\) kind = "notfound"/.test(errors) && /status === 429\) kind = "ratelimit"/.test(errors) && /status >= 500\) kind = "server"/.test(errors))
ok("A2 网络错误码单独归类（连接拒绝/重置/DNS/超时）", errors.includes("ECONNREFUSED") && errors.includes("ENOTFOUND") && errors.includes("ETIMEDOUT"))
ok("A3 挖到 AI_RetryError 最内层（errors[]/lastError）", errors.includes("o.errors") && errors.includes("o.lastError"))
ok("A4 剥掉 SDK 英文套话（Failed after N attempts / Last error / Cannot connect to API）", errors.includes("stripSdkNoise") && errors.includes("/Failed after \\d+ attempts\\.\\s*/gi") && errors.includes("/Cannot connect to API:\\s*/gi"))
ok("A5 从 responseBody 里抠 error.message（OpenAI 兼容端点习惯）", errors.includes("JSON.parse(body)"))
ok("A6 只对这四类判可重试：限流/服务端/网络/超时", /RETRYABLE_KINDS = new Set<ErrKind>\(\["ratelimit", "server", "network", "timeout"\]\)/.test(errors))
ok("A7 鉴权/欠费/配置错预算为 0", /kind: ErrKind\): number \{[\s\S]*?case "ratelimit":\s*return 8[\s\S]*?default:[\s\S]*?return 0/.test(errors))
ok("A8 每条错误都带中文自查提示", errors.includes("本地服务未启动") && errors.includes("API Key 无效") && errors.includes("余额或额度不足"))

console.log("B. 引擎侧接住流内真实错误（loop.ts）")
ok("B1 声明 streamError 容器", loop.includes("let streamError: unknown = null"))
ok("B2 fullStream 里捕获 error chunk", /chunk\.type === "error"\) \{\s*[\s\S]{0,200}streamError = \(chunk as \{ error\?: unknown \}\)\.error/.test(loop))
ok("B3 fullStream 正常结束但带 streamError 时也抛出真实原因", loop.includes("if (streamError) throw asDiagnosedError(streamError)"))
ok("B4 catch 优先用 streamError 覆盖 SDK 的废话", loop.includes("throw asDiagnosedError(streamError ?? e)"))
ok("B5 result.text 的 reject 也过一遍诊断", loop.includes("throw asDiagnosedError(e)"))
ok("B6 上游成功但零 token 零步骤 → 明确报错（不再静默落空消息）", loop.includes("上游成功响应但未产出任何 token"))
ok("B7 主调用关掉 SDK 内置重试（不与网关可见重试叠加）", /streamText\(\{[\s\S]{0,200}?maxRetries: 0/.test(loop))

console.log("C. 网关重试判定（gateway.ts）")
ok("C1 不再用 /rate/ 猜限流（旧的 gene·rate·d 误伤已消除）", !gateway.includes("rpm|rate") && !/retryable = \/ECONNREFUSED/.test(gateway))
ok("C2 用 describeFailure + retryBudget 判重试", gateway.includes("const info = describeFailure(e)") && gateway.includes("const budget = retryBudget(info.kind)"))
ok("C3 abort 直接上抛不重发", gateway.includes('if (info.kind === "abort") throw e'))
ok("C4 预算用尽即上抛", gateway.includes("if (budget === 0 || attempt > budget) throw e"))
ok("C5 重发文案带真实原因（截断 110）", gateway.includes("info.message.slice(0, 110)"))
ok("C6 重试计数不再翻倍（for 头不再 attempt++）", /for \(let attempt = 0; ; \) \{/.test(gateway) && !/for \(let attempt = 0; ; attempt\+\+\)/.test(gateway))
ok("C7 落库/广播用真实原因（[出错] err.message）", gateway.includes("`[出错] ${err.message}`"))
ok("C8 abort 判定改用结构化 kind（不再拿文案猜）", gateway.includes('aborted = dinfo.kind === "abort"'))
ok("C9 吐一半才崩：已流出正文随报错一起落库（不白等）", gateway.includes("`${partial}\\n\\n---\\n[出错] 输出中断：${err.message}`"))

console.log("D. 前端：报错只出现在模型输出区（index.html）")
ok("D1 带 sessionId 的 error 不再写 banner", !html.includes('else if (m.type === "error") { if (!m.sessionId || m.sessionId === activeId)'))
ok(
  "D2 协议级错误（无 sessionId）仍用 banner 兜底",
  html.includes('if (!m.sessionId) { $("banner").style.display = "block"; $("banner").textContent = `出错：${m.message}` }'),
)
ok("D3 重发提示仍在输出区流式状态行（T71 不回退）", html.includes("streamStatusText = left > 0 ? `${m.info} · ${left}s 后重试`"))

// ---------- 第二部分：真实错误分类 ----------
const PORT = 18898
const server = http.createServer((req, res) => {
  const url = req.url ?? ""
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    if (url.includes("case401")) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Invalid API key provided", type: "invalid_request_error" } }))
    } else if (url.includes("case402")) {
      res.writeHead(402, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Insufficient balance, please top up" } }))
    } else if (url.includes("case500")) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "internal server error: model overloaded" } }))
    } else if (url.includes("caseMid")) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(
        `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "我正" }, finish_reason: null }] })}\n\n`,
      )
      setTimeout(() => res.destroy(), 100)
    } else {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "model not found" } }))
    }
  })
})

/** 跑一次 streamText，把「真实错误」按引擎同款路径取出来（error chunk 优先，其次抛出物） */
async function grabError(baseURL) {
  const p = createOpenAICompatible({ name: "t74", baseURL, apiKey: "sk-x" })
  const result = streamText({ model: p.chatModel("m"), prompt: "你好" })
  let chunkErr = null
  let thrown = null
  try {
    for await (const chunk of result.fullStream) {
      if (chunk.type === "error") chunkErr = chunk.error
    }
  } catch (e) {
    thrown = e
  }
  if (chunkErr) return chunkErr
  if (thrown) return thrown
  try {
    await result.text
    return null
  } catch (e) {
    return e
  }
}

async function main() {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", () => r()))

  console.log("E. 真实错误 → 分类与文案（跑真的 describeFailure）")
  const cases = [
    { name: "E1 401 鉴权失败", url: `http://127.0.0.1:${PORT}/case401/v1`, kind: "auth", retry: false, has: "Invalid API key" },
    { name: "E2 402 余额不足", url: `http://127.0.0.1:${PORT}/case402/v1`, kind: "quota", retry: false, has: "Insufficient balance" },
    { name: "E3 500 服务端错误（被 SDK 包成 RetryError）", url: `http://127.0.0.1:${PORT}/case500/v1`, kind: "server", retry: true, has: "model overloaded" },
    { name: "E4 404 模型不存在", url: `http://127.0.0.1:${PORT}/case404/v1`, kind: "notfound", retry: false, has: "model not found" },
    { name: "E5 死端口（连接拒绝）", url: "http://127.0.0.1:8899/v1", kind: "network", retry: true, has: "ECONNREFUSED" },
    { name: "E6 流中途断掉", url: `http://127.0.0.1:${PORT}/caseMid/v1`, kind: "network", retry: true, has: "Failed to process successful response" },
  ]
  for (const c of cases) {
    const raw = await grabError(c.url)
    const info = describeFailure(raw)
    ok(`${c.name} → kind=${info.kind}（期望 ${c.kind}）`, info.kind === c.kind)
    ok(`${c.name} → retryable=${info.retryable}（期望 ${c.retry}）`, info.retryable === c.retry)
    ok(`${c.name} → 文案含真实原因 "${c.has}"`, info.message.includes(c.has))
    ok(`${c.name} → 文案不再出现 SDK 废话`, !/No output generated|Failed after \d+ attempts/.test(info.message))
    console.log(`     文案： ${info.message}`)
  }

  console.log("F. 重试预算")
  ok("F1 auth 预算 0（不再白重发）", retryBudget("auth") === 0)
  ok("F2 quota 预算 0", retryBudget("quota") === 0)
  ok("F3 notfound 预算 0", retryBudget("notfound") === 0)
  ok("F4 dns 预算 0", retryBudget("dns") === 0)
  ok("F5 network 预算 >0", retryBudget("network") > 0)
  ok("F6 server 预算 >0", retryBudget("server") > 0)

  console.log("I. 二次诊断幂等（引擎诊断过 → 网关再诊断不许叠加重复文案）")
  for (const c of [cases[0], cases[2], cases[4]]) {
    const raw = await grabError(c.url)
    const once = describeFailure(raw).message
    const twice = describeFailure(asDiagnosedError(raw)).message
    ok(`I  ${c.name} → 二次诊断文案与一次一致`, once === twice)
    ok(`I  ${c.name} → 二次诊断仍保住 kind=${c.kind}`, describeFailure(asDiagnosedError(raw)).kind === c.kind)
    ok(`I  ${c.name} → 二次诊断不重复 SDK 套话`, !/Failed after \d+ attempts/.test(twice))
  }

console.log("G. asDiagnosedError 保真")
const wrapped = asDiagnosedError(new Error("boom"))
ok("G1 命名保留（不破坏 AbortError 判定）", wrapped.name === "Error" && wrapped.message.includes("boom"))
const ab = new Error("The operation was aborted")
ab.name = "AbortError"
ok("G2 AbortError → kind=abort 且不可重试", describeFailure(ab).kind === "abort" && describeFailure(ab).retryable === false)

console.log("H. 全局代理不劫持本地地址（tools.ts 的 502 真凶）")
ok("H1 装了全局代理 dispatcher（EnvHttpProxyAgent + setGlobalDispatcher）", tools.includes("setGlobalDispatcher(new EnvHttpProxyAgent("))
ok("H2 显式声明 noProxy 白名单", tools.includes("LOCAL_NO_PROXY") && tools.includes("noProxy"))
ok("H3 白名单覆盖 127.0.0.1 / localhost / ::1", /LOCAL_NO_PROXY = "[^"]*127\.0\.0\.1[^"]*"/.test(tools) && tools.includes("localhost") && tools.includes("::1"))
ok("H4 config.proxy 与环境变量两条路都带上 noProxy", (tools.match(/noProxy/g) || []).length >= 3)
ok("H5 无代理时不装 dispatcher（不给请求无端加一层）", tools.includes("else if (hasEnvProxy)"))

  server.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error("断言脚本崩溃:", e)
  server.close()
  process.exit(1)
})
