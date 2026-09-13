import { PassThrough } from "node:stream"

/**
 * 过滤后的 stdin：
 * 真实 stdin → 摘除 SGR 鼠标序列（\x1b[<b;x;yM / m）→ 喂给 Ink 的键盘解析器。
 * Ink 不认识 SGR 鼠标序列，不过滤的话会被当字符塞进输入框。
 *
 * 实现是逐字符扫描的状态机，而不是正则替换。原因（2026-09-09 实测踩坑）：
 * 鼠标移动会以高频 chunk 发送 \x1b[<35;…M，chunk 边界可能把序列切成两半；
 * 此时用户按键的字节会粘在半截序列后面（同一 chunk 或下一 chunk）。
 * 正则方案在这种粘连下会把按键连同半截序列一起整串转发，
 * Ink 的 CSI 解析器把它当一条非法序列连按键一起吞掉——表现为"打字没反应"。
 * 扫描式解析遇到「\x1b[< 后跟非参数字符」时只丢弃半截鼠标序列本身，保留后续按键。
 *
 * 同时保留原始数据的镜像回调（给鼠标解析器），避免两个 listener 抢原始流的歧义。
 */
export function createFilteredStdin(onRaw?: (chunk: string) => void): PassThrough {
  const virtual = new PassThrough()
  const real = process.stdin
  let pending = ""

  // 从 pending 的 i 位置起扫描；返回 [输出到 Ink 的文本, 新的 pending 起点含义]
  function scan(s: string): string {
    pending += s
    let out = ""
    let i = 0
    while (i < pending.length) {
      const idx = pending.indexOf("\x1b[<", i)
      if (idx === -1) {
        // 无鼠标序列开始符；但尾部可能是被切断的 \x1b / \x1b[ / \x1b[<，挂起等下个 chunk
        const rest = pending.slice(i)
        const tail = rest.match(/\x1b(\[<?)?$/)
        if (tail && typeof tail.index === "number") {
          out += rest.slice(0, tail.index)
          pending = rest.slice(tail.index)
          return out
        }
        out += rest
        pending = ""
        return out
      }
      // 有鼠标序列开始符：先输出它之前的普通字符
      out += pending.slice(i, idx)
      // 从 \x1b[< 后扫描参数区 [\d;]*
      let j = idx + 3
      while (j < pending.length && /[\d;]/.test(pending[j])) j++
      if (j >= pending.length) {
        // chunk 在参数区中途结束：挂起整个半截序列
        pending = pending.slice(idx)
        return out
      }
      const fin = pending[j]
      if (fin === "M" || fin === "m") {
        // 完整鼠标序列：整体丢弃
        i = j + 1
        continue
      }
      // 参数区被非终结字符打断（按键字节粘连）：丢弃半截序列本身，保留按键。
      // 若其后紧跟 [\d;]+[Mm]（被切开序列的残余尾巴），一并丢弃，避免尾巴漏成文本。
      const glue = pending.slice(j).match(/^([^\d;]*)([\d;]+[Mm])/)
      if (glue) {
        out += glue[1] // 粘连的按键字符保留
        i = j + glue[0].length // 按键 + 残余尾巴整体跳过
      } else {
        i = j
      }
    }
    pending = ""
    return out
  }

  real.on("data", (chunk: Buffer | string) => {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    if (onRaw) onRaw(s)
    const clean = scan(s)
    if (clean) virtual.write(clean)
  })

  real.on("close", () => virtual.end())
  real.on("error", () => {})

  // Ink 会调用的 stdin 方法代理到真实流
  const proxy = virtual as unknown as Record<string, unknown>
  proxy.setRawMode = (v: boolean) => {
    try {
      real.setRawMode(v)
    } catch {
      /* 无 TTY 时忽略 */
    }
    return virtual
  }
  proxy.pause = () => {
    real.pause()
    return virtual
  }
  proxy.resume = () => {
    real.resume()
    return virtual
  }
  proxy.isTTY = real.isTTY
  proxy.ref = () => real.ref?.()
  proxy.unref = () => real.unref?.()

  return virtual
}
