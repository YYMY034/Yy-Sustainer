import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * 共享的 Windows PowerShell 执行层（T44 从 tools.ts 抽出）。
 * tools.ts（bash / 后台任务）与 computer.ts（鼠标键盘模拟）都要跑 PowerShell，
 * 放这里避免两份实现各自演化。
 */

export const MAX_OUTPUT = 30_000

/**
 * T116：powershell.exe 一律用**绝对路径**。裸名字依赖 PATH 查找——长驻网关进程的
 * PATH 环境不可控（eval-nightly 实测两次 spawn ENOENT，同环境下直接测试却正常），
 * System32 下的绝对路径是确定性的。找不到再回落裸名字（非 Windows/精简系统兜底）。
 */
export function resolvePowerShell(): string {
  const abs = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  return existsSync(abs) ? abs : "powershell.exe"
}

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
    const exe = resolvePowerShell()
    // T116：cwd 不存在时 spawn 报的 ENOENT 指向的是 **exe**（libuv 把 ERROR_PATH_NOT_FOUND
    // 也映射成 ENOENT）——整个排查期都被它误导。前置校验把误导性报错变成可行动的明确报错。
    if (!existsSync(cwd)) {
      return resolvePromise(`[启动失败：工作目录不存在 ${cwd}——bash 无法在此目录执行任何命令]`)
    }
    const child = spawn(exe, ["-NoProfile", "-NonInteractive", "-Command", psCommand(command)], {
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
