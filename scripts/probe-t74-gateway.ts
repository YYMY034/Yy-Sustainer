// T74 网关级端到端：走真实 HTTP + WS 广播，看用户实际会看到什么
//   1) 建临时会话 → 指定「挂掉的通道」模型 → 发一句话
//   2) 抓 WS 上的 retry / error / message 广播
//   3) 断言：报错文案是真实原因（不是 "No output generated"），且 auth/quota 类不重发
//   4) 结束时删除临时会话，不留痕迹
import WebSocket from "ws"

const BASE = "http://127.0.0.1:8642"
const MODEL = process.env.MODEL || "bai/qwen3.8-flash"
const WAIT_MS = Number(process.env.WAIT_MS || 45000)

async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const t = await r.text()
  try {
    return { status: r.status, json: JSON.parse(t) }
  } catch {
    return { status: r.status, text: t.slice(0, 200) }
  }
}

const events = []
let sid = ""
let created = false

try {
  const c = await api("POST", "/api/sessions", { title: "T74 自检（可删）" })
  sid = c.json?.id ?? c.json?.sessionId ?? c.json?.meta?.id
  created = !!sid
  console.log("临时会话:", sid, "| 状态", c.status)
  if (!sid) throw new Error("建会话失败: " + JSON.stringify(c).slice(0, 300))

  const m = await api("POST", "/api/model", { model: MODEL, sessionId: sid })
  console.log("指定模型:", MODEL, "| 状态", m.status, JSON.stringify(m.json ?? {}).slice(0, 120))

  const ws = new WebSocket("ws://127.0.0.1:8642/ws")
  await new Promise((res, rej) => {
    ws.on("open", res)
    ws.on("error", rej)
  })
  ws.on("message", (raw) => {
    let m2
    try {
      m2 = JSON.parse(String(raw))
    } catch {
      return
    }
    if (m2.sessionId && m2.sessionId !== sid) return // 只看本会话
    if (["retry", "error", "notice", "message", "status"].includes(m2.type)) {
      events.push(m2)
      const label = m2.type === "retry" ? `重发 ${m2.attempt}/${m2.maxRetry}` : m2.type
      const text =
        m2.type === "message" ? String(m2.message?.content ?? "").slice(0, 220) : m2.type === "retry" ? m2.info : (m2.text ?? m2.message ?? "")
      console.log(`  [WS ${label}] ${String(text).slice(0, 240)}`)
    }
  })

  const s = await api("POST", "/api/chat", { sessionId: sid, text: "只回复两个字：你好" })
  console.log("发送:", JSON.stringify(s.json ?? s).slice(0, 150))

  await new Promise((r) => setTimeout(r, WAIT_MS))

  // ---- 判定 ----
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
  const retries = events.filter((e) => e.type === "retry")
  const messages = events.filter((e) => e.type === "message")
  const finalMsg = messages.length ? String(messages[messages.length - 1].message?.content ?? "") : ""
  const allRetryText = retries.map((r) => r.info).join(" | ")

  console.log("\n--- 判定 ---")
  ok("报了错（有 [出错] 消息）", /\[出错\]/.test(finalMsg))
  ok("报的是真实原因（含 ECONNREFUSED/HTTP/Invalid/balance/timeout 之一）", /ECONNREFUSED|HTTP \d\d\d|Invalid|balance|timeout|连不上|余额|超时/i.test(finalMsg))
  ok("不是 SDK 废话", !/No output generated|Failed to process successful response/i.test(finalMsg))
  if (retries.length) {
    ok("重发文案带真实原因", /ECONNREFUSED|HTTP \d\d\d|连不上|余额|超时/i.test(allRetryText))
    ok("重发次数不超预算", retries.length <= Math.max(...retries.map((r) => r.maxRetry ?? 0)))
  } else {
    console.log("（本轮未发生重发）")
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  ws.close()
  process.exitCode = fail ? 1 : 0
} catch (e) {
  console.error("脚本崩溃:", e)
  process.exitCode = 1
} finally {
  if (created) {
    const d = await api("DELETE", `/api/sessions/${sid}`)
    console.log("清理临时会话:", d.status)
  }
  process.exit(process.exitCode ?? 0)
}
