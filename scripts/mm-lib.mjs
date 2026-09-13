/**
 * 把 web/index.html 里「T43 思维导图」的纯函数（配色 / 测量 / 布局 / SVG 生成）抠出来在 Node 里直接跑，
 * 并提供一个能安全切源码块的扫描器（供 gateway.ts 路由块测试复用）。
 *
 * 为什么要有这个：本机没有 playwright / 无头浏览器，做不了真实的像素级 E2E。
 * 能做的替代验证有两层——
 *   ① 静态断言（CSS 规则是否生效、关键 JS 片段是否存在、常量与主题变量是否一致）
 *   ② 把渲染函数抠出来喂合成数据，检查**真实输出**（节点数、列坐标单调性、配色分配、垂直居中）
 * check-t43.mjs / check-t43-api.mjs / gen-t43-preview.mjs 共用这份抠取逻辑，避免各处各写一份后漂移。
 */
import fs from "node:fs"

// mmSvg 内部会调 esc()，抠出来后用等价实现注入（与 index.html 里的 esc 一致：只转 & < >）
const ESC = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))

/** 跳过 JS 字符串字面量（'…' "…" `…`，含反斜杠转义）；返回结束后的下标 */
function skipString(src, i) {
  const q = src[i]
  i++
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue }
    if (src[i] === q) return i + 1
    i++
  }
  return i
}

/**
 * 跳过正则字面量；返回结束后的下标（跨行则判定「不是正则」，原样返回）。
 * ⚠ 这是最容易踩的坑：网关里那句 `.replace(/[\\/:*?"<>|\r\n]/g, "_")` 的字符类里有个双引号，
 *   不识别正则的话扫描器会把它当成字符串开头，一路吞到下一个双引号 —— 块配平随即错乱。
 */
function skipRegex(src, i) {
  let j = i - 1
  while (j >= 0 && /\s/.test(src[j])) j--
  const prev = j >= 0 ? src[j] : ""
  // 只有「前面是运算符/括号/冒号/逗号」这类位置才可能是正则，否则是除号
  if (prev && !"(,=:[!&|?{};+-*%<>~^".includes(prev)) return i + 1
  i++ // 吃掉起始 /
  let inClass = false
  while (i < src.length) {
    const c = src[i]
    if (c === "\\") { i += 2; continue }
    if (c === "\n") return i
    if (c === "[") inClass = true
    else if (c === "]") inClass = false
    else if (c === "/" && !inClass) return i + 1
    i++
  }
  return i
}

/**
 * 从 `from` 起按括号配平找代码块结束位置；返回结束下标（不含）。
 * isFn=true  → 以「把深度归零的那个 }」结束（函数体）；参数表的 ) 不算结束。
 * isFn=false → 以深度为 0 时的 ; 或换行结束（const X = …）。
 * 注释 / 字符串 / 模板 / 正则一律跳过，所以里面的 { } " / 都不会干扰配平。
 */
function scanEnd(src, from, isFn) {
  let i = from
  let d = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "/" && src[i + 1] === "/") { const nl = src.indexOf("\n", i); i = nl < 0 ? src.length : nl; continue }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i); i = e < 0 ? src.length : e + 1; continue }
    if (c === "'" || c === '"' || c === "`") { i = skipString(src, i); continue }
    if (c === "/") { i = skipRegex(src, i); continue }
    if (c === "{" || c === "(" || c === "[") { d++; i++; continue }
    if (c === "}" || c === ")" || c === "]") {
      d--
      i++
      // 函数体结束只能是「}」把深度归零——不能拿参数表那个「)」当结尾（否则只抠到签名）
      if (isFn && c === "}" && d === 0) return i
      continue
    }
    if (!isFn && d === 0 && (c === ";" || c === "\n")) return c === ";" ? i + 1 : i
    i++
  }
  return src.length
}

/** 抠出一段具名声明（const X = … / function X() { … } / async function X() { … }） */
export function grab(src, name) {
  // 允许行首缩进：flushTable / flushFence 这类是函数体内的 const 箭头函数，不是顶层声明
  const re = new RegExp(`^[ \\t]*(?:const|let|var)[ \\t]+${name}[ \\t]*=|^[ \\t]*(?:async[ \\t]+)?function[ \\t]+${name}[ \\t]*\\(`, "m")
  const m = re.exec(src)
  if (!m) throw new Error(`未找到声明: ${name}`)
  const head = m[0].trimStart()
  const isFn = head.startsWith("function") || head.startsWith("async")
  return src.slice(m.index, scanEnd(src, m.index, isFn))
}

/**
 * 以 `anchor` 为起点，抠出「锚点 + 紧随其后的配平大括号块」（含花括号）。
 * 注意要连锚点一起带上：只取块的话会丢掉 `if (条件)` 那半句，抽出「永远执行」的假分支。
 */
export function sliceBlock(src, anchor) {
  const at = typeof anchor === "number" ? anchor : src.indexOf(anchor)
  if (at < 0) throw new Error("sliceBlock: 找不到锚点")
  const b = src.indexOf("{", at)
  if (b < 0) throw new Error("sliceBlock: 找不到块起始 {")
  return src.slice(at, scanEnd(src, b, true))
}

/** 抠出 T43 思维导图相关常量与函数（含行解析器），返回可用对象 */
export function mmLib(htmlPath) {
  const src = fs.readFileSync(htmlPath, "utf8")
  const names = ["MM_HUES_DARK", "MM_HUES_LIGHT", "MM_THEME", "MM_LEVEL", "MM_FONT", "mmHex", "mmMix", "mmTextW", "mmSvg", "parseTreeLine"]
  const body = names.map((n) => grab(src, n)).join("\n\n")
  const factory = new Function("esc", `${body}\nreturn { ${names.join(", ")} };`)
  return factory(ESC)
}

/** 取出 index.html 里最大的那段 <script>（整站唯一的业务脚本） */
export function extractScript(html) {
  const all = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  if (!all.length) throw new Error("index.html 里没有 <script>")
  return all.sort((a, b) => b.length - a.length)[0]
}

/** 取出 <style> 内容 */
export function extractStyle(html) {
  const all = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1])
  if (!all.length) throw new Error("index.html 里没有 <style>")
  return all.sort((a, b) => b.length - a.length)[0]
}
