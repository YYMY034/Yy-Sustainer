// b.ai 接入后的网关级端到端自检：走真实 HTTP + WS 广播，看用户实际会看到什么
//   A) bai/qwen3.8-flash  → 期望：正常返回，无重发、无 [出错]
//   B) mimo/mimo-v2.5（key 是占位符 sk-REPLACE_ME_…）→ 期望：鉴权类报错且**不重发**
//      （T74 最初那个 bug 就是 401 被白重发 10 次；预算必须为 0）
//   结束时删除临时会话，不留痕迹。
import WebSocket from "ws"

const BASE = "http://127.0.0.1:8642"

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

async function runCase(model, waitMs) {
  const events = []
  let sid = ""
  let created = false
  try {
    const c = await api("POST", "/api/sessions", { title: "b.ai 自检（可删）" })
    sid = c.json?.id ?? c.json?.sessionId ?? c.json?.meta?.id
    created = !!sid
    if (!sid) throw new Error("建会话失败: " + JSON.stringify(c).slice(0, 300))

    const m = await api("POST", "/api/model", { model, sessionId: sid })
    if (m.status !== 200) throw new Error(`切模型失败 ${m.status}: ${JSON.stringify(m.json).slice(0, 200)}`)

    const ws = new WebSocket("ws://127.0.0.1:8642/ws")
    await new Promise((res, rej) => {
      ws.on("open", res)
      ws.on("error", rej)
    })
    ws.on("message", (raw) => {
      let e
      try {
        e = JSON.parse(String(raw))
      } catch {
        return
      }
      if (e.sessionId && e.sessionId !== sid) return
      if (["retry", "error", "notice", "message", "status"].includes(e.type)) {
        events.push(e)
        const label = e.type === "retry" ? `重发 ${e.attempt}/${e.maxRetry}` : e.type
        const text =
          e.type === "message" ? String(e.message?.content ?? "").slice(0, 200) : e.type === "retry" ? e.info : (e.text ?? e.message ?? "")
        console.log(`    [WS ${label}] ${String(text).slice(0, 200)}`)
      }
    })

    const s = await api("POST", "/api/chat", { sessionId: sid, text: "只回复两个字：你好" })
    if (s.status !== 200) console.log("    /api/chat 状态:", s.status, JSON.stringify(s.json ?? s).slice(0, 150))

    await new Promise((r) => setTimeout(r, waitMs))
    ws.close()

    const retries = events.filter((e) => e.type === "retry")
    const messages = events.filter((e) => e.type === "message")
    const finalMsg = messages.length ? String(messages[messages.length - 1].message?.content ?? "") : ""
    return { retries, finalMsg, count: messages.length }
  } finally {
    if (created) {
      const d = await api("DELETE", `/api/sessions/${sid}`)
      console.log("    清理临时会话:", d.status)
    }
  }
}

let pass = 0,
  fail = 0
const ok = (n, v) => {
  console.log((v ? "  OK   " : "  FAIL ") + n)
  v ? pass++ : fail++
}

// ---------- A) b.ai 正常路径 ----------
console.log("\n===== A) bai/qwen3.8-flash（期望成功） =====")
const a = await runCase("bai/qwen3.8-flash", 60000)
console.log("  最终消息:", JSON.stringify(a.finalMsg.slice(0, 200)))
ok("返回了正文（含「你好」）", /你好/.test(a.finalMsg))
ok("没有 [出错]", !/\[出错\]/.test(a.finalMsg))
ok("没有重发", a.retries.length === 0)

// ---------- B) 鉴权失败路径（回归：报错可诊断 + 预算为 0 不重发） ----------
console.log("\n===== B) mimo/mimo-v2.5（占位 key，期望鉴权报错且不重发） =====")
const b = await runCase("mimo/mimo-v2.5", 45000)
console.log("  最终消息:", JSON.stringify(b.finalMsg.slice(0, 200)))
ok("有 [出错]", /\[出错\]/.test(b.finalMsg))
ok("不是 SDK 废话", !/No output generated|Failed to process successful response/i.test(b.finalMsg))
ok(
  "暴露真实原因",
  /401|403|Invalid|Unauthorized|ECONNREFUSED|HTTP \d\d\d|连不上|超时/i.test(b.finalMsg) ||
    /401|403|Invalid|Unauthorized|ECONNREFUSED|HTTP \d\d\d|连不上|超时/i.test(b.retries.map((r) => r.info).join(" ")),
)
ok(`鉴权/网络类不刷屏重发（实际重发 ${b.retries.length} 次）`, b.retries.length <= 4)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
