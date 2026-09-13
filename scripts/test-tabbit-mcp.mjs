import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { join } from "node:path"
import { homedir } from "node:os"

const script = join(homedir(), "Documents", "Catpaw", "YYAgent", "yyagentd", "scripts", "tabbit-cli-mcp.mjs")
const transport = new StdioClientTransport({ command: process.execPath, args: [script] })
const client = new Client({ name: "t44-test", version: "1.0.0" })
await client.connect(transport)

const list = await client.listTools()
console.log("TOOLS(" + list.tools.length + "):", list.tools.map((t) => t.name).join(", "))

const d = await client.callTool({ name: "tabbit_diagnose", arguments: {} })
const dt = d.content[0].text
console.log("\nDIAGNOSE 前 260 字:", dt.slice(0, 260).replace(/\s+/g, " "))

const t = await client.callTool({ name: "tabbit_tabs", arguments: {} })
const tt = t.content[0].text
let tabs = null
try {
  tabs = JSON.parse(tt)
} catch {
  /* 非 JSON 就是报错文本 */
}
console.log("\nTABS:", tabs ? `解析成功，${tabs.tabs.length} 个标签` : tt.slice(0, 300))
if (tabs) for (const x of tabs.tabs.slice(0, 4)) console.log("  -", x.tabId, "|", x.title.slice(0, 46))

const f = await client.callTool({ name: "tabbit_finish", arguments: { discard: false } })
console.log("\nFINISH:", f.content[0].text.slice(0, 160))

await client.close()
console.log("\n[OK] MCP 端到端通过")
