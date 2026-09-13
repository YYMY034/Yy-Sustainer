// T76 回归：导轨 hover 判定改为「按指针 Y 到各短横中心的距离取最近一条」。
//
// 病根：`#qaRail .qa-dash` 高 3px、容器 `gap: 6px` —— **间隙比短横本身还宽**。
// 旧实现用 `s.matches(":hover")` 找"指针所在的那条"，指针落在两短横之间时一条都不命中，
// 于是 ±1 near / ±2 far 全被清掉，整片波纹熄灭（用户反馈"划过就断"）。
// 改法：rail 容器（.show 时 pointer-events:auto）接 mousemove，把指针 Y 写进 rail.__qaPointerY，
// paintQaRipple 按 |指针Y − 短横中心Y| 取最近者加 .hot（CSS 给 .hot 与 :hover 同一套 44px 样式）。
//
// 本脚本除了断言源码，还**把 paintQaRipple 原样抠出来**喂假 DOM 跑，直接证明"间隙里也有响应"。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const html = readFileSync(resolve(root, "web/index.html"), "utf8")
const cssRaw = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "") // 先剥注释再断言，否则会被自己的说明文字命中

let pass = 0,
  fail = 0
const ok = (n, v, extra) => {
  if (v) {
    pass++
    console.log("OK   " + n)
  } else {
    fail++
    console.log("FAIL " + n + (extra !== undefined ? "  → " + extra : ""))
  }
}
const eq = (n, actual, expect) => ok(n, actual === expect, `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expect)}`)

// ---- 规则扫描（精确比对选择器，逗号分组也认）----
function findRules(cssText, sel) {
  const want = sel.replace(/\s+/g, " ").trim()
  const out = []
  for (const m of cssText.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sels = m[1].split(",").map((s) => s.trim().replace(/\s+/g, " "))
    if (sels.includes(want)) out.push(m[2])
  }
  return out
}
const bodiesOf = (sel) => findRules(css, sel)

console.log("=== ① CSS：.hot 与 :hover 必须同款（否则 JS 选中的那条不长）===")
const longest = bodiesOf("#qaRail .qa-dash.hot").join(" | ")
const fast = bodiesOf("#qaRail .qa-dash.near").join(" | ")
ok("存在 #qaRail .qa-dash.hot 规则", longest.length > 0, longest || "(没找到)")
ok("最长规则里 .hot 是 44px 主色（与 :hover 同款）", /width:\s*44px/.test(longest) && /var\(--accent\)/.test(longest), longest)
// 反向：真 hover 不能被 .hot 取代（鼠标正落在短横上时仍要走 CSS，不依赖 JS 时序）
const hoverRule = findRules(cssRaw, "#qaRail .qa-dash:hover").join(" | ")
ok(":hover 规则仍在（真 hover 不依赖 JS 时序）", /width:\s*44px/.test(hoverRule), hoverRule || "(没找到)")
ok("快过渡规则组含 .hot（伸长要快，不能等 .2s 缩回节奏）", /cubic-bezier\(\.22,\.61,\.36,1\)/.test(fast), fast)

console.log("\n=== ② CSS：几何未变（T46/T42 的数值不能被这次改动带偏）===")
eq("#qaRail 左缘仍 22px", (css.match(/#qaRail \{[^}]*left:\s*(\d+)px/) || [])[1], "22")
const nearW = (bodiesOf("#qaRail .qa-dash.near").join(" ").match(/width:\s*(\d+)px/) || [])[1]
const farW = (bodiesOf("#qaRail .qa-dash.far").join(" ").match(/width:\s*(\d+)px/) || [])[1]
const baseW = (bodiesOf("#qaRail .qa-dash").join(" ").match(/width:\s*(\d+)px/) || [])[1]
eq("near 仍 32px", nearW, "32")
eq("far 仍 24px", farW, "24")
eq("基准仍 20px", baseW, "20")

console.log("\n=== ③ JS：最近者判定的实现要点 ===")
const fnBody = (() => {
  const i0 = script.indexOf("function paintQaRipple(")
  if (i0 < 0) return ""
  let i = script.indexOf("{", i0),
    depth = 0
  for (; i < script.length; i++) {
    if (script[i] === "{") depth++
    else if (script[i] === "}" && --depth === 0) return script.slice(i0, i + 1)
  }
  return ""
})()
ok("抽到 paintQaRipple 源码", fnBody.length > 0)
ok("读指针 Y：rail.__qaPointerY", /rail\.__qaPointerY/.test(fnBody))
ok("按「指针Y − 短横中心Y」算距离", /getBoundingClientRect\(\)/.test(fnBody) && /r\.top \+ r\.height \/ 2/.test(fnBody))
ok("取绝对值比大小（上下都算）", /Math\.abs\(py - \(r\.top \+ r\.height \/ 2\)\)/.test(fnBody))
ok("没有指针信息时回落 :hover（T42 兜底不被删）", /sibs\.findIndex\(\(s\) => s\.matches\(":hover"\)\)/.test(fnBody))
ok("三个类一起重算 hot/near/far（幂等）", /toggle\("hot"/.test(fnBody) && /toggle\("near"/.test(fnBody) && /toggle\("far"/.test(fnBody))
ok("函数体不引用闭包变量（否则抠出来跑不了）", !/qaRailTimer|railPointer/.test(fnBody))

ok("rail.onmousemove 已接（间隙里的事件只到容器）", /rail\.onmousemove = \(e\) => \{/.test(script))
ok("mousemove 写指针 Y", /rail\.__qaPointerY = e\.clientY/.test(script))
ok("指针离开导轨清空 Y（否则复现旧 hover 会假亮）", /rail\.__qaPointerY = null/.test(script))
ok("滚动期间沿用 T42 屏蔽（scrolling 早退）", /if \(rail\.classList\.contains\("scrolling"\)\) return/.test(script))
ok("旧的无条件清空写法仍未回来", !/querySelectorAll\("\.qa-dash\.near, \.qa-dash\.far"\)/.test(script))

console.log("\n=== ④ 仿真：把 paintQaRipple 抠出来喂假 DOM，移动指针 ===")
let paint = null
try {
  paint = new Function(fnBody + "; return paintQaRipple")()
} catch (e) {
  console.log("  (eval 失败: " + e.message + ")")
}
ok("paintQaRipple 可独立执行", typeof paint === "function")

// 真实几何：短横高 3px、间距 6px → 步长 9px。第 i 条 top = 100 + 9i，中心 = top + 1.5
const H = 3,
  STEP = 9
const makeRail = (n, pointerY = null, hovered = -1) => {
  const dashes = []
  const rail = { __qaPointerY: pointerY, hovered, querySelectorAll: () => dashes }
  for (let i = 0; i < n; i++) {
    const set = new Set()
    dashes.push({
      classList: {
        toggle: (name, on) => (on ? set.add(name) : set.delete(name)),
        contains: (name) => set.has(name),
      },
      matches: (sel) => sel === ":hover" && rail.hovered === i,
      getBoundingClientRect: () => ({ top: 100 + i * STEP, height: H }),
      cls: set,
    })
  }
  return { rail, dashes }
}
const readout = (dashes) => dashes.map((d) => (d.cls.has("hot") ? "H" : d.cls.has("near") ? "N" : d.cls.has("far") ? "F" : ".")).join("")
const run = (n, pointerY, hovered = -1) => {
  const { rail, dashes } = makeRail(n, pointerY, hovered)
  paint(rail)
  return { s: readout(dashes), count: dashes.filter((d) => d.cls.has("hot")).length }
}

if (typeof paint === "function") {
  // n=7 的中心：101.5 / 110.5 / 119.5 / 127.5... 逐条 = 100+9i+1.5
  // 指针精确压在中心点
  eq("指针压在中心点 → 该条 H（余下向外 N/F 递减）", run(7, 119.5).s, "FNHNF..")
  // ★ 核心：指针落在【两短横之间的间隙】里（间隙 6px 宽，比短横本身还宽）
  //   108 落在 idx0 中心(101.5) 与 idx1 中心(110.5) 之间，离 idx1 更近
  eq("★ 指针在间隙里、离下一条近 → 下一条 H（旧实现此处整片熄灭）", run(7, 108).s, "NHNF...")
  //   105 同样在间隙里，但离 idx0 更近
  eq("★ 指针在间隙里、离上一条近 → 上一条 H", run(7, 105).s, "HNF....")
  //   106 是两条中心的正中点 → 平手，规则取更靠上的（d < best 严格小于，先到先得）
  eq("正中间（平手）→ 取更靠上的一条（HNF....）", run(7, 106).s, "HNF....")
  // 边界：指针在导轨上下留白里（::before 各多 10px）
  eq("指针在最上方留白 → 首条 H（不越界）", run(7, 0).s, "HNF....")
  eq("指针在最下方留白 → 末条 H（不越界）", run(7, 999).s, "....FNH")
  // 始终恰好一条 H
  ok("任何位置都恰好一条 H（不会亮两条）", [0, 105, 108, 119.5, 999].every((y) => run(9, y).count === 1))
  // 离开导轨（Y 清空）→ 回落 :hover；也没有 hover 时全清
  eq("指针离开（Y=null）且无 :hover → 波纹全清", run(7, null).s, ".......")
  // 注：兜底路径现在也打 .hot（与 :hover 同一套样式），所以第 3 条是 H 而不是 .
  eq("指针离开但真 :hover 命中第 3 条 → 仍按 :hover 画（T42 兜底）", run(7, null, 2).s, "FNHNF..")
  // 幂等：同一 Y 连续重绘结果不变
  ok("同一位置重复重绘结果不变（幂等）", (() => {
    const { rail, dashes } = makeRail(9, 108)
    paint(rail)
    const a = readout(dashes)
    paint(rail)
    paint(rail)
    return a === readout(dashes)
  })())
  // ★ 反向断言：证明这确实是"新"能力 —— 旧判据（只认 :hover）在间隙里什么也点亮不了
  ok(
    "★ 反向：只认 :hover 的旧判据在间隙里认不出任何一条（=被修的病根）",
    (() => {
      const { rail, dashes } = makeRail(7, 108)
      rail.__qaPointerY = null // 关掉新判据，退回 T42 行为
      paint(rail)
      return readout(dashes) === "......."
    })(),
  )
}

console.log("\n=== ⑤ 语法完整性 ===")
try {
  mkdirSync(resolve(root, ".workbuddy/tmp"), { recursive: true })
  const tmp = resolve(root, ".workbuddy/tmp/t76-check.cjs")
  writeFileSync(tmp, script)
  execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" })
  ok("<script> 通过 node --check（无语法错）", true)
} catch (e) {
  ok("<script> 通过 node --check（无语法错）", false, String(e.stderr || e.message).slice(0, 300))
}
const bal = (css.match(/\{/g) || []).length - (css.match(/\}/g) || []).length
eq("CSS 大括号配平", bal, 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
