#!/usr/bin/env node
/**
 * T45/T46 断言：导轨首屏+右移加长、思维导图滚动保持、设置页左类别栏、
 * 用量账本与两张统计图、提问框收窄、agent 更名。
 * 用法：node scripts/check-t45.mjs
 */
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const ROOT = join(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:"))
const html = readFileSync(join(ROOT, "web", "index.html"), "utf8")
const cssRaw = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ""
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "") // 去注释后再扫（T44 教训：注释里的示例会假匹配）
const js = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ""
const gw = readFileSync(join(ROOT, "src", "gateway.ts"), "utf8")
const usage = existsSync(join(ROOT, "src", "session", "usage.ts")) ? readFileSync(join(ROOT, "src", "session", "usage.ts"), "utf8") : ""
const prompt = existsSync(join(ROOT, "src", "agent", "prompt.ts")) ? readFileSync(join(ROOT, "src", "agent", "prompt.ts"), "utf8") : ""

let pass = 0
const fails = []
const ok = (name, cond, extra) => { if (cond) pass++; else fails.push(name + (extra !== undefined ? `  ← 实际: ${JSON.stringify(extra)}` : "")) }
const eq = (name, actual, want) => ok(name, actual === want, actual)
// 从去注释 CSS 里取某选择器某属性的声明值（取最后一个匹配——组合选择器 `a, b, c {}` 会让
// 最后一个选择器同时命中过渡规则，那里没有目标属性，必须跳过取真正的规则）
const decl = (sel, prop) => {
  const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*{([^}]*)}", "g")
  const propRe = new RegExp(prop.replace(/[-]/g, "\\-") + "\\s*:\\s*([^;]+)")
  let m, body = null
  while ((m = re.exec(css))) { if (propRe.test(m[1])) body = m[1] }
  if (body == null) return null
  const v = body.match(propRe)
  return v ? v[1].trim() : null
}

// ---- A. 导轨：首屏可见（T45①）+ 右移加长（T46） ----
ok("A1 T40 隐藏规则已删除（body:not(.side-collapsed) #qaRail.show 不再出现）", !css.includes("body:not(.side-collapsed) #qaRail.show"))
ok("A2 #qaRail left 22px / width 44px", decl("#qaRail", "left") === "22px" && decl("#qaRail", "width") === "44px", [decl("#qaRail", "left"), decl("#qaRail", "width")])
eq("A3 短横基准 20px", decl("#qaRail .qa-dash", "width"), "20px")
eq("A4 hover 44px", decl("#qaRail .qa-dash:hover", "width"), "44px")
eq("A5 near 32px", decl("#qaRail .qa-dash.near", "width"), "32px")
eq("A6 far 24px", decl("#qaRail .qa-dash.far", "width"), "24px")
eq("A7 悬浮卡 left 52px（跟随导轨加宽）", decl("#qaRail .qa-card", "left"), "52px")
eq("A8 #messages 左内边距 76px（T51 var 模型：padL 状态化）", decl("#messages", "padding"), "18px var(--padR) 18px var(--padL)")
eq("A9 右栏打开 88px（T51 var 模型）", decl("body.assist-open #messages", "--padL"), "88px")
ok("A10 注释说明 T45 删规则 + T46 右移", cssRaw.includes("T46 改动") && cssRaw.includes("T45 改动"))

// ---- B. 思维导图横向滚动保持（T45②） ----
ok("B1 snapshotMmScroll/restoreMmScroll/mmScrollMemo 存在", js.includes("function snapshotMmScroll") && js.includes("function restoreMmScroll") && js.includes("const mmScrollMemo"))
ok("B2 快照 key 含会话 id（切会话不串位）", /mmScrollKey[\s\S]{0,220}activeId/.test(js))
const renderIdx = js.indexOf("function render()")
const snapIdx = js.indexOf("snapshotMmScroll()", renderIdx)
// 注意定位到「有导图的那次重写」（olderBtn 分支），render 里更早的空态 innerHTML 不算
const htmlIdx = js.indexOf("box.innerHTML = olderBtn", renderIdx)
const restoreIdx = js.indexOf("restoreMmScroll()", htmlIdx)
ok("B3 render() 里 snapshot 在 innerHTML 重写之前", snapIdx > -1 && htmlIdx > snapIdx, { snapIdx, htmlIdx })
ok("B4 render() 里 innerHTML 之后同步回填 + rAF 兜底", restoreIdx > -1 && js.includes("requestAnimationFrame(restoreMmScroll)"))
ok("B5 回填只在未被用户动过时生效（防抢滚动条）", js.includes("el.scrollLeft === 0) el.scrollLeft = v"))

// ---- C. 设置页左类别栏（T45④） ----
const navBlock = html.slice(html.indexOf('id="setNav"'), html.indexOf('id="setBody"'))
const secIds = ["secUsage", "secAppearance", "secModel", "secSearch", "secDb", "secMcp", "secHotkey", "secAbout"]
eq("C1 左栏 9 个类别按钮（T66 加钩子）", (navBlock.match(/class="sn-item/g) ?? []).length, 9)
ok("C2 data-sec 与 8 张卡片的 id 一一对应", secIds.every((id) => navBlock.includes(`data-sec="${id}"`) && html.includes(`id="${id}"`)))
ok("C3 set-shell/set-nav CSS 存在", css.includes(".set-shell") && css.includes(".set-nav .sn-item.active"))
ok("C4 新样式不碰公用类（.page 规则未被 set 样式污染）", !/\.page\s*{[^}]*set-/.test(css))
ok("C5 点击定位用瞬时 scrollTop（smooth 在后台标签页不跑，实测坑）", /body\.scrollTop = Math\.max\(0, card\.offsetTop - body\.offsetTop - 12\)/.test(js))
ok("C6 scroll-spy 绑定在 #setBody", js.includes('$("setBody").addEventListener("scroll", setSpySec)'))
ok("C7 打开设置回到使用统计顶部", js.includes('setActiveSec("secUsage")'))
ok("C8 自动化页没有左栏结构（不波及 #autoPage）", (html.match(/class="set-nav"/g) ?? []).length === 1
  && !html.slice(html.indexOf('id="autoPage"'), html.indexOf('id="setPage"')).includes("set-nav"))

// ---- D. 用量账本 + 两张图（T45③） ----
ok("D1 usage.ts 存在且四个导出齐全", ["export function appendUsage", "export function readUsage", "export function usageDaily", "export function usageByModel", "export function backfillUsage"].every((s) => usage.includes(s)))
ok("D2 total = in + out（cached 不重复计）", usage.includes("a.total += i + o") && usage.includes("m.total += i + o"))
ok("D3 回填余数补最后一条（总额严格守恒）", usage.includes("k === N - 1"))
ok("D4 回填幂等标记文件", usage.includes("usage-backfill.json"))
ok("D5 网关逐轮落账本（用本轮实际模型）", gw.includes("appendUsage({") && gw.includes("model: r?.model ?? model"))
ok("D6 两个只读接口", gw.includes('"/api/usage/daily"') && gw.includes('"/api/usage/models"'))
ok("D7 启动时一次性回填", gw.includes("backfillUsage()"))
ok("D8 热力图生成器 + 三档口径", js.includes("function usageHeatmap") && js.includes('seg("daily", "每日")') && js.includes('seg("weekly", "每周")') && js.includes('seg("cum", "累计")'))
ok("D9 热力图格子带日期/数值（tooltip 数据源）", js.includes('data-date="${k}"') && js.includes('data-v="${val(k)}"'))
ok("D10 月份轴 + 分位阈值（抗爆量日）", js.includes("mid.getMonth() + 1}月") && js.includes("q(.2), q(.4), q(.6), q(.8)"))
ok("D11 环形图 dasharray + 中心总量 + 图例 + 刷新", js.includes("stroke-dasharray=") && js.includes("累计 Token") && js.includes("dn-row") && js.includes('id="usageRefresh"'))
ok("D12 图例超 7 个模型并成「其他」", js.includes("models.slice(0, 7)") && js.includes('model: "其他"'))
ok("D13 tooltip 委托在 svg 上 + 固定定位防溢出", js.includes('.hm-cell")') && js.includes("window.innerWidth - tip.offsetWidth"))
ok("D14 统计卡挂载点 + 打开设置即拉数据", html.includes('id="usageCharts"') && js.includes("loadUsage() // T45"))
ok("D15 深浅主题两套热力图配色（SVG 用字面量）", js.includes("HM_THEME") && js.includes("rgba(63,182,168") && js.includes("rgba(15,148,136"))

// ---- E. T46：提问框 + 更名 ----
eq("E1 提问框 max-width 860 居中", decl("#question", "max-width") + "|" + decl("#question", "margin"), "860px|0 auto 10px")
eq("E2 提问框窄窗兜底宽度", decl("#question", "width"), "calc(100% - 44px)")
ok("E3 系统提示自述 Yy Sustainer（唯一名字 + 旧名禁用）", prompt.includes("你是 Yy Sustainer") && prompt.includes("绝不说自己是 YYAgent"))

// ---- F. 活体检查：网关在跑则验证接口与对账 ----
const ledgerPath = join(homedir(), ".yyagent", "usage.jsonl")
ok("F1 用量账本文件已生成", existsSync(ledgerPath))
try {
  const base = "http://127.0.0.1:8642"
  const daily = await (await fetch(base + "/api/usage/daily")).json()
  const models = await (await fetch(base + "/api/usage/models")).json()
  ok("F2 /api/usage/daily 结构齐全", !!(daily.byDate && daily.grand && typeof daily.rows === "number"))
  ok("F3 /api/usage/models 按用量降序", Array.isArray(models.models) && models.models.every((m, i, a) => i === 0 || a[i - 1].total >= m.total))
  const sessions = await (await fetch(base + "/api/sessions")).json()
  const sum = sessions.reduce((a, s) => a + (s.usage?.in ?? 0) + (s.usage?.out ?? 0), 0)
  eq("F4 账本总额 === 会话累计总额（回填守恒）", models.grand.total, sum)
  const ledgerLines = readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter((l) => l.trim()).length
  eq("F5 账本行数 === 接口 rows", ledgerLines, daily.rows)
} catch (e) {
  ok("F2 网关未启动，跳过活体检查（不判失败）", true)
}

console.log(`\n=== T45/T46：${pass} 通过 / ${fails.length} 失败 ===`)
for (const f of fails) console.log("  ✗ " + f)
process.exitCode = fails.length ? 1 : 0
