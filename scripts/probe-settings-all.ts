/**
 * T130：设置页全量交互测试——逐个端点用 UI 实际会发的参数调一遍，
 * 验证后端真的存了。隔离 HOME + 隔离网关，不碰真实配置。
 */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pickFreePort } from "./pick-port.js"

const HOME = mkdtempSync(join(tmpdir(), "yy-settings-"))
const work = join(HOME, "work")
mkdirSync(work, { recursive: true })
mkdirSync(join(HOME, ".yyagent"), { recursive: true })
writeFileSync(join(HOME, ".yyagent", "config.json"), JSON.stringify({
  providers: { test: { baseURL: "https://api.test.com/v1", apiKey: "sk-test" } },
  model: "test/m1",
  permission: "danger-confirm",
  interactiveTimeoutMs: 0, mcpServers: {}, hooks: [],
  backup: { enabled: true, keep: 14, intervalHours: 24 },
  notify: { toast: true, url: "", onlyFailure: false },
}))
const PORT = await pickFreePort()
const BASE = `http://127.0.0.1:${PORT}`
let pass = 0, fail = 0
const check = (label: string, ok: boolean, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${label}${extra ? " — " + extra : ""}`) }
const post = async (p: string, body: unknown) => { const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() } }
const get = async (p: string) => { const r = await fetch(BASE + p); return { status: r.status, data: await r.json() } }

const gw = spawn(process.execPath, ["--import", "tsx", "src/gateway.ts"], {
  cwd: process.cwd(), env: { ...process.env, HOME, USERPROFILE: HOME, YYAGENT_GATEWAY_PORT: String(PORT) }, stdio: "ignore",
})
for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) }); if (r.ok) break } catch {} await new Promise(r => setTimeout(r, 500)) }

// ---- 通知 ----
{
  const r = await post("/api/notify", { url: "https://ntfy.sh/test-topic", onlyFailure: true })
  check("通知：url + onlyFailure 保存", r.data.ok && r.data.notify.url === "https://ntfy.sh/test-topic" && r.data.notify.onlyFailure === true)
  const r2 = await get("/api/backup")
  check("通知：GET 回读 onlyFailure", r2.data.notify?.onlyFailure === true, JSON.stringify(r2.data.notify).slice(0, 100))
}
{ // 通知测试（webhook 不通时应报错而非崩溃）
  const r = await post("/api/notify/test", {})
  check("通知测试：不崩溃", r.status === 200 || r.status === 500, `status=${r.status}`)
}

// ---- 备份 ----
{
  const r = await post("/api/backup/config", { enabled: true, keep: 7, intervalHours: 12 })
  check("备份：config 保存", r.data.ok, JSON.stringify(r.data).slice(0, 80))
  const cfg = JSON.parse(readFileSync(join(HOME, ".yyagent", "config.json"), "utf8"))
  check("备份：keep=7 落盘", cfg.backup?.keep === 7)
}
{ // 立即备份（会产生 zip + bundle）
  const r = await post("/api/backup/run", {})
  check("备份：立即运行", r.data.ok === true || r.data.file, JSON.stringify(r.data).slice(0, 100))
  const backups = (await get("/api/backup")).data.backups ?? []
  check("备份：产物落盘且有 bundle", backups.length > 0 && backups.some((b: { name: string }) => b.name.includes("bundle")), `${backups.length} 个文件`)
}

// ---- 白名单 ----
{
  const r = await post("/api/allowlist/add", { cwd: work, prefix: "npm run" })
  check("白名单：添加", r.data.ok && (r.data.prefixes ?? []).includes("npm run"))
  const r2 = await post("/api/allowlist/remove", { cwd: work, prefix: "npm run" })
  check("白名单：移除", r2.data.ok && !(r2.data.prefixes ?? []).includes("npm run"))
}

// ---- 沙箱 ----
{
  const r = await post("/api/sandbox/config", { enabled: false, image: "node:22-bookworm" })
  check("沙箱：config 保存", r.status === 200)
  const g = await get("/api/sandbox")
  check("沙箱：GET 回读", g.status === 200 && g.data.config !== undefined)
}

// ---- 搜索引擎 ----
{
  const r = await post("/api/search-engine", { engine: "duckduckgo" })
  check("搜索引擎：切换到 duckduckgo", r.status === 200, JSON.stringify(r.data).slice(0, 80))
}

// ---- 模型推理档位（per-model） ----
{
  const spec = "test/m1"
  const r = await post("/api/model/reasoning", { spec, effort: "low" })
  check("推理档位：per-model 保存", r.data.ok && r.data.effort === "low")
  const map = (await get("/api/model/reasoning")).data.map ?? {}
  check("推理档位：GET 回读 map", map[spec] === "low")
  const r2 = await post("/api/model/reasoning", { spec, effort: "" })
  check("推理档位：清除（恢复默认）", r2.data.effort === "")
}

// ---- 诊断导出 ----
{
  const r = await get("/api/diagnostics")
  check("诊断：结构完整（version/runtime/config/sessions/recentErrors/memory）",
    r.data.version && r.data.runtime && r.data.config && r.data.sessions !== undefined && Array.isArray(r.data.recentErrors) && r.data.memory)
  check("诊断红线：不含 apiKey 或 token", !JSON.stringify(r.data).includes("sk-test") && !r.data.config.apiKey && !JSON.stringify(r.data.config).includes("authToken"))
}

// ---- 长任务开关 ----
{
  const sid = ((await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: work }) })).json()) as { id: string }).id
  const r = await post(`/api/longtask`, { sessionId: sid, on: true })
  check("长任务：开关切换", r.status === 200, JSON.stringify(r.data).slice(0, 80))
}

// ---- 钩子 ----
{
  const r = await post("/api/hooks/create", { name: "测试钩子", prompt: "检查输出是否合格" })
  check("钩子：创建", r.status === 200, JSON.stringify(r.data).slice(0, 80))
  const hooks = (await get("/api/hooks")).data.hooks ?? []
  check("钩子：GET 列表包含新建", hooks.some((h: { name: string; id: string }) => h.name === "测试钩子"))
  const testHook = hooks.find((h: { name: string; id: string }) => h.name === "测试钩子")
  if (testHook) {
    const r2 = await post("/api/hooks/toggle", { id: testHook.id })
    check("钩子：启停", r2.status === 200)
    const r3 = await post("/api/hooks/delete", { id: testHook.id })
    check("钩子：删除", r3.status === 200)
  }
}

gw.kill()
console.log(`\n${pass}/${pass + fail} 通过`)
rmSync(HOME, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
