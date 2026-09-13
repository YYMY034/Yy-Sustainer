// Gateway smoke test: chat via REST, stream events via WS.
import WebSocket from "ws"

const sid = process.argv[2]
if (!sid) { console.error("usage: node scripts/ws-smoke.mjs <sessionId>"); process.exit(1) }

const ws = new WebSocket("ws://127.0.0.1:8642/ws")
const counts = {}
const texts = []
let question = null
let done = false

const timer = setTimeout(() => { console.log("TIMEOUT"); finish() }, 120000)

function finish() {
  if (done) return
  done = true
  clearTimeout(timer)
  console.log("message counts:", JSON.stringify(counts))
  const joined = texts.join("")
  console.log("assistant text length:", joined.length)
  console.log("assistant text (first 300):", joined.slice(0, 300).replace(/\n/g, " "))
  if (question) console.log("QUESTION RECEIVED:", JSON.stringify(question).slice(0, 200))
  process.exit(0)
}

ws.on("open", async () => {
  console.log("WS open, sending chat via REST...")
  try {
    const r = await fetch("http://127.0.0.1:8642/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid, text: "请只回复两个字：收到" }),
    })
    console.log("REST /api/chat status:", r.status, await r.text())
  } catch (e) {
    console.log("REST error:", e.message)
    finish()
  }
})
ws.on("message", (raw) => {
  let m
  try { m = JSON.parse(raw.toString()) } catch { return }
  counts[m.type] = (counts[m.type] || 0) + 1
  if (m.type === "text") texts.push(m.delta ?? m.text ?? "")
  if (m.type === "question") { question = m; ws.send(JSON.stringify({ type: "answer", sessionId: sid, answer: "ok" })) }
  if (m.type === "message" && m.message?.role === "assistant") {
    console.log("assistant message received (turn done), steps:", JSON.stringify(m.message.steps?.length ?? 0))
    finish()
  }
  if (m.type === "error") { console.log("ERROR:", JSON.stringify(m).slice(0, 300)); finish() }
})
ws.on("error", (e) => { console.log("WS error:", e.message); process.exit(1) })
