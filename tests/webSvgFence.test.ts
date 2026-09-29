/**
 * svg 围栏协议的净化器行为测试（白皮书 10.33）。
 *
 *  背景：svg 围栏让模型手写 SVG 直通渲染，但模型输出半可信——提示注入能让它吐出带
 *  `<script>`/`onclick=` 的 SVG，在 Web/Electron 渲染器里就是 XSS。净化器
 *  （web/index.html 的 sanitizeSvg）是这条协议的安全闸，六条规则各有用例：
 *   ① 认不出 `<svg…</svg>` → null（降级）
 *   ② script / foreignObject / style 元素整体剥掉
 *   ③ on* 事件属性三种引号形态全剥
 *   ④ href 只允许 # 片段
 *   ⑤ javascript:/vbscript: 开头、或含实体编码（&#）的属性值整属性删
 *   ⑥ 净化后还含 `<svg` 否则 null
 *
 *  做法同 webMcpBtn：从 index.html 按标记抽出函数，new Function 里执行——
 *  标记没了测试大声失败（逼 conscious 更新）。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const web = readFileSync(fileURLToPath(new URL("../web/index.html", import.meta.url)), "utf8")

/** 抽 sanitizeSvg + renderSvgBlock（到 renderSvgBlock 结束的花括号为止太脆弱，改用显式结束标记） */
function extractSanitizer(): string {
  const start = web.indexOf("function sanitizeSvg(src)")
  assert.ok(start > 0, "抽不到 sanitizeSvg——web/index.html 里没了？来本文件更新抽取边界")
  const endMarker = "\n}\n"
  const end = web.indexOf(endMarker, web.indexOf("return s", start))
  assert.ok(end > start, "找不到 sanitizeSvg 的结尾")
  return web.slice(start, end + 2)
}

const sanitize = new Function(extractSanitizer() + "; return sanitizeSvg")() as (src: string) => string | null

/** 第二道闸的纯策略（节点测试覆盖判据本身；DOM 遍历是管道，由 check-t49 静态守卫） */
function extractPolicy(): string {
  const start = web.indexOf("function svgElForbidden")
  const end = web.indexOf("/** 第二道闸：对已写入 DOM")
  assert.ok(start > 0 && end > start, "抽不到第二道闸策略函数——web/index.html 里没了？来本文件更新抽取边界")
  return web.slice(start, end)
}
const policy = new Function(extractPolicy() + "; return { svgElForbidden, svgAttrForbidden }")() as {
  svgElForbidden: (tag: string) => boolean
  svgAttrForbidden: (name: string, val: string) => boolean
}

test("① 认不出 svg 区间 → null（调用方降级为代码块）", () => {
  assert.equal(sanitize("这不是 svg，只是普通文本"), null)
  assert.equal(sanitize("<svg><circle"), null, "未闭合的 svg 也不该通过")
  assert.equal(sanitize(""), null)
})

test("② 可执行/可外载元素整体剥掉（script / foreignObject / style）", () => {
  const evil = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><script>alert(1)</script><foreignObject><body onclick="x()">hi</body></foreignObject><style>@import url(https://evil.com/x.css);</style><circle cx="10" cy="10" r="5" fill="#f00"/></svg>'
  const out = sanitize(evil)
  assert.ok(out, "净化后不该变 null——剩下的 circle 是合法的")
  assert.ok(!out.includes("<script"), out)
  assert.ok(!out.includes("alert(1)"), "脚本正文也不该留")
  assert.ok(!out.includes("foreignObject"), out)
  assert.ok(!out.includes("<style"), out)
  assert.ok(!out.includes("evil.com"), out)
  assert.ok(out.includes("<circle"), "合法图形必须保留")
})

test("③ on* 事件属性三种引号形态全剥", () => {
  const evil = '<svg viewBox="0 0 10 10"><rect width="8" height="8" onclick="steal()" fill="#00f"/><rect width="6" height="6" onload=\'steal()\'/><a onmouseover=steal()>x</a></svg>'
  const out = sanitize(evil)
  assert.ok(out)
  for (const pat of ["onclick", "onload", "onmouseover", "steal()"]) {
    assert.ok(!out.includes(pat), `事件属性没剥干净：${pat} — ${out}`)
  }
  assert.ok(out.includes("<rect"), "合法 shape 要保留")
})

test("④ href 只允许 # 片段（挡外链图片/跳转/data:）", () => {
  const evil = '<svg viewBox="0 0 10 10"><image href="https://evil.com/track.png" width="4" height="4"/><image xlink:href="#localOk" width="4" height="4"/><a href="https://evil.com">go</a><use href="data:image/svg+xml,<svg/>"/></svg>'
  const out = sanitize(evil)
  assert.ok(out)
  assert.ok(!out.includes("evil.com"), `外链没剥：${out}`)
  assert.ok(!out.includes("data:"), `data: URI 没剥：${out}`)
  assert.ok(out.includes('href="#localOk"'), "片段引用必须保留")
})

test("⑤ 危险 scheme 与实体编码属性值整属性删", () => {
  const js = '<svg viewBox="0 0 10 10"><a href="javascript:alert(1)">x</a><rect width="2" height="2" fill="JaVaScRiPt:alert(1)"/></svg>'
  const out = sanitize(js)
  assert.ok(out)
  assert.ok(!/javascript/i.test(out), `危险 scheme 没删净：${out}`)
  const ent = '<svg viewBox="0 0 10 10"><a href="java&#115;cript:alert(1)">x</a><rect width="2" height="2"/></svg>'
  const out2 = sanitize(ent)
  assert.ok(out2)
  assert.ok(!out2.includes("&#115;"), `实体编码没删：${out2}`)
  assert.ok(!out2.includes("cript:alert"), `实体编码解码后就是危险 scheme：${out2}`)
})

test("⑥ 净化后必须还含 svg 根；合法 SVG 原样通过（不改内容）", () => {
  const ok = '<svg viewBox="0 0 680 300" xmlns="http://www.w3.org/2000/svg"><rect x="40" y="40" width="120" height="44" rx="8" fill="#E1F5EE" stroke="#0F6E56"/><text x="100" y="62" font-size="14">节点</text><a href="#sec"><text x="100" y="90">跳转</text></a></svg>'
  const out = sanitize(ok)
  assert.equal(out, ok, "合法 SVG 必须一个字节都不改（直通渲染的代价是对的方向）")
  assert.ok(out.includes("<svg"), "根元素要在")
})

// ---------- 第二道闸的策略（10.34：解析后 DOM 清场的判据） ----------

test("元素名单：script/foreignObject/style 禁，普通图形元素放行", () => {
  for (const t of ["script", "foreignObject", "style", "SCRIPT"]) {
    assert.equal(policy.svgElForbidden(t), true, `${t} 该禁`)
  }
  for (const t of ["rect", "text", "g", "svg", "defs", "marker", "image"]) {
    assert.equal(policy.svgElForbidden(t), false, `${t} 该放行`)
  }
})

test("属性策略：on* 全禁、href 仅 # 片段、危险 scheme 禁、主题变量放行", () => {
  // on*（解析后 DOM 拿到的是解码后的真实属性名与值）
  assert.equal(policy.svgAttrForbidden("onclick", "steal()"), true)
  assert.equal(policy.svgAttrForbidden("onload", "x"), true)
  assert.equal(policy.svgAttrForbidden("ONMOUSEOVER", "x"), true, "大小写不敏感")
  // href 仅片段（外链图片/跳转/data: 都禁；本 diagram 内 marker 引用放行）
  assert.equal(policy.svgAttrForbidden("href", "#arrow"), false)
  assert.equal(policy.svgAttrForbidden("xlink:href", "#icon"), false)
  assert.equal(policy.svgAttrForbidden("href", "https://evil.com/track.png"), true)
  assert.equal(policy.svgAttrForbidden("href", "data:image/svg+xml,<svg/>"), true)
  // 危险 scheme——含「实体已解码」场景：正则闸看到的 java&#115;cript: 在 DOM 里就是 javascript:
  assert.equal(policy.svgAttrForbidden("href", "javascript:alert(1)"), true)
  assert.equal(policy.svgAttrForbidden("fill", "JaVaScRiPt:alert(1)"), true)
  // 正常属性一律放行（尤其主题变量——第二道闸不能误伤 10.33 的主题适配成果）
  assert.equal(policy.svgAttrForbidden("fill", "var(--text)"), false)
  assert.equal(policy.svgAttrForbidden("stroke", "var(--border)"), false)
  assert.equal(policy.svgAttrForbidden("class", "node-label"), false)
  assert.equal(policy.svgAttrForbidden("viewBox", "0 0 680 300"), false)
})
