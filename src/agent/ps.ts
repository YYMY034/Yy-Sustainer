import { spawn, spawnSync } from "node:child_process"

/**
 * 共享的 Windows PowerShell 执行层（T44 从 tools.ts 抽出）。
 * tools.ts（bash / 后台任务）与 computer.ts（鼠标键盘模拟）都要跑 PowerShell，
 * 放这里避免两份实现各自演化。
 */

export const MAX_OUTPUT = 30_000

export function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n...[输出截断，共 ${s.length} 字符]` : s
}

/** 统一前置：控制台输出编码改 UTF-8，否则中文经管道回来是乱码 */
export function psCommand(command: string): string {
  return `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`
}

/** 跑一段 PowerShell 命令，收集 stdout+stderr；超时则连子进程树一起杀掉 */
export function runPowerShell(command: string, timeoutMs: number, cwd: string): Promise<string> {
  return new Promise((resolvePromise) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCommand(command)], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    const collect = (d: Buffer) => {
      out += d.toString("utf8")
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    const timer = setTimeout(() => {
      if (child.pid) {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true })
        out += `\n[错误：命令超时（${timeoutMs}ms），已终止]`
      }
    }, timeoutMs)
    child.on("close", () => {
      clearTimeout(timer)
      resolvePromise(truncate(out.trimEnd()) || "(无输出)")
    })
    child.on("error", (e) => {
      clearTimeout(timer)
      resolvePromise(`[启动失败: ${e.message}]`)
    })
  })
}
