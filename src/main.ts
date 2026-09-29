import { mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import cron from "node-cron"
import { runAgent } from "./agent/loop.js"
import { loadConfig as loadAgentConfig } from "./agent/config.js"
import { loadDaemonTasks, type DaemonTask as Task } from "./agent/taskstore.js"
// T92：history.jsonl 走带轮转的写入（原来只增不减）
import { appendLogLine } from "./util/logfile.js"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const LOGS = join(PKG_ROOT, "logs")

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
      appendLogLine(join(LOGS, "history.jsonl"), JSON.stringify({
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
    appendLogLine(join(LOGS, "history.jsonl"), JSON.stringify({
      ts: new Date().toISOString(),
      task: task.name,
      ok: false,
      durationMs: Date.now() - t0,
      error: msg,
    }) + "\n")
  } finally {
    running.delete(task.name)
    // T103：不再在任务收尾时 closeMcpTools——守护进程是**长驻**的，下一个任务/并发任务
    // 还要复用这些连接；任务级全关会把并发任务的 MCP 连接一起杀掉（坑 #6 的 close
    // 是给 cli.ts 那种一次性进程准备的，进程退出前才有必要）。
  }
}

/** T103：网关是否在运行。网关内嵌了同一份 tasks.json 的调度器——
 *  守护进程（npm start + pm2）和网关（watchdog 自动拉起）并存时，同一个 cron 刻钟
 *  两个进程各跑一遍：双倍 token、双倍副作用、双份通知。网关活着时守护进程退让。 */
async function gatewayActive(): Promise<boolean> {
  const port = process.env.YYAGENT_GATEWAY_PORT ?? "8642"
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1200) })
    return r.ok
  } catch {
    return false
  }
}

function cmdStart(): void {
  const tasks = loadDaemonTasks()
  mkdirSync(LOGS, { recursive: true })
  let scheduled = 0
  for (const t of tasks) {
    if (t.enabled === false) {
      console.log(`disabled: ${t.name}`)
      continue
    }
    if (!cron.validate(t.cron)) {
      console.error(`bad cron for ${t.name}: ${t.cron}`)
      continue
    }
    cron.schedule(t.cron, async () => {
      // T103：每个刻钟现探一次——网关可能在守护进程启动之后才被 watchdog 拉起来，
      // 反之网关死了守护进程也要能自动接管，所以不能只在启动时判一次
      if (await gatewayActive()) return
      await runOnce(t)
    })
    scheduled++
    console.log(`scheduled: ${t.name} (${t.cron})`)
  }
  if (scheduled === 0) {
    console.log("没有启用的任务，守护进程待机中（编辑 yyagentd.config.json 后重启生效）")
  }
  console.log("yyagentd running. Ctrl+C to stop.")
  void gatewayActive().then((up) => {
    if (up) console.log("检测到网关正在运行：定时任务由网关调度，本进程仅在网关离线时接管（防双跑）")
  })
  setInterval(() => {}, 1 << 30)
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => process.exit(0))
  }
}

function cmdRun(name: string): void {
  const t = loadDaemonTasks().find((x) => x.name === name)
  if (!t) {
    console.error(`no task: ${name}`)
    process.exitCode = 1
    return
  }
  void runOnce(t)
}

function cmdList(): void {
  for (const t of loadDaemonTasks()) {
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
