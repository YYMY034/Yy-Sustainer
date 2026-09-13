// 全量断言回归跑批器：单独进程跑每个 check-*，自带超时，汇总「有无 FAIL」
// 用法：node scripts/run-all-checks.mjs   （用 npx tsx 亦可）
import { execFileSync } from "node:child_process"
import { readdirSync } from "node:fs"

const dir = "scripts"
const files = readdirSync(dir)
  .filter((f) => /^check-.*\.(mjs|ts)$/.test(f))
  .sort()
const only = process.argv[2]

let totalPass = 0
let totalFail = 0
const broken = []

for (const f of files) {
  if (only && !f.includes(only)) continue
  let out = ""
  let crashed = ""
  try {
    out = execFileSync("npx", ["tsx", `${dir}/${f}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 90000,
      shell: true,
      maxBuffer: 20 * 1024 * 1024,
    })
  } catch (e) {
    out = String(e.stdout ?? "")
    crashed = e.signal ? `（超时/被杀 ${e.signal}）` : "（退出码非 0）"
  }
  const failLines = out.split(/\r?\n/).filter((l) => /^FAIL\b/.test(l))
  // 兼容三种汇总写法：N passed | N 通过 / M 失败
  const m1 = out.match(/(\d+) passed,\s*(\d+) failed/)
  const m2 = out.match(/(\d+) 通过\s*\/\s*(\d+) 失败/)
  const pass = m1 ? Number(m1[1]) : m2 ? Number(m2[1]) : out.split(/\r?\n/).filter((l) => /^OK\b/.test(l)).length
  const fail = m1 ? Number(m1[2]) : m2 ? Number(m2[2]) : failLines.length
  totalPass += pass
  totalFail += fail
  const bad = fail > 0 || failLines.length > 0
  if (bad) broken.push(f)
  console.log(`${bad ? "❌" : "✅"} ${f.padEnd(34)} ${pass} 通过 / ${fail} 失败${crashed}`)
  for (const l of failLines.slice(0, 6)) console.log(`      ${l.slice(0, 150)}`)
}

console.log(`\n合计：${totalPass} 通过 / ${totalFail} 失败 | 脚本 ${broken.length ? `有失败: ${broken.join(", ")}` : "全绿"}`)
process.exit(totalFail ? 1 : 0)
