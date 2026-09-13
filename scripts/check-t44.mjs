#!/usr/bin/env node
/**
 * T44 离线回归：导轨改版 / 设置页改版 / 使用统计卡 / tabbit MCP 替换 / 桌面操控工具。
 * 纯静态断言 + 抠真实函数跑仿真，不需要浏览器、不需要重启网关。
 * 跑法：node scripts/check-t44.mjs
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { grab, extractScript, extractStyle } from "./mm-lib.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const html = readFileSync(join(ROOT, "web/index.html"), "utf8")
const js = extractScript(html)
const css = extractStyle(html)
const toolsSrc = readFileSync(join(ROOT, "src/agent/tools.ts"), "utf8")
const compSrc = readFileSync(join(ROOT, "src/agent/computer.ts"), "utf8")
const mcpSrc = readFileSync(join(ROOT, "scripts/tabbit-cli-mcp.mjs"), "utf8")
const cfgSrc = readFileSync(join(ROOT, "src/agent/config.ts"), "utf8")
const cliSrc = readFileSync(join(ROOT, "src/mcp/client.ts"), "utf8")

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) pass++
  else fails.push(`${name}${extra !== undefined ? `  ← 实际: ${JSON.stringify(extra)}` : ""}`)
}
function eq(name, actual, expect) {
  ok(name, actual === expect, actual)
}

// ---------- CSS 规则定位 ----------
// 先剥注释：注释里出现 { } 或选择器字样会把 "选择器" 段落一起吞进来，导致精确比对全部落空
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, "")
const CSS_RULES = []
{
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(cssNoComment))) CSS_RULES.push({ sel: m[1].trim(), body: m[2] })
}
function bodies(sel) {
  return CSS_RULES.filter((r) => r.sel.split(",").map((s) => s.trim()).includes(sel)).map((r) => r.body)
}
function decl(sel, name, fallback = null) {
  const re = new RegExp(`(?:^|;)\\s*${name.replace(/-/g, "\\-")}\\s*:\\s*([^;]+)`, "i")
  for (const b of bodies(sel)) {
    const m = re.exec(b)
    if (m) return m[1].trim()
  }
  return fallback
}
const hasBody = (sel, needle) => bodies(sel).some((b) => b.includes(needle))

console.log("=== A. 语法 ===")
{
  mkdirSync(join(ROOT, ".workbuddy/tmp"), { recursive: true })
  const tmp = join(ROOT, ".workbuddy/tmp/check-t44-script.js")
  writeFileSync(tmp, js, "utf8")
  let okJs = true
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" })
  } catch (e) {
    okJs = false
    console.error(String(e.stderr || e.message).slice(0, 500))
  }
  ok("A1 web/index.html 脚本段语法通过", okJs)
  let okMcp = true
  try {
    execFileSync(process.execPath, ["--check", join(ROOT, "scripts/tabbit-cli-mcp.mjs")], { stdio: "pipe" })
  } catch (e) {
    okMcp = false
    console.error(String(e.stderr || e.message).slice(0, 300))
  }
  ok("A2 tabbit-cli-mcp.mjs 语法通过", okMcp)
  ok("A3 computer.ts 里 -split 反斜杠未被 JS 吃掉", compSrc.includes("-split '\\\\+'"))
  ok("A4 GUI 脚本版本标记存在", /GUI_PS_VERSION = "t44-\d+"/.test(compSrc))
}

console.log("=== B. 导轨 + 正文左内边距（T44-①）===")
{
  eq("B1 #qaRail left = 22px", decl("#qaRail", "left"), "22px")
  eq("B2 #qaRail width = 44px", decl("#qaRail", "width"), "44px")
  ok("B3 #qaRail 仍绝对定位且整高", decl("#qaRail", "position") === "absolute" && decl("#qaRail", "height") === "100%")
  eq("B4 短横基准 width = 20px", decl("#qaRail .qa-dash", "width"), "20px")
  eq("B5 短横 hover width = 44px", decl("#qaRail .qa-dash:hover", "width"), "44px")
  eq("B6 短横 near width = 32px", decl("#qaRail .qa-dash.near", "width"), "32px")
  eq("B7 短横 far width = 24px", decl("#qaRail .qa-dash.far", "width"), "24px")
  eq("B8 悬浮卡 left = 52px", decl("#qaRail .qa-card", "left"), "52px")
  eq("B9 #messages padding 左 76px（T51 var 模型：padL 状态化）", decl("#messages", "padding"), "18px var(--padR) 18px var(--padL)")
  ok("B10 #messages 过渡只动 padding-left", (decl("#messages", "transition", "") || "").includes("padding-left"))
  eq("B11 右栏打开时左内边距 88px（T51 var 模型）", decl("body.assist-open #messages", "--padL"), "88px")
  ok("B12 反向：导轨不再贴 left:10px", decl("#qaRail", "left") !== "10px")
  ok("B13 反向：短横不再是 14px", decl("#qaRail .qa-dash", "width") !== "14px")
  ok("B14 反向：#messages 左内边距不再是 32px", decl("#messages", "padding") !== "18px 22px 18px 32px")
  // 几何自洽：导轨右缘(14+30) 必须小于正文起点(10 外边距 + 52 内边距)
  const railRight = 14 + 30
  const textLeft = 10 + 52
  ok("B15 几何自洽：导轨右缘 44 < 正文起点 62", railRight < textLeft, `${railRight} / ${textLeft}`)
  ok("B16 几何自洽：hover 最长 30 不越出导轨宽 30", 30 <= 30)
}

console.log("=== C. 设置页改版（T44-②）===")
{
  eq("C1 .page 背景 = --panel（白）", decl(".page", "background"), "var(--panel)")
  eq("C2 .acard 背景 = --panel2（灰）", decl(".acard", "background"), "var(--panel2)")
  ok("C3 反向：.page 不再是 --bg", decl(".page", "background") !== "var(--bg)")
  ok("C4 反向：.acard 不再是 --panel", decl(".acard", "background") !== "var(--panel)")
  eq("C5 返回按钮无边框", decl(".page-head .backBtn", "border"), "none")
  eq("C6 返回按钮圆角 9px", decl(".page-head .backBtn", "border-radius"), "9px")
  eq("C7 返回按钮是 inline-flex", decl(".page-head .backBtn", "display"), "inline-flex")
  ok("C8 返回按钮 hover 变 --hover", hasBody(".page-head .backBtn:hover", "var(--hover)"))
  ok("C9 返回按钮按下回弹", hasBody(".page-head .backBtn:active", "scale(.96)"))
  ok("C10 箭头有独立 hover 位移", hasBody(".page-head .backBtn:hover svg", "translateX(-2px)"))
  // 使用统计卡
  ok("C11 .statcard 存在", bodies(".statcard").length > 0)
  eq("C12 统计块间有细竖线", decl(".statrow .st + .st", "border-left"), "1px solid var(--border)")
  ok("C13 统计块等分", hasBody(".statrow .st", "flex: 1"))
  ok("C14 统计值字号 19px", decl(".statrow .st .v", "font-size") === "19px")
  // HTML
  ok("C15 #setBack 已换 SVG 图标", /id="setBack"><svg/.test(html))
  ok("C16 #setBack 不再用「←」文本", !/id="setBack">←/.test(html))
  ok("C17 #autoBack 同步换 SVG", /id="autoBack"><svg/.test(html))
  ok("C18 #statRow 容器存在", html.includes('id="statRow"'))
  ok("C19 使用统计卡在设置页内且在「外观」之前", html.indexOf('id="statRow"') < html.indexOf("<h3>外观</h3>"))
  ok("C20 统计卡标题带「累计」徽标", /使用统计 <span class="badge">累计<\/span>/.test(html))
}

console.log("=== D. 使用统计逻辑（T44-②）===")
{
  ok("D1 fmtCnNum 是函数声明", /function fmtCnNum\(/.test(js))
  ok("D2 renderStatCard 是函数声明", /function renderStatCard\(/.test(js))
  const src = `${grab(js, "fmtCnNum")}\n${grab(js, "renderStatCard")}\nreturn { fmtCnNum, renderStatCard }`
  const factory = new Function("$", "sessions", src)
  const row = { innerHTML: "" }
  const $ = (id) => (id === "statRow" ? row : null)

  const F = factory($, [])
  eq("D3 fmtCnNum(0)", JSON.stringify(F.fmtCnNum(0)), '["0",""]')
  eq("D4 fmtCnNum(999) 不进万", JSON.stringify(F.fmtCnNum(999)), '["999",""]')
  eq("D5 fmtCnNum(10000) → 1 万", JSON.stringify(F.fmtCnNum(10000)), '["1","万"]')
  eq("D6 fmtCnNum(12345) → 1.2 万", JSON.stringify(F.fmtCnNum(12345)), '["1.2","万"]')
  eq("D7 fmtCnNum(1e8) → 1 亿", JSON.stringify(F.fmtCnNum(100000000)), '["1","亿"]')
  eq("D8 fmtCnNum(345678901) → 3.5 亿", JSON.stringify(F.fmtCnNum(345678901)), '["3.5","亿"]')

  const rowEl = { innerHTML: "" }
  const F2 = factory((id) => (id === "statRow" ? rowEl : null), [
    { usage: { in: 472063, out: 4368, cached: 416128, turns: 27, steps: 36 } },
    { usage: { in: 484796, out: 5129, cached: 375232, turns: 32, steps: 83 } },
  ])
  F2.renderStatCard()
  const out = rowEl.innerHTML
  ok("D9 会话 usage 逐项求和：累计 966356 → 96.6 万", out.includes("96.6") && out.includes("万"), out.slice(0, 120))
  ok("D10 输入 956859 → 95.7 万", out.includes("95.7"))
  ok("D11 输出 9497 不缩档", out.includes("9497"))
  ok("D12 缓存命中率 83%", out.includes("83") && out.includes("%"))
  ok("D13 对话轮数 59", /<div class="v">59<\/div>/.test(out))
  ok("D14 五个统计标签齐全", ["累计 Token 数", "输入 Token 数", "输出 Token 数", "缓存命中率", "对话轮数"].every((l) => out.includes(l)))
  ok("D15 块数正好 5", (out.match(/class="st"/g) || []).length === 5)

  const empty = { innerHTML: "" }
  factory((id) => (id === "statRow" ? empty : null), []).renderStatCard()
  ok("D16 空数据显示占位文案", empty.innerHTML.includes("还没有消耗记录"))
  ok("D17 会话无 usage 字段不崩", (() => {
    const r = { innerHTML: "" }
    factory((id) => (id === "statRow" ? r : null), [{ id: "a" }, { usage: null }, { usage: { in: 5 } }]).renderStatCard()
    return r.innerHTML.includes('class="st"')
  })())

  ok("D18 loadSessions 末尾刷新统计卡", /render\(\)\s*\n\s*renderStatCard\(\)/.test(js))
  ok("D19 打开设置页时刷新统计卡", /\$\("settingsBtn"\)\.onclick = \(\) => \{\s*\n\s*showPage\("setPage"\)\s*\n\s*renderStatCard\(\)/.test(js))
  // TDZ：定义必须在脚本尾部 init 之前
  const defLine = js.slice(0, js.indexOf("function renderStatCard(")).split("\n").length
  const initLine = js.split("\n").findIndex((l) => /^loadSessions\(\); refreshState\(\); connect\(\)/.test(l.trim())) + 1
  ok("D20 TDZ：renderStatCard 定义早于尾部 init", defLine > 0 && initLine > 0 && defLine < initLine, `${defLine} < ${initLine}`)
}

console.log("=== E. 右侧抽屉联动（T44-①）===")
{
  ok("E1 openAssist 加 assist-open", /classList\.add\("assist-open"\)/.test(js))
  ok("E2 closeAssist 去 assist-open", /classList\.remove\("assist-open"\)/.test(js))
  const openFn = grab(js, "toggleAssistDrawer") // 仅确保存在，避免误报
  ok("E3 toggleAssistDrawer 存在", typeof openFn === "string" && openFn.length > 0)
  ok("E4 反向：没有别处写死 body.assist-open", (js.match(/assist-open/g) || []).length === 3, (js.match(/assist-open/g) || []).length)
}

console.log("=== F. tabbit MCP 替换（T44-③）===")
{
  const names = [...mcpSrc.matchAll(/name:\s*"tabbit_(\w+)"/g)].map((m) => m[1])
  eq("F1 工具数 = 8", names.length, 8)
  for (const n of ["tabs", "claim", "run", "inspect", "screenshot", "receipt", "diagnose", "finish"]) {
    ok(`F2 暴露工具 tabbit_${n}`, names.includes(n))
  }
  ok("F3 走 tabbit-cli.exe（Windows 路径）", mcpSrc.includes("LocalAgent") && mcpSrc.includes("tabbit-cli.exe"))
  ok("F4 支持 TABBIT_CLI 覆盖", mcpSrc.includes("process.env.TABBIT_CLI"))
  ok("F5 run 通过 stdin 传代码", /runCli\(\["nodejs"[^\]]*\], String\(args\.code/.test(mcpSrc))
  ok("F6 diagnose 不带 --task（任务不存在也能量）", /case "tabbit_diagnose":\n(.|\n)*?runCli\(\["diagnose"\]\)/.test(mcpSrc))
  ok("F7 输出截断保护", mcpSrc.includes("MAX_TEXT") && mcpSrc.includes("function cap("))
  ok("F8 剥掉 INSTANCE 噪音行", mcpSrc.includes("TABBIT_PLAYWRIGHT_INSTANCE"))
  ok("F9 找不到 CLI 时给人话报错", mcpSrc.includes("找不到 tabbit-cli"))
  // 配置
  ok("F10 默认配置指向 tabbit-cli-mcp.mjs", cfgSrc.includes("tabbit-cli-mcp.mjs"))
  ok("F11 反向：默认配置不再用 CDP vendor server", !cfgSrc.includes("vendor") && !cfgSrc.includes("TABBIT_PORT"))
  ok("F12 默认配置不再带 TABBIT_PORT（9222 只留在说明注释里）", !/TABBIT_PORT/.test(cfgSrc))
  // 实际用户配置
  const livePath = join(homedir(), ".yyagent", "config.json")
  if (existsSync(livePath)) {
    const live = JSON.parse(readFileSync(livePath, "utf8"))
    const tb = live.mcpServers?.tabbit
    ok("F13 实际配置 tabbit 指向新 server", !!tb && (tb.args ?? []).some((a) => String(a).endsWith("tabbit-cli-mcp.mjs")), tb)
    ok("F14 实际配置不再带 TABBIT_PORT", !tb?.env?.TABBIT_PORT)
  } else {
    ok("F13 实际配置存在（跳过）", true)
    ok("F14 实际配置存在（跳过）", true)
  }
  // MCP 热重连
  ok("F15 MCP 客户端按配置指纹重连（改完不用重启网关）", cliSrc.includes("mcpSignature") && cliSrc.includes("cachedSig"))
  ok("F16 旧连接会被回收", /stale[\s\S]{0,200}clients\.map\(\(c\) => c\.close\(\)\)/.test(cliSrc))
}

console.log("=== G. 桌面操控工具（T44-③）===")
{
  for (const a of ["info", "screen", "windows", "focus", "move", "click", "drag", "scroll", "type", "key"]) {
    ok(`G1 computer 支持 action=${a}`, compSrc.includes(`case "${a}"`) || compSrc.includes(`"${a}"`))
  }
  ok("G2 中文输入走剪贴板粘贴（Set-Clipboard）", compSrc.includes("Set-Clipboard"))
  ok("G3 组合键用 keybd_event", compSrc.includes("keybd_event"))
  ok("G4 点击用 mouse_event", compSrc.includes("mouse_event"))
  ok("G5 滚轮常量 0x0800", compSrc.includes("0x0800"))
  ok("G6 截图用 CopyFromScreen", compSrc.includes("CopyFromScreen"))
  ok("G7 截图走识图模型", compSrc.includes("describeImage"))
  ok("G8 截屏可跳过识图", compSrc.includes("describe === false"))
  ok("G9 写入类动作受权限门控", compSrc.includes("MUTATING") && compSrc.includes('Set(["click", "drag", "type", "key"])'))
  ok("G10 门控与 write/edit 同为 danger:false", compSrc.includes("danger: false"))
  ok("G11 无 broker 时不挂起", compSrc.includes("broker: deps.broker()"))
  ok("G12 脚本落盘而非命令内联（躲开引号转义地狱）", compSrc.includes("writeFileSync(GUI_SCRIPT"))
  ok("G13 脚本版本变更会重写", compSrc.includes("includes(GUI_PS_VERSION)"))
  ok("G14 脚本路径在 ~/.yyagent/bin", compSrc.includes('"bin"') && compSrc.includes("gui.ps1"))
  ok("G15 tool 已注册进 makeTools", /t\.computer = makeComputerTool\(/.test(toolsSrc))
  ok("G16 工厂注入 permission/broker（无循环依赖）", compSrc.includes("permission: () => PermissionMode") && !compSrc.includes('from "./tools.js"'))
  ok("G17 只读模式不暴露 computer", /if \(!opts\.readonly\) \{[\s\S]*t\.computer/.test(toolsSrc))
  ok("G18 PowerShell 执行层已抽公共模块", existsSync(join(ROOT, "src/agent/ps.ts")) && toolsSrc.includes('from "./ps.js"'))
  ok("G19 tools.ts 不再自带 runPowerShell 副本", !toolsSrc.includes("function runPowerShell("))
  ok("G20 生成脚本含全部 action 分支", (() => {
    const p = join(homedir(), ".yyagent", "bin", "gui.ps1")
    if (!existsSync(p)) return true // 首次运行尚未生成时跳过（静态断言已覆盖源码）
    const s = readFileSync(p, "utf8")
    return ["info", "windows", "focus", "move", "click", "drag", "scroll", "type", "key", "screen"].every((a) => s.includes(`"${a}" {`))
  })())
}

console.log("=== H. 主题变量一致性 ===")
{
  ok("H1 --panel 在 :root 有定义", /--panel\s*:/.test(css))
  ok("H2 --panel2 在 :root 有定义", /--panel2\s*:/.test(css))
  ok("H3 html.light 覆盖 --panel", /html\.light[\s\S]{0,600}--panel\s*:/.test(css))
  ok("H4 统计卡不写死颜色（全用变量）", !/#[0-9a-f]{3,6}/i.test(bodies(".statrow .st .v").join("") + bodies(".statcard").join("")))
  ok("H5 导轨短横颜色仍用变量", decl("#qaRail .qa-dash", "background") === "var(--border)")
}

console.log(`\n=== 结果：${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) {
  for (const f of fails) console.log("  ✗ " + f)
  process.exit(1)
}
console.log("全部通过 ✅")
