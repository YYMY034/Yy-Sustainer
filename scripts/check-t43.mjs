/**
 * T43 离线回归：思维导图重做（居中 SVG 树 + 分支配色 + 保存为图片）、表格保存为 xlsx、
 * 用户气泡改中性灰、导轨按「整个内容区（含输入区）」垂直居中。
 *
 * 本机没有 playwright / 无头浏览器，所以验证分四层：
 *   A. 语法：把 index.html 里的 <script> 抠出来 node --check
 *   B. CSS 静态断言：规则是否真的写对了（含「旧规则必须消失」的反向断言）
 *   C. JS/网关 静态断言：关键片段存在性、声明顺序（TDZ）、端点接线
 *   D. 功能仿真：把 mmSvg 等纯函数抠到 Node 里喂合成树，检查真实输出
 *      （节点数、层级列坐标、分支配色分配、垂直居中、深度归一化、无 CSS 变量残留）
 *
 * 用法：node scripts/check-t43.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mmLib, extractScript, extractStyle, grab } from "./mm-lib.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const HTML_PATH = path.join(ROOT, "web", "index.html")
const GW_PATH = path.join(ROOT, "src", "gateway.ts")
const html = fs.readFileSync(HTML_PATH, "utf8")
const css = extractStyle(html)
const js = extractScript(html)
const gw = fs.readFileSync(GW_PATH, "utf8")

let pass = 0
const fails = []
function ok(name, cond, extra = "") {
  if (cond) { pass++; return true }
  fails.push(`${name}${extra ? " — " + extra : ""}`)
  return false
}
function eq(name, actual, expected) { return ok(name, actual === expected, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`) }

// ---------- CSS 小工具（先去注释，再按 { } 切规则，逗号分组选择器逐个比） ----------
const noComment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "")
function findRules(sel) {
  const clean = noComment(css)
  const want = sel.replace(/\s+/g, " ").trim()
  const out = []
  const re = /([^{}]*)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(clean))) {
    const sels = m[1].split(",").map((s) => s.trim().replace(/\s+/g, " "))
    if (sels.includes(want)) out.push(m[2])
  }
  return out
}
function prop(sel, name) {
  for (const body of findRules(sel)) {
    for (const d of body.split(";")) {
      const ci = d.indexOf(":")
      if (ci > 0 && d.slice(0, ci).trim() === name) return d.slice(ci + 1).trim()
    }
  }
  return undefined
}
function varsOf(sel) {
  const out = {}
  for (const body of findRules(sel)) {
    for (const d of body.split(";")) {
      const ci = d.indexOf(":")
      if (ci > 0 && d.slice(0, ci).trim().startsWith("--")) out[d.slice(0, ci).trim()] = d.slice(ci + 1).trim()
    }
  }
  return out
}

// ================= A. 语法 =================
const tmp = path.join(ROOT, "scripts", ".tmp-t43-check.cjs")
fs.writeFileSync(tmp, js)
let syntaxOk = true, syntaxMsg = ""
try { execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" }) }
catch (e) { syntaxOk = false; syntaxMsg = String(e.stderr ?? e.message).split("\n").slice(0, 6).join(" | ") }
fs.unlinkSync(tmp)
ok("A1 web/index.html 内联 <script> 通过 node --check", syntaxOk, syntaxMsg)
ok("A2 内联脚本非空（>100KB）", js.length > 100000, `${js.length} 字符`)

// ================= B. CSS 静态断言 =================
eq("B1 .msg.user > .bubble 背景改为 var(--panel2)（中性灰）", prop(".msg.user > .bubble", "background"), "var(--panel2)")
ok("B2 气泡规则里不再出现 var(--hover)（去青绿感）", !findRules(".msg.user > .bubble").some((b) => b.includes("var(--hover)")))
eq("B3 .msg.user > .bubble 圆角保持不变（右上带小尾角）", prop(".msg.user > .bubble", "border-radius"), "16px 16px 4px 16px")

eq("B4 #qaRail 全窗居中（top 上移半个顶栏，T64）", prop("#qaRail", "top"), "calc(var(--topbar-h, 37px) / -2)")
eq("B5 #qaRail 高度 100%（含输入区，短横在内容区居中）", prop("#qaRail", "height"), "100%")
eq("B6 #qaRail 主轴居中", prop("#qaRail", "justify-content"), "center")

eq("B7 .mindmap 为定位容器（承载保存按钮）", prop(".msg .body .mindmap", "position"), "relative")
ok("B8 .mindmap 有底色 + 圆角（卡片外观）", !!prop(".msg .body .mindmap", "background") && !!prop(".msg .body .mindmap", "border-radius"))
eq("B9 .mm-scroll 横向可滚（超宽树不被裁）", prop(".msg .body .mindmap .mm-scroll", "overflow-x"), "auto")
eq("B10 svg.mm-svg 用 margin:0 auto 居中", prop(".msg .body .mindmap svg.mm-svg", "margin"), "0 auto")
eq("B11 svg.mm-svg 是 block（margin auto 才生效）", prop(".msg .body .mindmap svg.mm-svg", "display"), "block")
eq("B12 .mm-save 默认隐藏", prop(".msg .body .mindmap .mm-save", "opacity"), "0")
eq("B13 .mm-save 悬停浮现", prop(".msg .body .mindmap:hover .mm-save", "opacity"), "1")
ok("B14 .mm-save 是绝对定位浮层", prop(".msg .body .mindmap .mm-save", "position") === "absolute")
ok("B15 .mm-save 内的 svg 不产生基线空隙", prop(".msg .body .mindmap .mm-save svg", "display") === "block")

eq("B16 .mdtwrap 宽度收在表格上（fit-content）", prop(".msg .body .mdtwrap", "width"), "fit-content")
eq("B17 .mdtwrap 不超容器（超宽表格仍横滚）", prop(".msg .body .mdtwrap", "max-width"), "100%")
eq("B18 .mdtwrap 内表格 margin 归零（避免双重间距）", prop(".msg .body .mdtwrap .mdtable", "margin"), "0")
eq("B19 .mdt-xlsx 默认隐藏", prop(".msg .body .mdtwrap .mdt-xlsx", "opacity"), "0")
eq("B20 .mdt-xlsx 悬停浮现", prop(".msg .body .mdtwrap:hover .mdt-xlsx", "opacity"), "1")
ok("B21 .mdt-xlsx 是绝对定位浮层", prop(".msg .body .mdtwrap .mdt-xlsx", "position") === "absolute")

// 反向断言：旧实现必须清干净（否则会出现「两套样式打架」的幽灵问题）
const deadSelectors = [".msg .body .mindmap .mm-title", ".msg .body .mindmap .mm-tree", ".msg .body .mindmap .mm-row", ".msg .body .mindmap .mm-node", ".msg .body .mindmap .mm-d0", ".msg .body .mindmap .mm-d1", ".msg .body .mindmap .mm-d2", ".msg .body .mindmap .mm-d3", ".msg .body .mindmap .mm-d4"]
const leftover = deadSelectors.filter((s) => findRules(s).length)
ok("B22 缩进列表时代的 .mm-title/.mm-tree/.mm-row/.mm-node/.mm-dN 规则已全部移除", leftover.length === 0, leftover.join(", "))

// ================= C. JS / 网关 静态断言 =================
const lineOf = (needle) => { const i = js.indexOf(needle); return i < 0 ? -1 : js.slice(0, i).split("\n").length }
const noJsComment = (s) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
ok("C1 mmSvg 定义在 renderMindmap 之前（先有工具函数）", lineOf("function mmSvg(") > 0 && lineOf("function mmSvg(") < lineOf("function renderMindmap("))
const initLine = lineOf("loadSessions(); refreshState(); connect(); updateSendBtn()")
ok("C2 MM_* 常量块声明在脚本尾部初始化调用之前（防 TDZ 崩溃）", lineOf("const MM_HUES_DARK") > 0 && lineOf("const MM_HUES_DARK") < initLine, `MM 常量@${lineOf("const MM_HUES_DARK")} init@${initLine}`)
ok("C3 MM_THEME / MM_LEVEL / MM_SAVE_ICON / XLSX_ICON 也都在初始化之前", [lineOf("const MM_THEME"), lineOf("const MM_LEVEL"), lineOf("const MM_SAVE_ICON"), lineOf("const XLSX_ICON")].every((l) => l > 0 && l < initLine))

const rmm = grab(js, "renderMindmap")
ok("C4 renderMindmap 调用了 mmSvg", rmm.includes("mmSvg("))
ok("C5 renderMindmap 输出保存按钮与滚动容器", rmm.includes("mm-save") && rmm.includes("mm-scroll"))
ok("C6 renderMindmap 已不再输出 .mm-node 气泡（旧实现痕迹）", !rmm.includes("mm-node") && !rmm.includes("mm-row"))
ok("C7 renderMindmap 把图题当根节点（depth:-1）而不是单独标题行", rmm.includes("depth: -1"))
ok("C8 renderMindmap 做「缩进列 → 顺序层级」重映射", rmm.includes("indent") && rmm.includes("indexOf(n.indent)"))
const ptl = grab(js, "parseTreeLine")
ok("C9 parseTreeLine 改为返回「标签起始列」indent（不再数空格/2）", ptl.includes("indent:") && !ptl.includes("Math.floor(indent / 2)"))

const mmClean = noJsComment(grab(js, "mmSvg"))
ok("C10 mmSvg 用「原始缩进 orig」做栈比较（同缩进兄弟不会被判成父子）", mmClean.includes("orig") && mmClean.includes(".orig >= want"))
ok("C11 mmSvg 架了虚拟根 vroot（多顶层并列时为森林式，不互相嵌套）", mmClean.includes("vroot"))
ok("C12 mmSvg 分支配色：唯一根 → 子节点取 i+1 号色相；多顶层 → 各取 i 号", mmClean.includes("single") && mmClean.includes("(i + 1) % HUES.length") && mmClean.includes("i % HUES.length"))
ok("C13 mmSvg 不含 DOM 依赖（可抠到 Node 跑 / 可序列化导出）", !/\bdocument\b|\bwindow\b|getComputedStyle/.test(mmClean))
ok("C14 mmSvg 连接线是三次贝塞尔 C 命令", mmClean.includes("C${x1 + dx}"))
ok("C15 mmSvg 文本垂直居中用 alphabetic 基线手算（不用 dominant-baseline，栅格化更稳）", mmClean.includes("n.font * 0.34") && !mmClean.includes("dominant-baseline"))

const ft = grab(js, "flushTable")
ok("C16 flushTable 用 .mdtwrap + .mdt-xlsx 包住表格", ft.includes("mdtwrap") && ft.includes("mdt-xlsx") && ft.includes("XLSX_ICON"))
ok("C17 flushTable 闭合标签配平（</table></div>）", ft.includes("</tbody></table></div>"))

const smp = grab(js, "saveMindmapPng")
ok("C18 saveMindmapPng 走 SVG → Image(data URL) 路线", smp.includes("image/svg+xml") && smp.includes("new Image()"))
ok("C19 saveMindmapPng 补 xmlns（否则栅格化会失败）", smp.includes('setAttribute("xmlns"'))
ok("C20 saveMindmapPng 烤一层底色（透明 PNG 在浅色页面上会看不清）", smp.includes("bgRect") && smp.includes('getPropertyValue("--panel2")'))
ok("C21 saveMindmapPng 用 canvas 2x + toBlob 出 PNG", smp.includes("scale = 2") && smp.includes('toBlob(resolve, "image/png")'))
ok("C22 saveMindmapPng 有失败兜底（banner 提示 + 按钮恢复）", smp.includes("banner") && smp.includes("finally"))

const etx = grab(js, "exportTableXlsx")
ok("C23 exportTableXlsx 直接从 DOM 读 th/td 文本（重写 innerHTML 也不丢数据）", etx.includes('querySelectorAll("tr")') && etx.includes("textContent"))
ok("C24 exportTableXlsx POST /api/export/xlsx", etx.includes('"/api/export/xlsx"') && etx.includes('method: "POST"'))
ok("C25 exportTableXlsx 有失败兜底", etx.includes("banner") && etx.includes("finally"))

const dlLine = lineOf('$("messages").addEventListener("click"')
const dlBody = dlLine > 0 ? js.split("\n").slice(dlLine - 1, dlLine + 20).join("\n") : ""
ok("C26 消息区用事件委托接管两个导出按钮（innerHTML 重写不会丢事件）", dlLine > 0 && dlBody.includes(".mm-save") && dlBody.includes(".mdt-xlsx"))
ok("C27 事件委托挂在 #messages 本体且在初始化之前（不是会被重写的子节点）", dlLine > 0 && initLine > 0 && dlLine < initLine)
const at = noJsComment(grab(js, "applyTheme"))
ok("C28 切主题后重绘（思维导图配色是 JS 算的字面量，不重绘要等 3s 轮询）", at.includes("render()"))

ok("C29 网关存在 POST /api/export/xlsx 路由", gw.includes('p === "/api/export/xlsx"'))
ok("C30 网关动态 import exceljs（避免启动就加载重依赖）", gw.includes('await import("exceljs")'))
ok("C31 网关用 exceljs 的 writeBuffer 出 xlsx", gw.includes("xlsx.writeBuffer()"))
const gwXlsx = gw.indexOf('/api/export/xlsx"')
const gw404 = gw.indexOf("no route:")
ok("C32 xlsx 路由在兜底 404 之前（顺序正确）", gwXlsx > 0 && gw404 > 0 && gwXlsx < gw404)
ok("C33 xlsx 响应 writeHead+end 后立刻 return（不能落到 404 二次写头）", /res\.end\(data\)\s*\n\s*return/.test(gw))
ok("C34 路由表注释里登记了新端点", /POST\s+\/api\/export\/xlsx/.test(gw))
ok("C35 exceljs 已在依赖里（无需新增安装）", fs.readFileSync(path.join(ROOT, "package.json"), "utf8").includes('"exceljs"'))

// ================= D. 功能仿真（把纯函数抠到 Node 里跑） =================
const L = mmLib(HTML_PATH)
const parseTL = L.parseTreeLine
const dark = L.MM_THEME.dark

function attr(tag, name) { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? m[1] : undefined }
function num(tag, name) { const v = attr(tag, name); return v === undefined ? NaN : Number(v) }
/** 把 SVG 字符串解析成节点数组（rect 与紧随其后的 text 配对） */
function parseNodes(svg) {
  const toks = [...svg.matchAll(/<rect\b[^>]*\/>|<text\b[^>]*>[\s\S]*?<\/text>/g)].map((m) => m[0])
  const out = []
  for (let i = 0; i + 1 < toks.length; i += 2) {
    const r = toks[i], t = toks[i + 1]
    out.push({
      x: num(r, "x"), y: num(r, "y"), w: num(r, "width"), h: num(r, "height"),
      fill: attr(r, "fill"), stroke: attr(r, "stroke"),
      cx: num(t, "x"), size: num(t, "font-size"), weight: attr(t, "font-weight"), tfill: attr(t, "fill"),
      text: t.replace(/<[^>]*>/g, ""),
    })
  }
  return out
}
const pathsOf = (svg) => [...svg.matchAll(/<path\b[^>]*\/>/g)].map((m) => m[0])
const groupBy = (arr, key) => { const m = new Map(); for (const x of arr) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x) } return m }
const levelsOf = (nodes) => [...groupBy(nodes, (n) => n.x).entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)

/** 复刻 renderMindmap 的前处理：抠标题 + 缩进列重映射 + 标题作为根 */
function buildNodes(lines) {
  let title = ""
  const nodes = []
  for (const ln of lines) {
    const p = parseTL(ln)
    if (!p) continue
    if (!nodes.length && !p.indent && /导图|脑图|mindmap|mind map/i.test(p.text) && p.text.length <= 30) { title = p.text; continue }
    nodes.push(p)
  }
  const cols = [...new Set(nodes.map((n) => n.indent))].sort((a, b) => a - b)
  for (const n of nodes) n.depth = cols.indexOf(n.indent)
  if (title) nodes.unshift({ indent: -1, depth: -1, text: title })
  return { title, nodes }
}

// D1：标题 + 4 个一级分支 × 2 个子项（├─ 画法）
const TREE_A = `项目规划思维导图
├─ 市场调研
│  ├─ 竞品分析
│  └─ 用户访谈
├─ 产品设计
│  ├─ 交互稿
│  └─ 视觉规范
├─ 技术方案
│  ├─ 架构选型
│  └─ 部署方案
└─ 上线运营
   ├─ 灰度发布
   └─ 数据看板`
const A = buildNodes(TREE_A.split("\n"))
const svgA = L.mmSvg(A.nodes, false)
const nA = parseNodes(svgA)
const lvA = levelsOf(nA)
eq("D1.1 ├─ 画法正确分层：标题 + 4 分支 + 8 子项 = 13 个节点", nA.length, 13)
eq("D1.2 节点框与文字一一对应", (svgA.match(/<text\b/g) || []).length, 13)
eq("D1.3 连接线 4 + 8 = 12 条", pathsOf(svgA).length, 12)
eq("D1.4 标题行被抽成根节点（图中只出现一次）", nA.filter((n) => n.text === "项目规划思维导图").length, 1)

eq("D1.5 分成 3 列（根 / 一级分支 / 二级子项）", lvA.length, 3)
eq("D1.6 每列节点数 1 / 4 / 8", [lvA[0].length, lvA[1].length, lvA[2].length].join("/"), "1/4/8")
ok("D1.7 列坐标严格右移（随 depth 单调递增）", lvA[0][0].x < lvA[1][0].x && lvA[1][0].x < lvA[2][0].x)
eq("D1.8 根节点填充 = 主色相", lvA[0][0].fill, L.MM_HUES_DARK[0])
eq("D1.9 根节点文字白色 + 加粗", lvA[0][0].tfill + "/" + lvA[0][0].weight, "#ffffff/700")
ok("D1.10 四个一级分支各拿不同色相（与根错开，且互不重复）", new Set(lvA[1].map((n) => n.fill)).size === 4 && !lvA[1].some((n) => n.fill === L.MM_HUES_DARK[0]))
eq("D1.11 分支色相 = HUES[1..4] 顺序分配", lvA[1].map((n) => n.fill).join(","), L.MM_HUES_DARK.slice(1, 5).join(","))
ok("D1.12 孙辈继承所属分支色相（按列内顺序与分支一一对应）", (() => {
  for (let b = 0; b < 4; b++) {
    const want = L.mmMix(L.MM_HUES_DARK[b + 1], dark.panel, 0.16)
    for (const k of [0, 1]) if (lvA[2][b * 2 + k].fill !== want) return false
  }
  return true
})())
ok("D1.13 根节点纵向对齐子树首尾叶子中点（tidy tree 不变量）", Math.abs(lvA[0][0].y - (lvA[2][0].y + lvA[2][7].y) / 2) < 0.01)
ok("D1.14 视觉上也是居中（根中心与首尾叶子中心中点的偏差 < 4px，差异只来自各层节点高度）", (() => {
  const root = lvA[0][0], leaves = lvA[2]
  const mid = (leaves[0].y + leaves[0].h / 2 + leaves[7].y + leaves[7].h / 2) / 2
  return Math.abs(root.y + root.h / 2 - mid) < 4
})())
ok("D1.15 输出里没有任何 CSS 变量残留（否则导出的 PNG 会丢色）", !svgA.includes("var(--"))
ok("D1.16 所有 fill/stroke 要么是 6 位十六进制字面量，要么是连接线的 none", [...svgA.matchAll(/(?:fill|stroke)="([^"]+)"/g)].every((m) => /^#[0-9a-f]{6}$/.test(m[1]) || m[1] === "none"))
ok("D1.17 尺寸自洽（viewBox 与 width/height 一致，且容得下最右列/最下行）", (() => {
  const w = num(svgA, "width"), h = num(svgA, "height")
  const vb = attr(svgA, "viewBox").split(/\s+/).map(Number)
  return w === vb[2] && h === vb[3] && w >= Math.max(...nA.map((n) => n.x + n.w)) && h >= Math.max(...nA.map((n) => n.y + n.h)) && w > 200 && h > 100
})())
ok("D1.18 节点宽度随内容变化（不是所有框一样宽）", new Set(nA.map((n) => n.w)).size >= 4 && Math.max(...nA.map((n) => n.w)) === lvA[0][0].w)
ok("D1.19 文字水平居中（text-anchor=middle）", [...svgA.matchAll(/<text\b[^>]*>/g)].every((m) => attr(m[0], "text-anchor") === "middle"))
ok("D1.20 文字水平落在框中心（x = 左缘 + 宽/2）", nA.every((n) => Math.abs(n.cx - (n.x + n.w / 2)) < 0.01))

// D2：├── 画法 + 单根（不靠标题识别，靠「唯一最小层级」）
const TREE_B = `项目
├── 前端
│   ├── React
│   └── Vue
└── 后端`
const B = buildNodes(TREE_B.split("\n"))
const svgB = L.mmSvg(B.nodes, false)
const nB = parseNodes(svgB)
const lvB = levelsOf(nB)
eq("D2.1 ├── 宽画法：0/4/8 列映射成 0/1/2 层（不再是 0/1/4 的错乱层级）", nB.length, 5)
eq("D2.2 三列分布 1/2/2", lvB.map((v) => v.length).join("/"), "1/2/2")
eq("D2.3 唯一最小层级 → 经典左根右枝：根用主色相", lvB[0][0].fill, L.MM_HUES_DARK[0])
eq("D2.4 两个一级分支取 HUES[1]/HUES[2]", lvB[1].map((n) => n.fill).join(","), L.MM_HUES_DARK.slice(1, 3).join(","))
eq("D2.5 React/Vue 继承前端色相", lvB[2].map((n) => n.fill).join(","), [L.mmMix(L.MM_HUES_DARK[1], dark.panel, 0.16), L.mmMix(L.MM_HUES_DARK[1], dark.panel, 0.16)].join(","))

// D3：多顶层（森林式）—— 同缩进的兄弟绝不能被判成父子
const TREE_C = `前端
  React
  Vue
后端
  Node`
const C = buildNodes(TREE_C.split("\n"))
const svgC = L.mmSvg(C.nodes, false)
const nC = parseNodes(svgC)
const lvC = levelsOf(nC)
eq("D3.1 两个顶层并列（森林式）→ 5 个节点、3 条线（前端 2 子 + 后端 1 子）", nC.length + "/" + pathsOf(svgC).length, "5/3")
eq("D3.2 顶层 2 个、第二列 3 个（后端没被吞成前端的子节点）", lvC.map((v) => v.length).join("/"), "2/3")
eq("D3.3 顶层各自取 HUES[0]/HUES[1]", lvC[0].map((n) => n.fill).join(","), L.MM_HUES_DARK.slice(0, 2).join(","))
eq("D3.4 顶层都是实心主级样式（字号 13.5 / 加粗 700）", lvC[0].map((n) => n.size + "/" + n.weight).join(","), "13.5/700,13.5/700")

// D4：跳级缩进（0 → 2）不应把兄弟变成父子
const D = buildNodes(["根", "  甲", "  乙"])
const svgD = L.mmSvg(D.nodes, false)
const lvD = levelsOf(parseNodes(svgD))
eq("D4.1 缩进跳级（0→2）也能归一到两层", lvD.map((v) => v.length).join("/"), "1/2")

// D5：浅色主题同样自洽
const svgL = L.mmSvg(A.nodes, true)
const nL = parseNodes(svgL)
eq("D5.1 浅色主题节点数一致", nL.length, 13)
eq("D5.2 浅色主题根用浅色色系主色", nL[0].fill, L.MM_HUES_LIGHT[0])
ok("D5.3 浅色主题色板与深色不同（不是同一套色硬套）", L.MM_HUES_LIGHT.join() !== L.MM_HUES_DARK.join())

// D6：工具函数
eq("D6.1 mmMix 黑白各半 = #808080", L.mmMix("#000000", "#ffffff", 0.5), "#808080")
ok("D6.2 mmTextW：全角字宽 ≈ 字号（『思维导图』13.5px ≈ 54px）", Math.abs(L.mmTextW("思维导图", 13.5) - 54) < 0.01)
ok("D6.3 mmTextW：半角比全角窄", L.mmTextW("abcd", 13.5) < L.mmTextW("甲乙丙丁", 13.5))
ok("D6.4 单节点树不崩", (() => { const s = L.mmSvg([{ depth: 0, text: "只有根" }], false); return s.includes("只有根") && num(s, "width") > 0 })())
ok("D6.5 esc 生效（标签含 < > 时不破坏 SVG 结构）", L.mmSvg([{ depth: 0, text: "a<b>c" }, { depth: 1, text: "d" }], false).includes("a&lt;b&gt;c"))
ok("D6.6 超长标签被截断加省略号（避免单行撑爆画布）", L.mmSvg([{ depth: 0, text: "字".repeat(80) }, { depth: 1, text: "x" }], false).includes("…"))

// 主题常量 ↔ CSS 变量一致性（防止两边各改一半）
const rootV = varsOf(":root")
const lightV = varsOf("html.light")
eq("D7.1 MM_HUES_DARK[0] 与 :root --accent 一致", L.MM_HUES_DARK[0], rootV["--accent"])
eq("D7.2 MM_HUES_LIGHT[0] 与 html.light --accent 一致", L.MM_HUES_LIGHT[0], lightV["--accent"])
eq("D7.3 MM_THEME.dark.panel 与 :root --panel 一致", L.MM_THEME.dark.panel, rootV["--panel"])
eq("D7.4 MM_THEME.dark.text 与 :root --text 一致", L.MM_THEME.dark.text, rootV["--text"])
eq("D7.5 MM_THEME.dark.dim 与 :root --dim 一致", L.MM_THEME.dark.dim, rootV["--dim"])
eq("D7.6 MM_THEME.dark.border 与 :root --border 一致", L.MM_THEME.dark.border, rootV["--border"])
eq("D7.7 MM_THEME.light.panel 与 html.light --panel 一致", L.MM_THEME.light.panel, lightV["--panel"])
eq("D7.8 MM_THEME.light.text 与 html.light --text 一致", L.MM_THEME.light.text, lightV["--text"])
eq("D7.9 MM_THEME.light.dim 与 html.light --dim 一致", L.MM_THEME.light.dim, lightV["--dim"])
eq("D7.10 MM_THEME.light.border 与 html.light --border 一致", L.MM_THEME.light.border, lightV["--border"])
ok("D7.11 色板数量 ≥ 6（够给多分支错开色相）", L.MM_HUES_DARK.length >= 6 && L.MM_HUES_LIGHT.length === L.MM_HUES_DARK.length)

// ================= 汇总 =================
console.log(`\nT43 断言：${pass} 通过 / ${fails.length} 失败（共 ${pass + fails.length} 条）`)
if (fails.length) {
  console.log("\n失败项：")
  for (const f of fails) console.log("  ✗ " + f)
  process.exitCode = 1
} else {
  console.log("全部通过。")
}
