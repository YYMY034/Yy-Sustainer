export interface MouseEvent {
  x: number
  y: number
  kind: "move" | "down" | "up" | "wheel-up" | "wheel-down"
}

import { tlog } from "../tui/debug-log.js"

let mouseOn = false
let mouseEvents = 0

export function mouseEventCount(): number {
  return mouseEvents
}

// 防 EPIPE 崩溃：进程退出/管道断开时的异步 error 事件没有监听会导致崩溃
try {
  process.stdin.on("error", () => {})
  process.stdout.on("error", () => {})
} catch {
  /* 忽略 */
}

// 鼠标启用序列必须写给 stdout（终端方向）——终端才会开启鼠标上报；写 stdin 只会回环成垃圾输入
function safeWrite(s: string): void {
  try {
    if (!process.stdout.destroyed && !process.stdout.writableEnded) process.stdout.write(s)
  } catch {
    /* 管道已断，忽略 */
  }
}

/**
 * 鼠标模式开关：
 * - 开：终端上报鼠标事件 → 可点击按钮/hover 提示；按住 Shift 拖选仍可复制（xterm 惯例）
 * - 关：终端原生行为，自由选择/复制文本
 */
export function setMouseEnabled(on: boolean): void {
  try {
    if (on) {
      safeWrite("\x1b[?1003h\x1b[?1006h")
    } else {
      safeWrite("\x1b[?1003l\x1b[?1006l")
    }
    mouseOn = on
  } catch {
    /* 忽略 */
  }
}

export function isMouseEnabled(): boolean {
  return mouseOn
}

export function attachMouse(onEvent: (e: MouseEvent) => void): (chunk: string) => void {
  const handler = (s: string) => {
    // 原始字节调试：只记录含鼠标序列前缀的 chunk（排查 down 丢失）
    if (s.includes("\x1b[<")) tlog("raw-mouse-chunk", JSON.stringify(s.slice(0, 80)))
    if (!mouseOn) return
    const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
    let m: RegExpExecArray | null
    while ((m = re.exec(s))) {
      const b = Number(m[1])
      const x = Number(m[2]) - 1
      const y = Number(m[3]) - 1
      const isMove = (b & 32) !== 0
      // SGR 滚轮编码：按下位(2)=0 且按钮号 64=上滚 65=下滚（1003/1006 协议惯例）
      let kind: MouseEvent["kind"]
      if (!isMove && b === 64) kind = "wheel-up"
      else if (!isMove && b === 65) kind = "wheel-down"
      else kind = m[4] === "m" ? "up" : isMove ? "move" : "down"
      if (kind === "move") {
        const now = Date.now()
        if (now - lastMove < 40) continue
        lastMove = now
      }
      onEvent({ x, y, kind })
      mouseEvents++
    }
  }
  let lastMove = 0
  return handler
}
