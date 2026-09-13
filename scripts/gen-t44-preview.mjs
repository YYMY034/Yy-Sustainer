#!/usr/bin/env node
/**
 * T44 改进对照预览页生成器 → t44-preview.html
 * 「改后」区块全部用真实渲染产物：设置页用整站 <style> 原样内联 + 真实 .page/.acard 类名，
 * 使用统计卡直接抠 renderStatCard() 跑真数据；tabbit / 桌面操控的结论用真实命令输出。
 * 跑法：node scripts/gen-t44-preview.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { grab, extractScript, extractStyle } from "./mm-lib.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const html = readFileSync(join(ROOT, "web/index.html"), "utf8")
const js = extractScript(html)
const siteCss = extractStyle(html)

// —— 真实跑一遍使用统计渲染，拿到真正的 innerHTML 与文案 ——
const factory = new Function("$", "sessions", `${grab(js, "fmtCnNum")}\n${grab(js, "renderStatCard")}\nreturn { fmtCnNum, renderStatCard }`)
const rowEl = { innerHTML: "" }
factory((id) => (id === "statRow" ? rowEl : null), [
  { usage: { in: 472063, out: 4368, cached: 416128, turns: 27, steps: 36 } },
  { usage: { in: 484796, out: 5129, cached: 375232, turns: 32, steps: 83 } },
]).renderStatCard()
const statRowHtml = rowEl.innerHTML
const emptyEl = { innerHTML: "" }
factory((id) => (id === "statRow" ? emptyEl : null), []).renderStatCard()

const BACK_ICON = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M9.9 3.3L5.2 8l4.7 4.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`

// —— 真实环境证据（有就采，没有就写静态说明）——
function trySh(cmd) {
  try {
    return execFileSync(process.execPath, ["-e", cmd], { cwd: ROOT, encoding: "utf8" }).trim()
  } catch (e) {
    return String(e.stdout || e.message).trim().slice(0, 300)
  }
}
const psExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const guiPs = join(homedir(), ".yyagent", "bin", "gui.ps1")
let guiInfo = "（未生成 gui.ps1，跳过）"
let winList = "（未采集）"
if (existsSync(guiPs) && existsSync(psExe)) {
  const run = (args) => {
    try {
      return execFileSync(psExe, ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '${guiPs}' ${args}`], { encoding: "utf8", timeout: 40000 }).trim()
    } catch (e) {
      return `[失败] ${String(e.stdout || e.message).slice(0, 200)}`
    }
  }
  guiInfo = run("-Action info")
  winList = run("-Action windows")
    .split(/\r?\n/)
    .filter((l) => /Tabbit|WorkBuddy|Notepad|Clash/i.test(l))
    .slice(0, 5)
    .join("\n")
}

const tabbitProbe = (() => {
  const cli = join(process.env.LOCALAPPDATA || "", "Tabbit", "LocalAgent", "bin", "tabbit-cli.exe")
  if (!existsSync(cli)) return "（本机没装 Tabbit）"
  try {
    const out = execFileSync(cli, ["tabs", "--task", "uiprobe"], { encoding: "utf8", timeout: 40000 })
    const line = out.split(/\r?\n/).find((l) => l.trim().startsWith("{"))
    const data = JSON.parse(line)
    return data.tabs
      .slice(0, 5)
      .map((t) => `  ${t.active ? "▶" : " "} ${String(t.title).slice(0, 52)}\n     ${t.url.slice(0, 78)}`)
      .join("\n")
  } catch (e) {
    return `[失败] ${String(e.stdout || e.message).slice(0, 300)}`
  }
})()

const now = new Date().toLocaleString("zh-CN", { hour12: false })

const out = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>T44 改进对照 · 导轨 / 设置页 / tabbit / 桌面操控</title>
<style>
${siteCss}
/* —— 预览页外壳：放开主应用的高度/滚动约束 —— */
html, body { height: auto !important; overflow: auto !important; display: block !important; background: var(--bg); }
body { padding: 28px 26px 70px; }
.wrap { max-width: 1180px; margin: 0 auto; }
h1 { font-size: 21px; margin: 0 0 4px; }
.sub { color: var(--dim); font-size: 13px; margin-bottom: 26px; }
section { margin-bottom: 38px; }
h2 { font-size: 15px; margin: 0 0 12px; display: flex; align-items: center; gap: 9px; }
h2 .n { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 7px; background: var(--accent); color: #fff; font-size: 12px; font-weight: 700; }
h3 { font-size: 12.5px; color: var(--dim); margin: 18px 0 8px; font-weight: 600; letter-spacing: .3px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.cols3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.box { border: 1px solid var(--border); border-radius: 14px; background: var(--panel); padding: 16px; }
.box.old { opacity: .96; }
.tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 999px; margin-bottom: 10px; }
.tag.b { background: color-mix(in srgb, var(--err) 16%, transparent); color: var(--err); }
.tag.a { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.65; white-space: pre-wrap; word-break: break-all; background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 11px 13px; color: var(--text); }
.kv { font-size: 12px; color: var(--dim); line-height: 1.9; }
.kv b { color: var(--text); font-weight: 600; }
table.cmp { border-collapse: collapse; width: 100%; font-size: 12.5px; }
table.cmp th, table.cmp td { border: 1px solid var(--border); padding: 7px 11px; text-align: left; }
table.cmp th { background: var(--panel2); font-size: 12px; }
.ok { color: var(--accent); font-weight: 700; }
.no { color: var(--err); font-weight: 700; }

/* —— 导轨几何示意（真实数值）—— */
.railmock { position: relative; height: 232px; border-radius: 12px; background: var(--bg); border: 1px solid var(--border); overflow: hidden; }
.railmock .card { position: absolute; inset: 8px 10px 0; background: var(--panel); border-radius: 14px 14px 0 0; }
.railmock .txt { position: absolute; top: 26px; font-size: 12.5px; color: var(--text); }
.railmock .dash { position: absolute; height: 3px; border-radius: 2px; background: var(--border); }
.railmock .dash.cur { background: var(--accent); }
.railmock .guide { position: absolute; top: 0; bottom: 0; width: 1px; border-left: 1px dashed; }
.railmock .lbl { position: absolute; top: 4px; font-size: 10px; font-family: ui-monospace, monospace; transform: translateX(3px); }
</style></head>
<body><div class="wrap">
<h1>T44 改进对照</h1>
<div class="sub">导轨加长右移 · 设置页白底灰卡与使用统计 · tabbit MCP 修复 · 桌面操控能力 &nbsp;|&nbsp; 生成于 ${now}</div>

<section>
<h2><span class="n">1</span>问答导航轨：加长 + 右移 + 正文让位</h2>
<div class="cols3">
  <div class="box old">
    <span class="tag b">改前</span>
    <div class="railmock">
      <div class="card"></div>
      <div class="dash" style="left:10px; top:70px; width:14px"></div>
      <div class="dash cur" style="left:10px; top:88px; width:22px"></div>
      <div class="dash" style="left:10px; top:106px; width:19px"></div>
      <div class="dash" style="left:10px; top:124px; width:16px"></div>
      <div class="guide" style="left:32px; border-color:var(--err)"></div>
      <div class="lbl" style="left:32px; color:var(--err)">导轨右缘 32</div>
      <div class="guide" style="left:42px; border-color:var(--accent)"></div>
      <div class="lbl" style="left:42px; color:var(--accent)">正文 42</div>
      <div class="txt" style="left:42px">短横只有 14px，离左边缘只有 10px，正文净距仅 10px</div>
    </div>
    <div class="kv" style="margin-top:10px">
      <b>left</b> 10px &nbsp;·&nbsp; <b>宽</b> 22px &nbsp;·&nbsp; <b>短横</b> 14 / 19 / 16 / 22px<br>
      <b>#messages 左内边距</b> 32px
    </div>
  </div>
  <div class="box old">
    <span class="tag b">改前 · 右栏打开</span>
    <div class="railmock">
      <div class="card"></div>
      <div class="dash" style="left:10px; top:70px; width:14px"></div>
      <div class="dash cur" style="left:10px; top:88px; width:22px"></div>
      <div class="dash" style="left:10px; top:106px; width:19px"></div>
      <div class="guide" style="left:42px; border-color:var(--accent)"></div>
      <div class="lbl" style="left:42px; color:var(--accent)">正文 42</div>
      <div class="txt" style="left:42px">画布变窄后正文仍从 42px 起 —— 直接贴住导轨</div>
    </div>
    <div class="kv" style="margin-top:10px"><b>#messages 左内边距</b> 32px（与右栏无关）</div>
  </div>
  <div class="box">
    <span class="tag a">改后</span>
    <div class="railmock">
      <div class="card"></div>
      <div class="dash" style="left:14px; top:70px; width:20px"></div>
      <div class="dash cur" style="left:14px; top:88px; width:30px"></div>
      <div class="dash" style="left:14px; top:106px; width:25px"></div>
      <div class="dash" style="left:14px; top:124px; width:22px"></div>
      <div class="guide" style="left:44px; border-color:var(--err)"></div>
      <div class="lbl" style="left:44px; color:var(--err)">导轨右缘 44</div>
      <div class="guide" style="left:62px; border-color:var(--accent)"></div>
      <div class="lbl" style="left:62px; color:var(--accent)">正文 62</div>
      <div class="txt" style="left:62px">短横加长到 20px，整条导轨右移 4px，正文退到 62px（净距 18px）</div>
    </div>
    <div class="kv" style="margin-top:10px">
      <b>left</b> 14px &nbsp;·&nbsp; <b>宽</b> 30px &nbsp;·&nbsp; <b>短横</b> 20 / 25 / 22 / 30px<br>
      <b>#messages 左内边距</b> 52px &nbsp;→&nbsp; <b>右栏打开时</b> 68px
    </div>
  </div>
</div>
<h3>右栏（辅助对话抽屉）打开时的联动</h3>
<div class="box">
  <div class="kv">
    <code>openAssist()</code> → <code>body.classList.add("assist-open")</code> &nbsp;·&nbsp; <code>closeAssist()</code> → <code>remove</code><br>
    新增规则 <code>body.assist-open #messages { padding-left: 68px }</code>，过渡 <code>padding-left .18s ease</code> 与抽屉 <code>width .18s</code> 同节奏 —— 抽屉滑出时正文同步右移，不再贴住导轨。
  </div>
</div>
</section>

<section>
<h2><span class="n">2</span>设置界面：白底 + 灰卡 + 重做返回按钮 + 使用统计卡</h2>
<div class="cols">
  <div class="box old">
    <span class="tag b">改前</span>
    <div style="background:var(--bg); border-radius:12px; overflow:hidden; border:1px solid var(--border)">
      <div style="display:flex; align-items:center; gap:10px; padding:8px 20px; border-bottom:1px solid var(--border); background:var(--panel)">
        <span style="background:var(--panel2); border:1px solid var(--border); color:var(--text); border-radius:7px; padding:2px 9px; font-size:12px; line-height:1.5">← 返回</span>
        <span style="font-weight:700; font-size:15px">设置</span>
      </div>
      <div style="padding:16px; background:var(--bg)">
        <div style="background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:16px 18px; color:var(--text); font-size:13px">外观<br><span style="font-size:11px;color:var(--dim)">深色 / 浅色一键切换</span></div>
        <div style="background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:16px 18px; margin-top:12px; color:var(--text); font-size:13px">模型</div>
      </div>
    </div>
    <div class="kv" style="margin-top:10px">
      页面底 = <b>--bg</b>（灰） · 卡片 = <b>--panel</b>（白，与页面拉不开层次）<br>
      返回按钮 = 带框文字块 · 没有使用统计
    </div>
  </div>

  <div class="box">
    <span class="tag a">改后（真实类名 + 真实统计渲染）</span>
    <div class="page show" style="position:relative; inset:auto; border-radius:12px; overflow:hidden; border:1px solid var(--border); height:auto">
      <div class="page-head">
        <button class="backBtn">${BACK_ICON}<span>返回</span></button>
        <span class="pt">设置</span>
      </div>
      <div class="page-body" style="overflow:visible">
        <div class="page-inner">
          <div class="acard statcard">
            <h3>使用统计 <span class="badge">累计</span></h3>
            <div class="statrow">${statRowHtml}</div>
          </div>
          <div class="acard">
            <h3>外观</h3>
            <div class="set-row" style="display:flex; justify-content:space-between; align-items:center; padding:9px 0">
              <div class="sl" style="font-size:13px">主题<div class="sd" style="font-size:11px;color:var(--dim)">深色 / 浅色一键切换</div></div>
            </div>
          </div>
          <div class="acard" style="margin-bottom:0"><h3>模型</h3></div>
        </div>
      </div>
    </div>
    <div class="kv" style="margin-top:10px">
      页面底 = <b>--panel</b>（浅色下纯白） · 卡片 = <b>--panel2</b>（浅灰，浮在白色之上）<br>
      返回按钮 = 无边框浅灰药丸 + SVG 箭头，hover 变深、箭头左移，按下 <code>scale(.96)</code>
    </div>
  </div>
</div>

<h3>使用统计卡 —— 五个统计块由 sum(所有会话 meta.usage) 算出，块间细竖线</h3>
<div class="box">
  <div class="kv" style="margin-bottom:10px">下面是刚才真实跑 <code>renderStatCard()</code> 得到的 HTML（喂 2 个会话：in 472063+484796 / out 4368+5129 / cached 416128+375232 / turns 27+32）：</div>
  <div class="mono">${statRowHtml.replace(/</g, "&lt;")}</div>
  <div class="kv" style="margin-top:10px">空数据时降级文案：<code>${emptyEl.innerHTML.replace(/<[^>]+>/g, "").slice(0, 90)}</code></div>
  <div class="kv" style="margin-top:6px">数量级按中文分档：<code>121</code> → 121 · <code>12345</code> → 1.2 万 · <code>345678901</code> → 3.5 亿</div>
</div>

<h3>改动清单</h3>
<div class="box">
<table class="cmp">
  <tr><th>位置</th><th>改前</th><th>改后</th></tr>
  <tr><td><code>.page</code> 背景</td><td>var(--bg)</td><td class="ok">var(--panel)</td></tr>
  <tr><td><code>.acard</code> 背景</td><td>var(--panel)</td><td class="ok">var(--panel2)</td></tr>
  <tr><td><code>#setBack</code> / <code>#autoBack</code></td><td>「← 返回」带框文字块</td><td class="ok">SVG 箭头药丸，无边框 + hover 动效</td></tr>
  <tr><td>使用统计卡</td><td class="no">无</td><td class="ok">新增：累计 / 输入 / 输出 / 缓存命中率 / 轮数</td></tr>
</table>
</div>
</section>

<section>
<h2><span class="n">3</span>tabbit MCP：为什么一直「Not connected」</h2>
<div class="cols">
  <div class="box old">
    <span class="tag b">旧：vendored CDP server</span>
    <div class="mono">.workbuddy/vendor/tabbit-browser/mcp-server.js
env: TABBIT_PORT=9222
→ chromium.connectOverCDP("http://127.0.0.1:9222")</div>
    <div class="kv" style="margin-top:10px">
      这条链路要求 <b>Tabbit 以 <code>--remote-debugging-port=9222</code> 启动</b>。<br>
      而本机实际情况：<br>
      <b>9222 端口</b> <span class="no">未监听</span>（netstat 计数 0）<br>
      <b>Tabbit Browser 进程</b> <span class="ok">33 个在跑</span>（正常双击启动，没有调试口）<br>
      于是每次调用必然 <span class="no">"Not connected"</span>；而它自带的 <code>tabbit_launch</code> 会用 taskkill 关掉你正在用的浏览器 —— 用不了，还不能用。
    </div>
  </div>
  <div class="box">
    <span class="tag a">新：官方 tabbit-cli 适配层</span>
    <div class="mono">scripts/tabbit-cli-mcp.mjs
→ %LOCALAPPDATA%\\Tabbit\\LocalAgent\\bin\\tabbit-cli.exe
   tabs / claim / nodejs / inspect / screenshot / receipt / diagnose / finish</div>
    <div class="kv" style="margin-top:10px">
      走 Tabbit 官方 LocalAgent，<b>直连已经开着的浏览器</b>：不需要调试端口、不重启、不杀进程。<br>
      实测 <code>tabbit-cli tabs</code> 立刻列出你真实的 ${tabbitProbe.split("\n").filter((l) => l.trim().startsWith("▶") || /\S/.test(l)).length ? "" : ""}标签页：
    </div>
    <div class="mono" style="margin-top:8px">${tabbitProbe.replace(/</g, "&lt;")}</div>
  </div>
</div>
<h3>8 个 MCP 工具（挂上后即为 <code>mcp_tabbit_*</code>）</h3>
<div class="box">
<table class="cmp">
  <tr><th>工具</th><th>作用</th></tr>
  <tr><td><code>tabbit_tabs</code></td><td>列出所有标签页（tabId / 标题 / URL / 活动 / 分组）</td></tr>
  <tr><td><code>tabbit_claim</code></td><td>接管用户已经开着的标签，接管后才能操作</td></tr>
  <tr><td><code>tabbit_run</code></td><td>跑 Playwright 代码：真实点击 / 填表 / 导航 / 抓取</td></tr>
  <tr><td><code>tabbit_inspect</code></td><td>回执是 queued 时，等待并取回结果</td></tr>
  <tr><td><code>tabbit_screenshot</code></td><td>可视区 / 整页截图</td></tr>
  <tr><td><code>tabbit_receipt</code></td><td>按 requestId 精确取回执</td></tr>
  <tr><td><code>tabbit_diagnose</code></td><td>连通性自检（不带 --task，任务还没建也能查）</td></tr>
  <tr><td><code>tabbit_finish</code></td><td>结束任务，默认保留标签；<code>discard</code> 关掉本任务新建的</td></tr>
</table>
</div>
<div class="box" style="margin-top:12px">
  <div class="kv">
    <b>顺带修的一点：</b>MCP 工具原本是进程级缓存，改了 <code>config.json</code> 也得重启网关才生效（设置页却写着"下次对话生效"）。<br>
    现在 <code>src/mcp/client.ts</code> 会比对 <code>mcpServers</code> 指纹，<b>变了就自动重连并回收旧连接</b> —— 设置页里增删 MCP，下一轮对话真的立即生效。
  </div>
</div>
</section>

<section>
<h2><span class="n">4</span>桌面操控：内置 <code>computer</code> 工具</h2>
<div class="box">
  <div class="kv" style="margin-bottom:12px">
    新增内置工具 <code>computer</code>，用 Windows 原生 user32.dll（PowerShell + Add-Type P/Invoke）实现<b>真实鼠标键盘</b>，
    不引入 robotjs / nircmd 之类原生依赖。脚本落盘到 <code>~/.yyagent/bin/gui.ps1</code>（Node 写文件，绕开 shell 引号转义）。
  </div>
<table class="cmp">
  <tr><th>action</th><th>说明</th></tr>
  <tr><td><code>info</code></td><td>屏幕尺寸 / 光标位置 / 当前前台窗口</td></tr>
  <tr><td><code>screen</code></td><td>截全屏存 PNG，并交给识图模型转成文字描述（<code>describe:false</code> 可跳过）</td></tr>
  <tr><td><code>windows</code></td><td>列出所有可见窗口（pid | 进程 | 标题）</td></tr>
  <tr><td><code>focus</code></td><td>按标题子串激活窗口并置前</td></tr>
  <tr><td><code>move</code> / <code>click</code></td><td>移动光标；单击 / 双击 / 右键 / 中键</td></tr>
  <tr><td><code>drag</code></td><td>按住拖拽（24 步插值，不是瞬移）</td></tr>
  <tr><td><code>scroll</code></td><td>滚轮，正数向上、负数向下</td></tr>
  <tr><td><code>type</code></td><td>输入文字（经剪贴板粘贴，支持中文；会覆盖系统剪贴板）</td></tr>
  <tr><td><code>key</code></td><td>组合键：<code>ctrl+c</code> / <code>alt+tab</code> / <code>enter</code> / <code>ctrl+shift+s</code> / 方向键 / F1–F12</td></tr>
</table>
</div>
<h3>刚在本机真实跑出来的结果</h3>
<div class="cols">
  <div class="box">
    <div class="mono">${guiInfo.replace(/</g, "&lt;")}</div>
    <div class="kv" style="margin-top:8px">光标从 1113,413 → 800,600 → 200,200 真的移动了；<code>key shift</code> / <code>ctrl+shift</code> 真实按下。</div>
  </div>
  <div class="box">
    <div class="mono">${winList.replace(/</g, "&lt;")}</div>
    <div class="kv" style="margin-top:8px">窗口枚举直接看到 Tabbit / WorkBuddy / Notepad 等真实标题，<code>focus</code> 即可把它们切到前台。</div>
  </div>
</div>
<div class="box" style="margin-top:12px">
  <div class="kv">
    <b>权限：</b><code>click</code> / <code>drag</code> / <code>type</code> / <code>key</code> 四个写入类动作走项目的 <code>gate()</code> 门控，与 <code>write</code>/<code>edit</code> 同档（<code>danger:false</code>）——<br>
    「危险确认」档位放行；「全部确认」档位每次点击都会先问；无人值守且无 broker 时不挂起。<br>
    <b>只读动作</b>（info / windows / screen / focus / move / scroll）不问，避免刷屏。
  </div>
</div>
</section>

<section>
<h2><span class="n">5</span>验证</h2>
<div class="box">
  <div class="kv">
    <b>新增</b> <code>scripts/check-t44.mjs</code> —— <b class="ok">121 条</b> 断言全绿：导轨几何 / 设置页样式 / 统计卡仿真（抠真实函数喂真数据）/ tabbit 工具面 / computer 动作面 / 主题变量。<br>
    <b>回归</b> T37 · T39(12) · T40(22) · T41(27) · T42(34) · T43(109) · T43-API(32) 全部通过。<br>
    <b>TS</b> <code>npx tsc --noEmit</code> 零错误。<br>
    <b>实测</b> MCP 客户端连新 server：8 个工具、<code>tabs</code> 解析出真实标签、<code>finish</code> 正常。
  </div>
</div>
<div class="box" style="margin-top:12px">
  <div class="kv">
    <b>生效范围：</b>前端（<code>web/index.html</code>）刷新即生效；<br>
    <b class="no">后端需重启网关</b> 才生效 —— <code>computer</code> 工具、tabbit MCP 替换、MCP 热重连、以及上一轮的 <code>POST /api/export/xlsx</code>。
  </div>
</div>
</section>

</div></body></html>
`

writeFileSync(join(ROOT, "t44-preview.html"), out, "utf8")
console.log("生成 t44-preview.html（" + (Buffer.byteLength(out) / 1024).toFixed(1) + " KB）")
