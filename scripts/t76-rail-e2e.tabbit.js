// T76 真机取证：在真实页面里用真实鼠标移动，验证「指针落在两短横之间的间隙里时，离谁近谁变长」
//
// 两个已知陷阱（都踩过）：
//  ① playground 的标签页在后台时 **CSS 过渡不推进**（rAF/compositor 被暂停），
//     直接量 getBoundingClientRect().width 会永远读到过渡起点 20px → 必须临时关掉 transition 读目标值。
//  ② 侧栏默认收起（ui.side=collapsed），.sess 点不到 → 直接调页面里真实的 openSession()。
const BASE = "http://127.0.0.1:8642/"
const SID = "713f8629" // 42 轮的会话，导轨够长

await page.goto(BASE, { waitUntil: "domcontentloaded" })
// 注：不调 page.bringToFront()（当前任务策略 foregroundPolicy=preserve，且它会抢用户焦点）。
// 后台标签页过渡不推进的问题，改由 measure() 里临时关掉 transition 读目标值来规避。
await page.waitForSelector(".sess", { timeout: 25000 })
await page.evaluate(async (sid) => {
  await openSession(sid)
}, SID)
await page.waitForSelector("#qaRail.show .qa-dash", { timeout: 30000 })

// 浏览器 CSSOM 里到底有没有 .hot 规则（排除"页面是旧的"）
const cssom = await page.evaluate(() => {
  const hit = []
  for (const ss of document.styleSheets) {
    let rules
    try {
      rules = ss.cssRules
    } catch {
      continue
    }
    for (const r of rules) if (r.selectorText && r.selectorText.includes(".qa-dash")) hit.push(r.selectorText)
  }
  return hit
})

const geo = await page.evaluate(() => {
  const ds = [...document.getElementById("qaRail").querySelectorAll(".qa-dash")]
  const rr = document.getElementById("qaRail").getBoundingClientRect()
  return {
    railLeft: rr.left,
    n: ds.length,
    centers: ds.map((d) => {
      const r = d.getBoundingClientRect()
      return { top: r.top, h: r.height, c: r.top + r.height / 2 }
    }),
  }
})

const i = Math.floor(geo.n / 2)
const a = geo.centers[i]
const b = geo.centers[i + 1]
const gapMid = (a.c + b.c) / 2
const X = geo.railLeft + 6 // 落在导轨内，但不压在任何短横上

// 关掉过渡读"目标宽度"，避免后台标签页量到过渡起点；返回时只留目标附近 7 条，输出可读
const measure = () =>
  page.evaluate(() => {
    const rail = document.getElementById("qaRail")
    const ds = [...rail.querySelectorAll(".qa-dash")]
    const prev = ds.map((d) => d.style.transition)
    ds.forEach((d) => (d.style.transition = "none"))
    void rail.offsetWidth
    const hot = ds.map((d, k) => (d.classList.contains("hot") ? k : -1)).filter((k) => k >= 0)
    const widths = ds.map((d) => Math.round(d.getBoundingClientRect().width))
    const hoverAny = ds.some((d) => d.matches(":hover"))
    ds.forEach((d, k) => (d.style.transition = prev[k]))
    const at = hot[0] ?? 0
    const from = Math.max(0, at - 3)
    return { hot, widths: widths.slice(from, at + 4), from, hoverAny }
  })

const probe = async (y) => {
  for (let t = 0; t < 3; t++) {
    await page.mouse.move(X, y)
    await page.waitForTimeout(300)
    const m = await measure()
    if (m.hot.length > 0) return m
  }
  return await measure()
}

const r = {
  cssomHasHotRule: cssom.some((s) => s.includes(".qa-dash.hot")),
  dashes: geo.n,
  dashH: geo.centers[0]?.h,
  step: geo.centers.length > 1 ? +(geo.centers[1].c - geo.centers[0].c).toFixed(2) : null,
  targetPair: [i, i + 1],
  gapMidY: +gapMid.toFixed(2),
  onCenterUpper: await probe(a.c),
  onCenterLower: await probe(b.c),
  gapNearLower: await probe(gapMid + 1),
  gapNearUpper: await probe(gapMid - 1),
  offRail: await (async () => {
    await page.mouse.move(X - 200, 5)
    await page.waitForTimeout(300)
    return await measure()
  })(),
}
return JSON.stringify(r)
