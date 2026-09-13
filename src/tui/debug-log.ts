import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const LOG = join(homedir(), ".yyagent", "tui.log")

export function tlog(...parts: unknown[]): void {
  try {
    mkdirSync(join(LOG, ".."), { recursive: true })
    const line = parts
      .map((p) => {
        if (typeof p === "string") return p
        try {
          return JSON.stringify(p)
        } catch {
          return String(p)
        }
      })
      .join(" ")
    appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${line}\n`)
  } catch {
    /* 日志失败不影响运行 */
  }
}

export function logPath(): string {
  return LOG
}
