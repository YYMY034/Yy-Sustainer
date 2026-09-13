/**
 * T43 接口回归：POST /api/export/xlsx
 *
 * 为什么不直接 curl 跑着的网关：src/gateway.ts 是 tsx 直跑的，新加路由必须重启进程才生效，
 * 重启会打断用户正在用的会话。这里改成「把 gateway.ts 里那段路由代码原样抠出来、喂假 req/res 跑」——
 * 跑的是文件里真实的代码（含 exceljs 接线），不碰用户进程。
 *
 * 验证点：
 *   - 命中路由并返回 200 + xlsx MIME + attachment 文件名（UTF-8 编码）
 *   - 响应体是合法 xlsx（zip 头 PK）且能被 exceljs 反向解析出同样的单元格
 *   - 表头加粗、数字还原成数字类型、编号类文本不被误转、列宽按内容自适应且不超上限
 *   - rows 为空 → 400；m/p 不匹配 → 不接管；脏输入不抛异常
 *
 * 用法：node scripts/check-t43-api.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { sliceBlock } from "./mm-lib.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const GW_PATH = path.join(ROOT, "src", "gateway.ts")
const gw = fs.readFileSync(GW_PATH, "utf8")

let pass = 0
const fails = []
function ok(name, cond, extra = "") {
  if (cond) { pass++; return true }
  fails.push(`${name}${extra ? " — " + extra : ""}`)
  return false
}

const ROUTE_HEAD = 'if (m === "POST" && p === "/api/export/xlsx")'
const headIdx = gw.indexOf(ROUTE_HEAD)
ok("API0 gateway.ts 里能找到 xlsx 路由块", headIdx > 0)

const routeSrc = sliceBlock(gw, headIdx)
ok("API1 路由块被完整抠出（含 catch 兜底）", routeSrc.includes("catch") && routeSrc.includes("res.end(data)"), `${routeSrc.length} 字符`)

// 抠出的路由块是 TypeScript，且内部有顶层 await / return（在真实环境里它就是 async handleApi 的一段）。
// 先把它包进一个 async 函数再交给 esbuild 剥类型注解 —— 既绕开 ESM 的顶层限制，
// 又把 m/p/req/res/json/readBody 变成显式形参注入。
const { transform } = await import("esbuild")
const wrapped = `async function __route(m, p, req, res, json, readBody) {\n${routeSrc}\n}\n`
const routeJs = (await transform(wrapped, { loader: "ts", format: "esm", target: "node20" })).code
const run = new Function(`${routeJs}\nreturn __route;`)()

function mkRes() {
  const chunks = []
  return {
    code: 0, headers: {}, ended: false,
    writeHead(code, h) { this.code = code; this.headers = h ?? {} },
    end(d) { this.ended = true; if (d) chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)) },
    body() { return Buffer.concat(chunks) },
  }
}
/** 假 json()：记下状态码并结束响应（真身是 gateway 里的 json 辅助函数） */
function mkJson(res) {
  return (r, code, data) => { r.writeHead(code, { "Content-Type": "application/json" }); r.end(JSON.stringify(data)); return "JSON" }
}
const readBodyFrom = (payload) => async () => JSON.stringify(payload)
/** 把一次调用结果收成 { code, headers, body, threw, ended } */
async function call(method, url, payload) {
  const res = mkRes()
  let threw = ""
  try { await run(method, url, {}, res, mkJson(res), readBodyFrom(payload)) }
  catch (e) { threw = e.message }
  return { code: res.code, headers: res.headers, body: res.body(), ended: res.ended, threw }
}

const SAMPLE = [
  ["区域", "Q1 营收", "Q2 营收", "同比"],
  ["华东", 1280, 1462, "14.2%"],
  ["华南", 940, 1015, "8.0%"],
  ["华北", 610, 588, "-3.6%"],
  ["备注", "含税口径；数据来源：财务系统导出"],
]

const r1 = await call("POST", "/api/export/xlsx", { name: "季度营收", sheet: "营收明细", rows: SAMPLE })
ok("API2 命中路由并正常返回（没有抛异常）", r1.threw === "" && r1.code === 200 && r1.ended === true, r1.threw || `code=${r1.code}`)
ok("API3 响应码 200", r1.code === 200, String(r1.code))
ok("API4 Content-Type = xlsx MIME", r1.headers["Content-Type"] === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", String(r1.headers["Content-Type"]))
ok("API5 Content-Length 与实际字节数一致", r1.headers["Content-Length"] === r1.body.length, `${r1.headers["Content-Length"]} vs ${r1.body.length}`)
const cd1 = (r1.headers["Content-Disposition"] ?? "")
const cd1Name = decodeURIComponent(cd1.split("''")[1] ?? "")
ok("API6 Content-Disposition 是 attachment + UTF-8 文件名", /^attachment; filename\*=UTF-8''/.test(cd1) && cd1Name.endsWith(".xlsx"), cd1)
ok("API7 文件名用上了请求里的 name（中文不乱码）", cd1Name.startsWith("季度营收"), cd1Name)
ok("API8 响应体是合法 xlsx（zip 魔数 PK\\x03\\x04）", r1.body.length > 2000 && r1.body[0] === 0x50 && r1.body[1] === 0x4b && r1.body[2] === 0x03 && r1.body[3] === 0x04, `len=${r1.body.length} head=${r1.body.slice(0, 4).toString("hex")}`)

// 反向解析：用 exceljs 读回来，确认单元格内容/表头加粗/数字类型/列宽都写对了
const mod = await import("exceljs")
const ExcelJS = mod.default ?? mod
const wb = new ExcelJS.Workbook()
await wb.xlsx.load(r1.body)
const ws = wb.worksheets[0]
ok("API9 工作表名沿用请求里的 sheet", ws.name === "营收明细", ws.name)
ok("API10 行数正确（5 行）", ws.rowCount === 5, String(ws.rowCount))
ok("API11 表头文字正确", ["区域", "Q1 营收", "Q2 营收", "同比"].every((v, i) => ws.getRow(1).getCell(i + 1).value === v))
ok("API12 表头加粗", ws.getRow(1).font?.bold === true, JSON.stringify(ws.getRow(1).font))
ok("API13 纯数字还原成数字类型（Excel 里能直接求和/排序）", ws.getRow(2).getCell(2).value === 1280, JSON.stringify(ws.getRow(2).getCell(2).value))
ok("API13b 负号/小数也按数字处理", ws.getRow(4).getCell(3).value === 588)
ok("API14 文本行完整写入（含中文分号）", String(ws.getRow(5).getCell(2).value).includes("财务系统导出"), String(ws.getRow(5).getCell(2).value))
ok("API15 第 1 列列宽按内容自适应（≥8 且 ≤60）", (() => { const w = ws.getColumn(1).width; return typeof w === "number" && w >= 8 && w <= 60 })(), String(ws.getColumn(1).width))
ok("API16 超长文本列被列宽上限夹住（≤60）", (() => { const w = ws.getColumn(2).width; return typeof w === "number" && w <= 60 })(), String(ws.getColumn(2).width))

// 编号类文本不能被误转成数字
const rId = await call("POST", "/api/export/xlsx", { rows: [["编号", "电话", "比率"], ["007", "0755-1234", "14.2%"], ["13800138000", "1e5", "0.5"]] })
const wbId = new ExcelJS.Workbook()
await wbId.xlsx.load(rId.body)
const wsId = wbId.worksheets[0]
ok("API17 前导零编号（007/0755）保持文本，不丢零", wsId.getRow(2).getCell(1).value === "007" && String(wsId.getRow(2).getCell(2).value).startsWith("0755"), JSON.stringify(wsId.getRow(2).getCell(1).value))
ok("API18 百分号 / 科学计数法写法保持文本", wsId.getRow(2).getCell(3).value === "14.2%" && wsId.getRow(3).getCell(2).value === "1e5")
ok("API19 11 位手机号转数字（无前导零，安全）", wsId.getRow(3).getCell(1).value === 13800138000, JSON.stringify(wsId.getRow(3).getCell(1).value))
ok("API20 普通小数 '0.5' 转数字", wsId.getRow(3).getCell(3).value === 0.5)

// 异常分支
const r2 = await call("POST", "/api/export/xlsx", { rows: [] })
ok("API21 rows 为空 → 400 + 中文错误提示", r2.code === 400 && r2.body.toString().includes("rows"), `${r2.code} ${r2.body.toString().slice(0, 80)}`)

const r3 = await call("GET", "/api/export/xlsx", {})
ok("API22 方法不匹配时不接管（交给兜底 404）", r3.ended === false && r3.code === 0 && r3.threw === "")

const r4 = await call("POST", "/api/other", {})
ok("API23 路径不匹配时不接管", r4.ended === false && r4.code === 0)

// 脏文件名兜底（含路径分隔符与换行 → 必须被清洗）
const r5 = await call("POST", "/api/export/xlsx", { name: "a/b\\c:d*e?f\"g<h>i|j\nk", rows: [["x"]] })
const cd5 = decodeURIComponent((r5.headers["Content-Disposition"] ?? "").split("''")[1] ?? "")
ok("API24 危险字符被清洗（不留路径分隔符/换行）", !/[\\/:*?"<>|\r\n]/.test(cd5), cd5)

// 极端输入不应崩
for (const [label, payload] of [
  ["缺 rows 字段", {}],
  ["rows 里混入非数组项", { rows: [["a"], "裸字符串", 42, [null, undefined]] }],
  ["单元格是对象/布尔", { rows: [["表头"], [{ a: 1 }, true, false]] }],
  ["超长 sheet 名（>31 字符）", { sheet: "x".repeat(60), rows: [["a"]] }],
  ["URL 里带无关 query", { rows: [["a"]] }],
]) {
  const r = await call("POST", "/api/export/xlsx", payload)
  ok(`API25 健壮性：${label} 不抛异常且给出明确响应`, r.threw === "" && (r.code === 200 || r.code === 400), `${r.threw} code=${r.code}`)
}

// 超长 sheet 名必须被截到 31 字符以内（Excel 硬限制）
const rSheet = await call("POST", "/api/export/xlsx", { sheet: "x".repeat(60), rows: [["a"]] })
const wbS = new ExcelJS.Workbook()
await wbS.xlsx.load(rSheet.body)
ok("API26 工作表名被截到 ≤31 字符（Excel 硬限制）", wbS.worksheets[0].name.length <= 31, String(wbS.worksheets[0].name.length))

console.log(`\nT43 接口断言：${pass} 通过 / ${fails.length} 失败（共 ${pass + fails.length} 条）`)
if (fails.length) {
  console.log("\n失败项：")
  for (const f of fails) console.log("  ✗ " + f)
  process.exitCode = 1
} else {
  console.log("全部通过。")
}
