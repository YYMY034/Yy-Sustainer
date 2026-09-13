/**
 * 生成 T43 改动的可视化预览页（t43-preview.html）。
 *
 * 用途：本机没有浏览器截图能力，没法直接把「改完长什么样」截图给用户，
 * 于是把改前/改后用同一套真实 CSS 渲染在一张静态页上，用户双击即可在浏览器里核对。
 * 页面里的思维导图 SVG 是用 index.html 里真实的 mmSvg() 现场生成的（不是手画的示意图），
 * 所以看到什么，聊天里就是什么。
 *
 * 用法：node scripts/gen-t43-preview.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mmLib, extractStyle, grab } from "./mm-lib.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const HTML_PATH = path.join(ROOT, "web", "index.html")
const OUT = path.join(ROOT, "t43-preview.html")
const html = fs.readFileSync(HTML_PATH, "utf8")
const style = extractStyle(html)
const L = mmLib(HTML_PATH)

// ---- 从真实样式表里取主题变量（预览页的对照色块不能硬编码，否则以后改主题会失真） ----
const clean = style.replace(/\/\*[\s\S]*?\*\//g, "")
function varsOf(sel) {
  const out = {}
  const re = /([^{}]*)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(clean))) {
    const sels = m[1].split(",").map((s) => s.trim().replace(/\s+/g, " "))
    if (!sels.includes(sel)) continue
    for (const d of m[2].split(";")) {
      const ci = d.indexOf(":")
      if (ci > 0 && d.slice(0, ci).trim().startsWith("--")) out[d.slice(0, ci).trim()] = d.slice(ci + 1).trim()
    }
  }
  return out
}
const darkV = varsOf(":root"), lightV = varsOf("html.light")

/** 复刻 renderMindmap 的前处理（抠标题 + 缩进列重映射 + 标题当根） */
function buildNodes(lines) {
  let title = ""
  const nodes = []
  for (const ln of lines) {
    const p = L.parseTreeLine(ln)
    if (!p) continue
    if (!nodes.length && !p.indent && /导图|脑图|mindmap|mind map/i.test(p.text) && p.text.length <= 30) { title = p.text; continue }
    nodes.push(p)
  }
  const cols = [...new Set(nodes.map((n) => n.indent))].sort((a, b) => a - b)
  for (const n of nodes) n.depth = cols.indexOf(n.indent)
  if (title) nodes.unshift({ indent: -1, depth: -1, text: title })
  return nodes
}
const svgOf = (lines, light) => L.mmSvg(buildNodes(lines.split("\n")), light)

// 复刻 renderMindmap 的外层结构：卡片 + 悬停浮现的「保存为图片」按钮 + 横向滚动容器。
// 图标常量直接从 index.html 里抠出来用，避免预览页和真实页面各画一个图标。
const SAVE_ICON = new Function(`${grab(html, "MM_SAVE_ICON")}\nreturn MM_SAVE_ICON;`)()
const card = (svg) => `<div class="mindmap"><button class="mm-save" type="button">${SAVE_ICON}<span>保存为图片</span></button><div class="mm-scroll">${svg}</div></div>`

const TREE_A = `项目规划思维导图
├─ 市场调研
│  ├─ 竞品分析（对标 3 家头部）
│  └─ 用户访谈 20 人
├─ 产品设计
│  ├─ 交互稿 v2
│  └─ 视觉规范
├─ 技术方案
│  ├─ 架构选型
│  ├─ 数据库设计
│  └─ 部署方案
└─ 上线运营
   ├─ 灰度发布
   └─ 数据看板`

const TREE_B = `前端
  React
  Vue
后端
  Node
  Go
  中间件`

const A_D = card(svgOf(TREE_A, false)), A_L = card(svgOf(TREE_A, true))
const B_D = card(svgOf(TREE_B, false)), B_L = card(svgOf(TREE_B, true))

// ---- 旧版对照：缩进列表 + 同色系气泡（T15 的实现，已废弃） ----
const OLD_ROWS = [
  [0, "项目规划思维导图"], [1, "市场调研"], [2, "竞品分析（对标 3 家头部）"], [2, "用户访谈 20 人"],
  [1, "产品设计"], [2, "交互稿 v2"], [2, "视觉规范"], [1, "技术方案"], [2, "架构选型"],
]
const oldMindmap = `<div class="old-mm">${OLD_ROWS.map(([d, t]) => `<div class="old-row" style="margin-left:${d * 26}px"><span class="old-node old-d${d}">${t
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span></div>`).join("")}</div>`

const TABLE = [
  ["区域", "Q1 营收", "Q2 营收", "同比"],
  ["华东", "1280", "1462", "14.2%"],
  ["华南", "940", "1015", "8.0%"],
  ["华北", "610", "588", "-3.6%"],
  ["西南", "420", "505", "20.2%"],
]
const tableHtml = `<div class="mdtwrap"><button class="mdt-xlsx" type="button">${'<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="2.4" y="2" width="11.2" height="12" rx="1.6" stroke="currentColor" stroke-width="1.4"/><path d="M2.4 6.1h11.2M6.5 6.1V14" stroke="currentColor" stroke-width="1.3"/></svg>'}<span>保存为 xlsx</span></button><table class="mdtable"><thead><tr>${TABLE[0].map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${TABLE.slice(1).map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`

const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>T43 预览：思维导图重做 / 表格导出 xlsx / 气泡改灰 / 导轨居中</title>
<style>
${style}

/* ================= 预览页覆盖 =================
   整站样式假设 body 是 100vh 的 flex 布局（滚动交给 #messages），
   预览页要能整页纵向滚动，所以这里把外壳放开；组件样式原样保留，看到的即聊天里的效果。 */
html, body { height: auto !important; overflow: auto !important; display: block !important; }
body { padding-bottom: 70px; }
.wrap { max-width: 880px; margin: 0 auto; padding: 26px 22px 0; }
#messages { display: block !important; overflow: visible !important; height: auto !important; margin: 0 !important; border-radius: 14px !important; padding: 18px 22px 18px 32px !important; }
h1 { font-size: 19px; margin: 0 0 6px; }
.sub { color: var(--dim); font-size: 12.5px; margin-bottom: 22px; line-height: 1.7; }
h2 { font-size: 15px; margin: 34px 0 4px; padding-top: 22px; border-top: 1px solid var(--border); }
h2 .tag { font-size: 11px; font-weight: 400; color: var(--dim); margin-left: 8px; }
.note { font-size: 12.5px; color: var(--dim); margin: 6px 0 12px; line-height: 1.75; }
.note b { color: var(--text); }
.toolbar { position: sticky; top: 0; z-index: 99; display: flex; gap: 8px; align-items: center; padding: 10px 0 12px; background: linear-gradient(to bottom, var(--bg) 62%, transparent); }
.toolbar button { background: var(--panel2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 5px 12px; font: inherit; font-size: 12.5px; cursor: pointer; }
.toolbar button:hover { border-color: var(--accent); color: var(--accent); }
.toolbar .hint { color: var(--dim); font-size: 12px; margin-left: 4px; }

/* 预览专用：两个悬浮按钮默认隐藏，这里强制常显，方便一次看全 */
.mm-save, .mdt-xlsx { opacity: 1 !important; }

/* 旧版思维导图：T15 的缩进列表 + 单色系气泡（现已被 SVG 树取代，仅作对照） */
.old-mm { margin: 10px 0; padding: 12px 14px; background: var(--panel2); border: 1px solid var(--border); border-radius: 12px; overflow-x: auto; }
.old-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.old-node { display: inline-block; padding: 4px 14px; border-radius: 999px; font-size: 13px; line-height: 1.5; white-space: nowrap; }
.old-d0 { background: var(--accent); color: #fff; font-weight: 600; padding: 5px 18px; }
.old-d1 { background: color-mix(in srgb, var(--accent) 22%, var(--panel)); color: var(--text); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); font-weight: 600; }
.old-d2 { background: var(--panel); color: var(--text); border: 1px solid var(--border); }
/* 旧版气泡两态对照色块 */
.swatch { display: flex; gap: 18px; flex-wrap: wrap; margin: 8px 0 4px; }
.swatch > div { text-align: center; }
.swatch .box { width: 132px; height: 46px; border-radius: 16px 16px 4px 16px; display: flex; align-items: center; justify-content: center; font-size: 14px; color: var(--text); }
.swatch .cap { font-size: 11.5px; color: var(--dim); margin-top: 6px; }
.sw-before { background: var(--hover); }
.sw-after { background: var(--panel2); border: 1px solid var(--border); }

/* 导轨示意：外框 = #main（含输入区），短横竖排居中 */
.rail-demo { position: relative; height: 260px; border: 1px dashed var(--border); border-radius: 12px; background: var(--panel); display: flex; align-items: center; }
.rail-demo .dashes { width: 22px; margin-left: 10px; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.rail-demo .d { width: 14px; height: 3px; border-radius: 2px; background: var(--border); }
.rail-demo .d.cur { background: var(--accent); }
.rail-demo .d.near { background: color-mix(in srgb, var(--dim) 55%, transparent); width: 19px; }
.rail-demo .d.far { background: color-mix(in srgb, var(--dim) 30%, transparent); width: 16px; }
.rail-demo .zone { position: absolute; right: 12px; top: 12px; bottom: 12px; width: 1px; background: var(--border); }
.rail-demo .zone.old { top: 12px; bottom: 96px; border-right: 1px solid var(--warn); background: none; width: 0; }
.rail-demo .txt { position: absolute; right: 18px; font-size: 11.5px; color: var(--dim); }
.rail-demo .txt.old { bottom: 100px; }
.rail-demo .txt.new { bottom: 4px; }
.rail-demo .composer { position: absolute; left: 46px; right: 46px; bottom: 14px; height: 66px; border-radius: 18px; background: var(--panel2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--dim); }
.only-dark { display: block; } .only-light { display: none; }
html.light .only-dark { display: none; } html.light .only-light { display: block; }
</style>
</head>
<body>
<div class="wrap">
  <h1>T43 改动预览</h1>
  <div class="sub">
    四项改动：<b>①思维导图重做</b>（居中 SVG 树 / 分支配色 / 贝塞尔连线 / 保存为图片）、
    <b>②表格保存为 xlsx</b>、<b>③用户气泡改中性灰</b>、<b>④导轨按整个内容区（含输入区）居中</b>。<br>
    页面内的思维导图 SVG 由 <code>web/index.html</code> 里真实的 <code>mmSvg()</code> 生成，
    样式直接内联了整站的真实样式表 —— 这里看到什么，聊天里就是什么。
  </div>

  <div class="toolbar">
    <button onclick="document.documentElement.classList.toggle('light')">切换深/浅主题</button>
    <span class="hint">浅色主题下的 SVG 是另一套色板（下面会自动跟着切）</span>
  </div>

  <h2>① 思维导图：改前 → 改后<span class="tag">偏左 / 单色系 / 无连线 → 居中 / 分支配色 / 贝塞尔连线</span></h2>
  <div class="note">
    <b>改前（T15）</b>：所有节点靠左缩进排成一列，颜色只有「主色由深到浅」一套，层次一深就分不清谁是谁的孩子，
    连接线只有一小截横杠。模型缩进一乱（<code>├──</code> 画法）层级还会整体错位。
  </div>
  ${oldMindmap}
  <div class="note">
    <b>改后（T43）</b>：经典「左根右枝」树形，整图在卡片里居中；<b>一级分支各占一个色相、子孙继承</b>，
    同一条分支一眼就是一伙的；父子之间是三次贝塞尔曲线；每层字号/高度递减，视觉重量从根向外收。
  </div>
  <div class="only-dark">${A_D}</div>
  <div class="only-light">${A_L}</div>

  <div class="note" style="margin-top:16px">
    <b>另一种常见写法</b>（多个并列顶层 + 纯空格缩进）：不会被错判成父子关系 —— 顶层并列成多个分支，各自展开。
  </div>
  <div class="only-dark">${B_D}</div>
  <div class="only-light">${B_L}</div>

  <h2>② 表格：右上角新增「保存为 xlsx」<span class="tag">悬停浮现，点击下载</span></h2>
  <div class="note">
    导出的 xlsx 由网关 <code>POST /api/export/xlsx</code> 用 exceljs 生成：表头加粗、<b>纯数字还原成数字类型</b>
    （Excel 里能直接求和/排序，但 <code>007</code>、<code>0755</code> 这类编号保持文本不丢前导零）、列宽按内容自适应。
    这里为了看清楚，按钮是常显的；实际使用中 <b>鼠标移到表格上才浮现</b>。
  </div>
  ${tableHtml}

  <h2>③ 用户气泡：青绿灰 → 中性灰<span class="tag">与助手侧/卡片同一套灰</span></h2>
  <div class="note">
    原来用的是 <code>--hover</code>（深色下 <code>${darkV["--hover"]}</code>，带明显的青绿倾向），
    和整站的灰阶不是一套；现在统一到 <code>--panel2</code>（深色 <code>${darkV["--panel2"]}</code> / 浅色 <code>${lightV["--panel2"]}</code>）。
  </div>
  <div class="swatch">
    <div><div class="box sw-before">改前</div><div class="cap">--hover ${darkV["--hover"]}</div></div>
    <div><div class="box sw-after">改后</div><div class="cap">--panel2 ${darkV["--panel2"]}</div></div>
  </div>

  <h2>④ 导轨：垂直居中改为「算上输入区高度」<span class="tag">短横对齐整个内容区中线</span></h2>
  <div class="note">
    原来导轨只覆盖 <code>#messages</code> 的可视区，输入区那一截高度没算进去，短横整体看着偏上。
    现在覆盖范围是整个 <code>#main</code>（<code>top:0; height:100%</code>），短横落在<b>虚线框的正中线</b>上。
    下图虚线框即 <code>#main</code>：上方是消息区，下方是输入区。
  </div>
  <div class="rail-demo">
    <div class="dashes">
      <div class="d far"></div><div class="d near"></div><div class="d cur"></div>
      <div class="d near"></div><div class="d far"></div>
    </div>
    <div class="composer">输入区（composer）—— 现在也算进居中范围</div>
    <div class="txt old">↑ 旧：只居中到这里</div>
    <div class="zone old"></div>
    <div class="txt new">↓ 新：居中到最底部</div>
  </div>

  <div class="note" style="margin-top:26px;color:var(--dim)">
    注：本页是为了在无浏览器截图能力的环境下核对改动而生成的静态预览，不参与应用运行。
  </div>
</div>
</body>
</html>
`

fs.writeFileSync(OUT, page, "utf8")
console.log(`已生成 ${path.relative(ROOT, OUT)}（${(page.length / 1024).toFixed(1)} KB）`)
