// T88 沙箱执行（对标 deepagents 的 "Shell access — run commands in your sandbox of choice"）：
// 检测 Docker → bash 命令在容器内跑（工作区挂载到 /workspace）；无 Docker 回退本机并如实说明。
// 边界先行：白名单/危险判定在宿主侧 gate() 完成后才进沙箱——沙箱不是绕过权限的理由。
import { spawn } from "node:child_process"

let dockerCache: { ok: boolean; at: number } | null = null

/** Docker 可用性探测（结果缓存 10 分钟，失败也算状态——避免每条命令都等超时） */
export function dockerAvailable(): Promise<boolean> {
  if (dockerCache && Date.now() - dockerCache.at < 600_000) return Promise.resolve(dockerCache.ok)
  return new Promise((resolve) => {
    try {
      const p = spawn("docker", ["info", "--format", "ok"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      let out = ""
      const timer = setTimeout(() => { try { p.kill() } catch { /* 忽略 */ } resolve(false) }, 8000)
      p.stdout?.on("data", (d) => { out += String(d) })
      p.on("error", () => { clearTimeout(timer); dockerCache = { ok: false, at: Date.now() }; resolve(false) })
      p.on("exit", (code) => {
        clearTimeout(timer)
        const ok = code === 0 && out.trim() === "ok"
        dockerCache = { ok, at: Date.now() }
        resolve(ok)
      })
    } catch {
      dockerCache = { ok: false, at: Date.now() }
      resolve(false)
    }
  })
}

export interface SandboxResult { output: string; sandboxed: boolean; image: string }

/** 在容器内执行命令：工作区挂载 /workspace 并作为工作目录；超时/退出码语义与本机执行一致 */
export function runInSandbox(command: string, cwd: string, image: string, timeoutMs: number): Promise<SandboxResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "run", "--rm",
      "-v", `${cwd}:/workspace`,
      "-w", "/workspace",
      "--stop-timeout", "5",
      image,
      "bash", "-lc", command,
    ]
    const p = spawn("docker", args, { windowsHide: true })
    let out = ""
    let err = ""
    const timer = setTimeout(() => { try { p.kill("SIGKILL") } catch { /* 忽略 */ } }, Math.max(5_000, timeoutMs))
    p.stdout?.on("data", (d) => { out += String(d) })
    p.stderr?.on("data", (d) => { err += String(d) })
    p.on("error", (e) => { clearTimeout(timer); reject(e) })
    p.on("exit", (code) => {
      clearTimeout(timer)
      const note = `\n[沙箱执行] image=${image} exit=${code ?? "killed"}（工作区已挂载 /workspace）`
      resolve({ output: (out + (err ? `\n[stderr]\n${err}` : "")).trimEnd() + note, sandboxed: true, image })
    })
  })
}
