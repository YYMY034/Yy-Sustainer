import { runAgent } from "./agent/loop.js"
import { SIDE_PROTOCOL } from "./agent/side-protocol.js"
import { createSession, persist, type StoredMessage } from "./session/store.js"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const INBOX = join(homedir(), ".yyagent", "inbox.json")

/** 辅助对话向主对话发消息：写 inbox，TUI 轮询消费入队 */
function sendToMain(message: string): void {
  try {
    const arr = existsSync(INBOX) ? (JSON.parse(readFileSync(INBOX, "utf8")) as Array<{ task: string; ts: number }>) : []
    arr.push({ task: message, ts: Date.now() })
    appendFileSync(INBOX, "")
    writeFileSync(INBOX, JSON.stringify(arr, null, 2))
  } catch {
    /* 忽略 */
  }
}

const SYSTEM_SUFFIX = SIDE_PROTOCOL

/** 辅助对话/子代理：后台独立 agent，跑完写一个独立会话（侧栏可见）；SEND: 行自动发给主对话 */
async function main(): Promise<void> {
  const [task, cwd, model] = process.argv.slice(2)
  if (!task) {
    console.error("usage: sidechat.ts <task> [cwd] [model]")
    process.exitCode = 1
    return
  }
  try {
    const r = await runAgent(task, {
      model: model || undefined,
      cwd: cwd || process.cwd(),
      signal: AbortSignal.timeout(600_000),
      system: SYSTEM_SUFFIX.trim(),
    })
    const meta = createSession(cwd || process.cwd(), model || undefined, `⟡ ${task.slice(0, 20)}`)
    const msgs: StoredMessage[] = [
      { role: "user", content: task, ts: Date.now() - 1000 },
      { role: "assistant", content: r.text, ts: Date.now(), steps: r.steps ? [{ name: "run", argsSummary: `${r.steps} 步` }] : undefined },
    ]
    persist(meta, msgs)
    // SEND: 行 → 自动发主对话
    for (const m of r.text.match(/^SEND:\s*(.+)$/gm) ?? []) {
      sendToMain(m.replace(/^SEND:\s*/, "").trim())
    }
  } catch (e) {
    console.error(`[辅助对话失败] ${(e as Error).message}`)
    process.exitCode = 1
  } finally {
    const { closeMcpTools } = await import("./mcp/client.js")
    await closeMcpTools()
    process.exit(process.exitCode ?? 0)
  }
}

void main()
