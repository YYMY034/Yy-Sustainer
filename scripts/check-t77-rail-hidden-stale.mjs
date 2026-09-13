// T77 回归：修「收起左侧边栏后导轨先出现在偏上位置、再滑回中间」。
//
// 真机取证（tabbit-cli + 真实 Chromium，6 条短横、data-rail=closed）：
//   基准·收起且可见      display=flex clientH=859 transform=""             dashTop=423 ← 正确位
//   隐藏期间滚动         display=none clientH=0   transform=translateY(-13.5px)
//   A collapseSidebar()  display=flex clientH=859 transform=""             dashTop=423 ← 立刻是对的
//   B toggleSidebar()    display=flex clientH=859 transform=translateY(-13.5px) dashTop=410 ← 偏上 13px
//
// 病根（两条，缺一不可）：
//   ① updateQaRailOffset 没有「导轨是否真的参与布局」的判断。display:none 时 rail.clientHeight=0，
//      `colH > railH` 退化成 `colH > 0` 恒真、clamp 上限从 (colH-railH)/2 变成 colH/2（放大一倍），
//      算出的 translateY 是纯垃圾值，写进 style.transform 后**在隐藏期间一直残留**。
//      closed 档下侧栏一展开导轨即隐藏，用户滚一下消息（scroll handler 调本函数）就中毒。
//   ② Ctrl+B 走的 toggleSidebar 自己 classList.toggle，漏了 syncRailOffsetInstant()，
//      于是收起侧栏时导轨带着①的毒值出现（偏上），直到下一次重排触发 updateQaRailOffset
//      才经 .18s 过渡滑回中间 —— 用户看到的就是「先偏上，然后才到中间」。
//
// 改法：① 下沉到源头 —— 无布局盒就清空 offset 并 return，任何显隐路径都不会再有毒值；
//       ② toggleSidebar 委托给 collapseSidebar/expandSidebar，顺带去掉一份重复实现。
//
// 本脚本除了断言源码，还把 updateQaRailOffset **原样抠出来**喂假 DOM 跑三种场景，
// 并附「摘掉守卫 → 必须复现出真机那个 translateY(-13.5px)」的反向断言。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const html = readFileSync(resolve(root, "web/index.html"), "utf8")
const cssRaw = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "")

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

// ---- 抽函数：从 `function NAME(` 开始做花括号配平 ----
function pickFn(name) {
  const i0 = script.indexOf(`function ${name}(`)
  if (i0 < 0) return ""
  let i = script.indexOf("{", i0),
    depth = 0
  for (; i < script.length; i++) {
    if (script[i] === "{") depth++
    else if (script[i] === "}" && --depth === 0) return script.slice(i0, i + 1)
  }
  return ""
}
// ---- 摘掉一个 `if (...) { ... }` 块（用花括号配平，避免正则吃掉后面的代码）----
function stripIfBlock(body, anchor) {
  const a = body.indexOf(anchor)
  if (a < 0) return body
  const start = body.lastIndexOf("if (", a)
  let i = body.indexOf("{", a),
    depth = 0
  for (; i < body.length; i++) {
    if (body[i] === "{") depth++
    else if (body[i] === "}" && --depth === 0) break
  }
  return body.slice(0, body.lastIndexOf("if (", a)) + body.slice(i + 1)
}

const upd = pickFn("updateQaRailOffset")
const sync = pickFn("syncRailOffsetInstant")
const toggle = pickFn("toggleSidebar")
const collapse = pickFn("collapseSidebar")
const expand = pickFn("expandSidebar")

console.log("=== ① 源码：根因① 的守卫（无布局盒就不算、不写、清空并返回）===")
ok("抽到 updateQaRailOffset 源码", upd.length > 0)
ok("存在「没有布局盒」的守卫（!rail.clientHeight）", /if \(!rail\.clientHeight\)/.test(upd))
const guardIdx = upd.indexOf("if (!rail.clientHeight)")
const writeIdx = upd.indexOf("rail.style.transform = offset")
ok("守卫在写 offset 之前（顺序不能反）", guardIdx > 0 && writeIdx > 0 && guardIdx < writeIdx, `guard@${guardIdx} write@${writeIdx}`)
let guardBlock = ""
if (guardIdx >= 0) {
  let i = upd.indexOf("{", guardIdx),
    depth = 0
  for (; i < upd.length; i++) {
    if (upd[i] === "{") depth++
    else if (upd[i] === "}" && --depth === 0) break
  }
  guardBlock = upd.slice(guardIdx, i + 1)
}
ok("守卫里清空可能残留的 transform", /rail\.style\.transform = ""/.test(guardBlock), guardBlock || "(没抽到守卫块)")
ok("清空有条件（仅当确实残留时才写，不做无谓样式失效）", /if \(rail\.style\.transform\)/.test(guardBlock))
ok("守卫里 return（不再往下算垃圾值）", /\breturn\b/.test(guardBlock))
// T64/T61 的关键算法不能被这次改动带偏
ok("保留 colH > railH 才平移（短会话不平移）", /if \(colH > railH\)/.test(upd))
ok("保留 T64 的钳制上限 (colH - railH) / 2", /\(colH - railH\) \/ 2/.test(upd))
ok("保留 T61 的注释意图（勿把导轨锁回 #messages）", /勿加回/.test(upd))

console.log("\n=== ② 源码：根因② 的路径（Ctrl+B 不能再漏 sync）===")
ok("抽到 toggleSidebar 源码", toggle.length > 0)
ok("toggleSidebar 委托 expandSidebar()", /expandSidebar\(\)/.test(toggle))
ok("toggleSidebar 委托 collapseSidebar()", /collapseSidebar\(\)/.test(toggle))
ok("toggleSidebar 不再自己 classList.toggle('side-collapsed')（重复实现已去）", !/classList\.toggle\("side-collapsed"\)/.test(toggle), toggle)
ok("toggleSidebar 不再自己写 localStorage（由被委托方负责）", !/localStorage\.setItem/.test(toggle))
ok("collapseSidebar 仍调 syncRailOffsetInstant（第二道保险）", /syncRailOffsetInstant\(\)/.test(collapse))
ok("expandSidebar 仍调 syncRailOffsetInstant（第二道保险）", /syncRailOffsetInstant\(\)/.test(expand))
ok("syncRailOffsetInstant 本体仍在", sync.length > 0 && /rail\.style\.transition = "none"/.test(sync))
ok("显隐切换点的 sync 调用不少于 T68 时的 6 处", (script.match(/syncRailOffsetInstant\(\)/g) || []).length >= 6, (script.match(/syncRailOffsetInstant\(\)/g) || []).length)

console.log("\n=== ③ 仿真：把 updateQaRailOffset 抠出来喂假 DOM ===")
// 假环境：n 条短横（步长 9px 同真实几何：高 3 + 间距 6），curTarget 之前的消息 offsetTop 落在 scrollTop+40 内
function makeEnv({ clientHeight, n, curTarget, scrollTop = 2449, transform = "" }) {
  const dashes = []
  for (let i = 0; i < n; i++) {
    const set = new Set()
    dashes.push({
      dataset: { idx: String(i) },
      classList: {
        toggle: (k, on) => (on ? set.add(k) : set.delete(k)),
        add: (k) => set.add(k),
        remove: (k) => set.delete(k),
      },
      cls: set,
    })
  }
  const railSet = new Set(["show"])
  const rail = {
    classList: { contains: (k) => railSet.has(k), add: (k) => railSet.add(k), remove: (k) => railSet.delete(k) },
    clientHeight,
    querySelectorAll: () => dashes,
    style: { transform },
  }
  const box = { scrollTop }
  const doc = {
    getElementById: (id) => {
      const i = Number(String(id).replace("msg", ""))
      if (!Number.isFinite(i) || i >= n) return null
      return { offsetTop: i <= curTarget ? scrollTop + 10 : scrollTop + 99999 }
    },
  }
  const $ = (id) => (id === "qaRail" ? rail : id === "messages" ? box : null)
  return { rail, dashes, box, doc, $ }
}
let runFn = null
try {
  runFn = new Function("$", "document", "clearTimeout", "setTimeout", `var qaRailScrollTimer = 0;\n${upd}\nreturn updateQaRailOffset`)
} catch (e) {
  console.log("  (eval 失败: " + e.message + ")")
}
ok("updateQaRailOffset 可独立执行", typeof runFn === "function")

// 注意：new Function 体末尾是 `return updateQaRailOffset`，所以 fn(...) 返回的是「被定义好的那个函数」，
// 必须再调一次才真正执行 —— 漏调的话所有副作用断言都会静默空跑（假通过）。
const call = (fn, env) => {
  const e = makeEnv(env)
  const target = fn(e.$, e.doc, () => {}, () => {})
  if (typeof target !== "function") throw new Error("抠出来的不是函数（new Function 体末尾必须 return 目标函数）")
  target()
  return e
}

if (typeof runFn === "function") {
  // ★ 核心：隐藏态（clientHeight=0）不得写 offset，且要把残留清掉
  const hidden = call(runFn, { clientHeight: 0, n: 6, curTarget: 4, transform: "translateY(-13.5px)" })
  eq("★ 隐藏态：残留的 transform 被清成空（不再中毒）", hidden.rail.style.transform, "")
  ok("★ 隐藏态：真的早退（没给任何短横打 .cur）", hidden.dashes.every((d) => !d.cls.has("cur")))

  // 可见 + 列短于轨 → 不平移（T64 行为：短会话整体居中，offset=0）
  const short = call(runFn, { clientHeight: 859, n: 6, curTarget: 5 })
  eq("可见且列短于轨（48 < 859）→ offset 0", short.rail.style.transform, "")

  // 可见 + 列长于轨 → 按 T64 钳制（n=20：colH=174, maxShift=37, desired=(9.5-19)*9=-85.5 → -37）
  const long = call(runFn, { clientHeight: 100, n: 20, curTarget: 19 })
  eq("可见且列长于轨、cur 靠后 → 钳到 -maxShift", long.rail.style.transform, "translateY(-37px)")
  const longTop = call(runFn, { clientHeight: 100, n: 20, curTarget: 0 })
  eq("可见且列长于轨、cur 靠前 → 钳到 +maxShift", longTop.rail.style.transform, "translateY(37px)")
  ok("可见态仍会给当前轮打 .cur（功能没被守卫误伤）", long.dashes[19].cls.has("cur"))
  ok("可见态仍会挂 scrolling 防抽搐类", long.rail.classList.contains("scrolling"))

  // ★ 反向断言：把守卫摘掉 → 必须复现出真机观测到的 translateY(-13.5px)
  const strippedSrc = stripIfBlock(upd, "!rail.clientHeight")
  ok("反向用例：守卫确实被摘掉了", strippedSrc !== upd && !/!rail\.clientHeight/.test(strippedSrc))
  try {
    const fn2 = new Function("$", "document", "clearTimeout", "setTimeout", `var qaRailScrollTimer = 0;\n${strippedSrc}\nreturn updateQaRailOffset`)
    const bug = call(fn2, { clientHeight: 0, n: 6, curTarget: 4 })
    eq("★ 反向：摘掉守卫后，隐藏态被写入真机那个 translateY(-13.5px)（=被修的病根）", bug.rail.style.transform, "translateY(-13.5px)")
  } catch (e) {
    ok("★ 反向：摘掉守卫后复现病根", false, e.message)
  }
}

console.log("\n=== ④ 几何/公式与真机读数一致（对照校准）===")
eq("短横步长 = 高3 + 间距6 = 9（真机 colH 对得上）", 3 + 6, 9)
// 真机：6 条 → colH = 6*9-6 = 48；隐藏时 railH=0 → maxShift=24；cur=4 → desired=(2.5-4)*9=-13.5
eq("真机 6 条短横的 colH", 6 * 9 - 6, 48)
eq("真机隐藏态 cur=4 对应的 desired", Math.round(((6 - 1) / 2 - 4) * 9 * 10) / 10, -13.5)
// 真机：可见且正确落位时 dashTop=423，残留时 dashTop=410，差 13px 与 -13.5 一致
eq("真机偏上量 423-410 应与 offset 13.5 同量级", 423 - 410, 13)

console.log("\n=== ⑤ 语法完整性 ===")
try {
  mkdirSync(resolve(root, ".workbuddy/tmp"), { recursive: true })
  const tmp = resolve(root, ".workbuddy/tmp/t77-check.cjs")
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
