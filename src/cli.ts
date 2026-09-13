import { spawn } from "node:child_process"
import * as readline from "node:readline/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { runAgent } from "./agent/loop.js"
import { loadConfig, addProvider, setDefaultModel } from "./agent/config.js"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

async function onboarding(): Promise<boolean> {
  console.log("首次使用 Yy Sustainer —— 配置你的模型通道（任意 OpenAI 兼容端点）\n")
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const name = ((await rl.question("通道名（回车默认 my）：")) || "my").trim()
    const baseURL = (await rl.question("baseURL（如 https://api.deepseek.com/v1）：")).trim()
    const apiKey = (await rl.question("apiKey：")).trim()
    const model = (await rl.question("模型 ID（如 deepseek-chat）：")).trim()
    if (!baseURL || !apiKey || !model) {
      console.error("\n配置不完整——可稍后手动编辑 ~/.yyagent/config.json")
      process.exitCode = 1
      return false
    }
    addProvider(name, baseURL, apiKey, model)
    setDefaultModel(`${name}/${model}`)
    console.log(`\n已写入 ~/.yyagent/config.json（默认 ${name}/${model}）。重新运行 yyagent 进入 TUI。`)
    return true
  } finally {
    rl.close()
  }
}

function usage(): void {
  console.log(`Yy Sustainer — 独立 TUI agent

用法:
  yyagent                     打开 TUI（对话/会话/模型/任务管理）
  yyagent run "<任务>"        无头执行一次任务
  yyagent run "<任务>" -m <provider/model>   指定模型
  yyagent serve               启动定时任务守护进程（前台）

命令(TUI 内): /help /new /model /models /cwd /tasks /task /search /plugins /exit`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]

  // 首次运行：无有效模型配置 → 引导向导
  try {
    const c = loadConfig()
    if ((!Object.keys(c.providers).length || !c.model) && cmd !== "serve") {
      const ok = await onboarding()
      if (!ok) return
      if (cmd !== "run") return
    }
  } catch {
    /* 配置异常时继续（loadConfig 会自建空配置） */
  }

  if (!cmd || cmd === "tui" || cmd === "chat") {
    const { renderTui } = await import("./tui/App.js")
    renderTui()
    return
  }

  if (cmd === "run") {
    const rest = argv.slice(1)
    let model: string | undefined
    const mi = rest.indexOf("-m")
    if (mi >= 0) {
      model = rest[mi + 1]
      rest.splice(mi, 2)
    }
    const task = rest.join(" ").trim()
    if (!task) {
      usage()
      process.exitCode = 1
      return
    }
    const { loadConfig } = await import("./agent/config.js")
    const timeoutMs = loadConfig().taskTimeoutMs ?? 600_000
    try {
      const r = await runAgent(task, { model, signal: AbortSignal.timeout(timeoutMs) })
      console.log(r.text)
      console.error(`\n[完成] ${r.steps} 步 / ${Math.round(r.durationMs / 1000)}s`)
    } catch (e) {
      const aborted = (e as Error).name === "AbortError" || /abort|timeout/i.test((e as Error).message ?? "")
      console.error(aborted ? `[失败] 任务超时（${Math.round(timeoutMs / 60000)} 分钟）——大任务建议用 daemon 分步跑或调高 taskTimeoutMs` : `[失败] ${(e as Error).message}`)
      process.exitCode = 1
    } finally {
      const { closeMcpTools } = await import("./mcp/client.js")
      await closeMcpTools()
    }
    return
  }

  if (cmd === "serve") {
    const child = spawn(
      process.execPath,
      [join(PKG_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(PKG_ROOT, "src", "main.ts"), "start"],
      { stdio: "inherit", cwd: PKG_ROOT },
    )
    child.on("close", (code) => {
      process.exitCode = code ?? 0
    })
    return
  }

  usage()
  process.exitCode = 1
}

void main()
