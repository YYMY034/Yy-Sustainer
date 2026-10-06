/**
 * T130 修正三：主题色 CSS 类方案的 Electron 实测——之前两版（style.setProperty、<style> 注入）
 * 都在用户真实使用中翻车，教训是纯前端改动必须真渲染验证。
 * 流程：隔离 HOME 起隔离网关 → Electron 无头加载 → 注入断言 → 校验输出。
 */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-accent-"))
mkdirSync(join(HOME, ".yyagent"), { recursive: true })
mkdirSync(join(HOME, "work"), { recursive: true })
writeFileSync(join(HOME, ".yyagent", "config.json"), JSON.stringify({
  providers: { test: { baseURL: "https://api.test.com/v1", apiKey: "sk-test" } },
  model: "test/m1", permission: "danger-confirm",
  interactiveTimeoutMs: 0, mcpServers: {}, hooks: [],
}))
const PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`

const gw = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
  cwd: process.cwd(), env: { ...process.env, HOME, USERPROFILE: HOME, YYAGENT_GATEWAY_PORT: String(PORT) }, stdio: "ignore",
})
let gwUp = false
for (let i = 0; i < 40; i++) { try { const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1200) }); if (r.ok) { gwUp = true; break } } catch {} await new Promise((r) => setTimeout(r, 500)) }
if (!gwUp) { console.error("网关没起来"); gw.kill(); process.exit(2) }
console.log(`网关就绪 ${BASE}`)

// electron 入口（cjs）——Windows 下 .bin/electron 是 shell 脚本，用 node_modules/electron/cli.js 直启更稳
const electronCli = join(process.cwd(), "node_modules", "electron", "cli.js")
const el = spawn(process.execPath, [electronCli, join("scripts", "accent-ui-main.cjs")], {
  cwd: process.cwd(),
  env: { ...process.env, HOME, USERPROFILE: HOME, YY_PROBE_URL: BASE, ELECTRON_ENABLE_LOGGING: "0" },
  stdio: ["ignore", "pipe", "pipe"],
})
let buf = ""
el.stdout.on("data", (d) => { buf += String(d); process.stdout.write(d) })
el.stderr.on("data", (d) => process.stderr.write(d))
const code = await new Promise((res) => el.on("exit", res))

const line = buf.split("\n").find((l) => l.includes("YY_PROBE_RESULT:"))
let fail = 0
if (!line) { console.error("\n没拿到断言结果"); fail = 1 } else {
  try {
    const rows = JSON.parse(line.slice(line.indexOf("[")))
    console.log("\n---- 断言结果 ----")
    for (const [label, ok, extra] of rows) {
      if (!ok) fail++
      console.log(`${ok ? "ok  " : "FAIL"} ${label}${extra && !ok ? " — " + extra : ""}`)
    }
  } catch (e) { console.error("结果解析失败:", e.message); fail = 1 }
}
gw.kill()
try { rmSync(HOME, { recursive: true, force: true }) } catch {}
process.exit(fail || code ? 1 : 0)
