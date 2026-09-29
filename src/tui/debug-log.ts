import { homedir } from "node:os"
import { join } from "node:path"
// T92：走带轮转的写入——tui.log 是调试日志，最容易只增不减涨到几百 MB
import { appendLogLine } from "../util/logfile.js"

const LOG = join(homedir(), ".yyagent", "tui.log")

export function tlog(...parts: unknown[]): void {
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
  appendLogLine(LOG, `${new Date().toISOString().slice(11, 23)} ${line}\n`)
}

export function logPath(): string {
  return LOG
}
