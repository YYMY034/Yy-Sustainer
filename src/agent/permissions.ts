import type { QuestionBroker } from "./ask.js"

/**
 * 权限三档总开关（用户可配）：
 * - confirm-all:    全部更改前确认（写文件/编辑/bash 都要先问）
 * - danger-confirm: 只对危险操作（sudo/rm -rf/提权/密钥类）确认，其余放行
 * - full-auto:      完全允许，不做任何确认
 *
 * 交互模式（有 broker）：确认 = ask 用户，拒绝则工具返回拒绝说明。
 * 无人值守（无 broker）：危险操作一律拒绝（绝不挂起），其余放行。
 */
export type PermissionMode = "confirm-all" | "danger-confirm" | "full-auto"

const DANGER_PATTERNS: RegExp[] = [
  /(^|\s)sudo\b/,
  /(^|\s)rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)/,
  /(^|\s)chown\b/,
  /(^|\s)chmod\s+777/,
  /(^|\s)takeown\b/,
  /\bAPI_KEY\s*=/i,
  /\b[A-Z_]*TOKEN\s*=/,
]

export function isDangerCommand(command: string): boolean {
  return DANGER_PATTERNS.some((re) => re.test(command))
}

export interface GateParams {
  tool: string
  summary: string
  danger: boolean
  mode: PermissionMode
  broker?: QuestionBroker
}

export async function gate({ tool, summary, danger, mode, broker }: GateParams): Promise<string | null> {
  if (mode === "full-auto") return null
  if (mode === "danger-confirm" && !danger) return null
  // 到这里：需要确认
  if (!broker) {
    return danger ? `[权限拒绝] ${tool} 属危险操作，无人值守模式下被拒绝：${summary}` : null
  }
  const answer = await broker.ask({
    question: `允许执行 ${tool}？\n${summary}`,
    options: ["允许（y）", "拒绝"],
    defaultOption: "允许（y）",
  })
  if (/^(y|yes|是|允许|ok|允许（y）)/i.test(answer.trim())) return null
  return `[用户拒绝] ${tool} 操作被用户拒绝：${summary}`
}
