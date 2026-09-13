import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import cron from "node-cron"
import { runAgent } from "./agent/loop.js"
import { loadConfig as loadAgentConfig } from "./agent/config.js"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const LOGS = join(PKG_ROOT, "logs")

interface Task {
  name: string;
  cron: string;
  prompt: string;
  cwd?: string;
  model?: string;
  timeoutMs?: number;
  enabled?: boolean;
}

interface Config {
  tasks: Task[];
}

function loadConfig(): Config {
  const file = join(PKG_ROOT, "yyagentd.config.json")
  return JSON.parse(readFileSync(file, "utf8")) as Config
}

function notify(title: string, message: string): void {
  const ps = join(PKG_ROOT, "scripts", "toast.ps1")
  try {
    spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, "-Title", title, "-Message", message], {
      windowsHide: true,
      stdio: "ignore",
    }).unref()
  } catch {
    /* 通知失败不影响任务 */
  }
}

const running = new Set<string>()

async function runOnce(task: Task): Promise<void> {
  if (running.has(task.name)) {
    console.log(`[${new Date().toISOString()}] SKIP ${task.name} (上一轮仍在运行)`)
    return
  }
  running.add(task.name)
  const t0 = Date.now()
  const logDir = join(LOGS, task.name)
  mkdirSync(logDir, { recursive: true })
  try {
    const agentConfig = loadAgentConfig()
    const r = await runAgent(task.prompt, {
      model: task.model,
      cwd: task.cwd ?? PKG_ROOT,
      signal: AbortSignal.timeout(task.timeoutMs ?? agentConfig.taskTimeoutMs ?? 600_000),
    })
      const mark = "OK"
      console.log(`[${new Date().toISOString()}] ${mark} ${task.name} ${r.steps}步 ${Math.round((Date.now() - t0) / 1000)}s`)
      notify(`Yy Sustainer · ${task.name}`, `任务完成（${r.steps} 步）：${r.text.slice(0, 60)}`)
      appendFileSync(join(LOGS, "history.jsonl"), JSON.stringify({
      ts: new Date().toISOString(),
      task: task.name,
      ok: true,
      steps: r.steps,
      durationMs: r.durationMs,
      report: r.text.slice(0, 2000),
    }) + "\n")
  } catch (e) {
    const msg = (e as Error).message
    console.log(`[${new Date().toISOString()}] FAIL ${task.name}: ${msg}`)
    notify(`Yy Sustainer · ${task.name} 失败`, msg.slice(0, 80))
    appendFileSync(join(LOGS, "history.jsonl"), JSON.stringify({
      ts: new Date().toISOString(),
      task: task.name,
      ok: false,
      durationMs: Date.now() - t0,
      error: msg,
    }) + "\n")
  } finally {
    running.delete(task.name)
    const { closeMcpTools } = await import("./mcp/client.js")
    await closeMcpTools()
  }
}

function cmdStart(): void {
  const cfg = loadConfig()
  mkdirSync(LOGS, { recursive: true })
  let scheduled = 0
  for (const t of cfg.tasks) {
    if (t.enabled === false) {
      console.log(`disabled: ${t.name}`)
      continue
    }
    if (!cron.validate(t.cron)) {
      console.error(`bad cron for ${t.name}: ${t.cron}`)
      continue
    }
    cron.schedule(t.cron, () => {
      void runOnce(t)
    })
    scheduled++
    console.log(`scheduled: ${t.name} (${t.cron})`)
  }
  if (scheduled === 0) {
    console.log("没有启用的任务，守护进程待机中（编辑 yyagentd.config.json 后重启生效）")
  }
  console.log("yyagentd running. Ctrl+C to stop.")
  setInterval(() => {}, 1 << 30)
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => process.exit(0))
  }
}

function cmdRun(name: string): void {
  const t = loadConfig().tasks.find((x) => x.name === name)
  if (!t) {
    console.error(`no task: ${name}`)
    process.exitCode = 1
    return
  }
  void runOnce(t)
}

function cmdList(): void {
  for (const t of loadConfig().tasks) {
    const on = t.enabled === false ? "-" : "*"
    console.log(`${on} ${t.name}  ${t.cron}  model=${t.model ?? "(default)"}`)
  }
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === "start") {
  cmdStart()
} else if (cmd === "run" && arg) {
  cmdRun(arg)
} else if (cmd === "list") {
  cmdList()
} else {
  console.log("usage: tsx src/main.ts start | run <task> | list")
  process.exitCode = 1
}
