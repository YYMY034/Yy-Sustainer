// T76 对照页生成器：改前（只认 :hover）vs 改后（按指针到短横中心的距离取最近）
// 所有色值与几何数字都从 web/index.html 现场解析，避免 mock 与真实界面脱节。
// 「改后」那一栏直接内联 index.html 里真实的 paintQaRipple 源码（抠出来就跑），不是另写一份。
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const html = readFileSync(resolve(root, "web/index.html"), "utf8")
const cssRaw = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "")
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]

// ---- 1) 主题变量（两套都取，供页面切换）----
const themeBlock = (sel) => {
  const m = cssRaw.match(new RegExp("(?:^|\\n)[ \\t]*" + sel.replace(/\./g, "\\.") + "[ \\t]*\\{([^}]*)\\}"))
  return m ? m[1].trim() : ""
}
// html.light 的规则里是 `html.light {`，但 :root 是 `:root {`
const dark = themeBlock(":root").replace(/--app-font:[^;]*;/, "")
const light = themeBlock("html.light")

// ---- 2) 几何与宽度（全部从真实 CSS 取值）----
const ruleBody = (sel) => {
  const want = sel.replace(/\s+/g, " ").trim()
  const out = []
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sels = m[1].split(",").map((s) => s.trim().replace(/\s+/g, " "))
    if (sels.includes(want)) out.push(m[2])
  }
  return out.join(" ")
}
const px = (sel, prop) => {
  const m = ruleBody(sel).match(new RegExp(prop + ":\\s*(\\d+)px"))
  return m ? +m[1] : null
}
const G = {
  base: px("#qaRail .qa-dash", "width"),
  hot: px("#qaRail .qa-dash.hot", "width"),
  near: px("#qaRail .qa-dash.near", "width"),
  far: px("#qaRail .qa-dash.far", "width"),
  height: px("#qaRail .qa-dash", "height"),
  gap: px("#qaRail", "gap"),
  left: px("#qaRail", "left"),
}

// ---- 3) 真实 paintQaRipple 源码 ----
const fnBody = (() => {
  const i0 = script.indexOf("function paintQaRipple(")
  let i = script.indexOf("{", i0),
    depth = 0
  for (; i < script.length; i++) {
    if (script[i] === "{") depth++
    else if (script[i] === "}" && --depth === 0) return script.slice(i0, i + 1)
  }
  return ""
})()

const N = 14 // 每栏短横数
const page = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>T76 导轨 hover 判定：改前 / 改后</title>
<style>
:root { ${dark} }
html.light { ${light} }
* { box-sizing: border-box; }
html, body { margin: 0; height: auto; overflow: auto; display: block; }
body { background: var(--bg); color: var(--text); font-family: "Segoe UI", "Microsoft YaHei", sans-serif; padding: 26px 30px 40px; }
h1 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
.sub { font-size: 13px; color: var(--dim); margin: 0 0 18px; line-height: 1.65; }
.row { display: flex; gap: 26px; flex-wrap: wrap; }
.pane { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px 18px; min-width: 330px; }
.pane h2 { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
.pane .tag { font-size: 12px; color: var(--dim); margin: 0 0 14px; }
.tag b { color: var(--err); font-weight: 600; }
.tag i { color: var(--accent); font-style: normal; font-weight: 600; }
.stage { position: relative; display: flex; align-items: flex-start; gap: 14px; }
.guide { position: absolute; left: 0; right: 0; height: 0; border-top: 1px dashed var(--accent); opacity: 0; pointer-events: none; }
.guide.on { opacity: .75; }
.guide span { position: absolute; right: 0; top: -15px; font-size: 11px; color: var(--accent); background: var(--panel); padding: 0 3px; }
.rail { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: ${G.gap}px; padding: 8px 0; }
.rail .qa-dash {
  width: ${G.base}px; height: ${G.height}px; border-radius: 2px; background: var(--border);
  border: none; padding: 0; margin: 0; flex-shrink: 0;
  transition: background .2s ease .05s, width .2s cubic-bezier(.22,.61,.36,1) .05s;
}
.rail .qa-dash.hot, .rail .qa-dash:hover, .rail .qa-dash.near, .rail .qa-dash.far { transition: background .13s ease, width .16s cubic-bezier(.22,.61,.36,1); }
.rail .qa-dash.hot, .rail .qa-dash:hover { background: var(--accent); width: ${G.hot}px; }
.rail .qa-dash.near { background: color-mix(in srgb, var(--dim) 55%, transparent); width: ${G.near}px; }
.rail .qa-dash.far { background: color-mix(in srgb, var(--dim) 30%, transparent); width: ${G.far}px; }
.read { font-size: 12px; color: var(--dim); margin-top: 12px; line-height: 1.7; font-variant-numeric: tabular-nums; }
.read b { color: var(--text); font-weight: 600; }
.read .no { color: var(--err); }
.read .yes { color: var(--accent); }
.bar { display: flex; gap: 3px; margin-top: 6px; align-items: flex-end; height: 20px; }
.bar i { width: 7px; background: var(--border); border-radius: 1px; display: block; }
.bar i.on { background: var(--accent); }
button { font-family: inherit; }
.ctl { margin-bottom: 16px; display: flex; gap: 8px; align-items: center; }
.ctl button { background: transparent; border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 5px 12px; font-size: 12px; cursor: pointer; }
.ctl button:hover { background: var(--panel2); }
.geo { font-size: 12px; color: var(--dim); margin-bottom: 16px; line-height: 1.7; }
.geo code { background: var(--panel2); padding: 1px 5px; border-radius: 4px; font-family: Consolas, monospace; }
</style></head>
<body>
<h1>T76 问答导轨：hover 判定改为「离谁近谁变长」</h1>
<p class="sub">短横高 ${G.height}px、间距 ${G.gap}px —— <b>间隙比短横本身还宽</b>。把鼠标在两栏导轨之间
上下慢慢移动，重点看指针落在两条短横<b>空隙里</b>时哪一条在变长。</p>

<div class="ctl">
  <button id="tg">切换主题</button>
  <span style="font-size:12px;color:var(--dim)">下面是每栏实时的命中结果（不需要真的把指针停在短横上）</span>
</div>
<p class="geo">几何取自 <code>web/index.html</code> 真实 CSS：基准 <code>${G.base}px</code> / near <code>${G.near}px</code> /
far <code>${G.far}px</code> / 最长 <code>${G.hot}px</code>，容器 <code>gap:${G.gap}px</code>、<code>left:${G.left}px</code>。
「改后」那栏直接运行 index.html 里抠出来的真实 <code>paintQaRipple</code>。</p>

<div class="row">
  <div class="pane">
    <h2>改前</h2>
    <p class="tag">只认 <code>:hover</code> —— 指针落在空隙里时一条都不命中，<b>整片波纹熄灭</b></p>
    <div class="stage">
      <div class="guide" id="gBefore"><span>指针位置</span></div>
      <div class="rail" id="railBefore"></div>
      <div class="read" id="rBefore"></div>
    </div>
  </div>
  <div class="pane">
    <h2>改后</h2>
    <p class="tag">按「指针 Y 到各短横中心的距离」取最近 —— 空隙里<i>照样有响应</i></p>
    <div class="stage">
      <div class="guide" id="gAfter"><span>指针位置</span></div>
      <div class="rail" id="railAfter"></div>
      <div class="read" id="rAfter"></div>
    </div>
  </div>
</div>

<script>
${fnBody}

// 改前：忠实复刻 T42 的实现（只按 :hover 定位，不打 .hot）
function paintBefore(rail) {
  const sibs = [...rail.querySelectorAll(".qa-dash")]
  const i = sibs.findIndex((s) => s.matches(":hover"))
  sibs.forEach((s, j) => {
    const d = i < 0 ? -1 : Math.abs(j - i)
    s.classList.toggle("near", d === 1)
    s.classList.toggle("far", d === 2)
  })
}

const N = ${N}
function build(rail, onMove) {
  rail.innerHTML = Array.from({ length: N }, () => '<button class="qa-dash"></button>').join("")
  rail.addEventListener("mousemove", (e) => onMove(e, rail))
  rail.addEventListener("mouseleave", () => onMove(null, rail))
}
const rBefore = document.getElementById("railBefore")
const rAfter = document.getElementById("railAfter")

function report(id, rail, pointerY) {
  const ds = [...rail.querySelectorAll(".qa-dash")]
  const hot = ds.map((d, k) => (d.classList.contains("hot") ? k : d.matches(":hover") ? k : -1)).filter((k) => k >= 0)
  const hover = ds.some((d) => d.matches(":hover"))
  const widths = ds.map((d) => Math.round(d.getBoundingClientRect().width))
  const el = document.getElementById(id)
  el.innerHTML =
    "指针 Y：" + (pointerY == null ? "（已移出）" : Math.round(pointerY)) +
    "<br>被命中：<b>" + (hot.length ? "第 " + hot.map((h) => h + 1).join("、") + " 条" : "无") + "</b>" +
    "<br>真实 :hover：" + (hover ? '<span class="yes">有</span>' : '<span class="no">无</span>') +
    '<div class="bar">' + widths.map((w) => '<i class="' + (w > ${G.base} ? "on" : "") + '" style="height:' + Math.round((w / ${G.hot}) * 20) + 'px"></i>').join("") + "</div>" +
    '<span style="font-size:11px">各条宽度：' + widths.join(" / ") + "</span>"
}

function guide(id, stage, pointerY) {
  const g = document.getElementById(id)
  if (pointerY == null) { g.classList.remove("on"); return }
  const rail = stage.querySelector(".rail")
  g.classList.add("on")
  g.style.top = (pointerY - rail.getBoundingClientRect().top + rail.offsetTop + 8) + "px"
}

build(rBefore, (e, rail) => {
  const y = e ? e.clientY : null
  rail.__paintY = y
  paintBefore(rail)
  report("rBefore", rail, y)
  guide("gBefore", rail.parentElement, y)
})
build(rAfter, (e, rail) => {
  rail.__qaPointerY = e ? e.clientY : null
  paintQaRipple(rail)
  report("rAfter", rail, rail.__qaPointerY)
  guide("gAfter", rail.parentElement, rail.__qaPointerY)
})
// 空隙里不会触发短横自身的 hover 事件，但两栏都要跟着容器 mousemove 走：
// 改前那栏故意只在短横真正 hover 时才有反应（这正是差异所在），所以这里不再补事件。
document.getElementById("tg").onclick = () => document.documentElement.classList.toggle("light")
document.documentElement.classList.add("light")
</script>
</body></html>
`

writeFileSync(resolve(root, "t76-preview.html"), page)
console.log("已生成 t76-preview.html")
console.log("几何(取自真实 CSS)：", JSON.stringify(G))
console.log("真实 paintQaRipple 源码长度：", fnBody.length, "字节")
