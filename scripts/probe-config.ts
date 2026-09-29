// 配置漂移检查：`YyagentConfig` 字段 ↔ 白皮书 8.4 ↔ 用户真实 config.json。
//
// 为什么需要它（和 probe-routes.ts 同一类问题）：
// 8.4 的「字段」清单是手写的，本轮核对发现**漏了 9 个**
// （allowlists / backup / computerUnattended / contextTokens / convergeTimeoutMs /
//  fullBaseForInternal / longTask / mcpTrusted / notify）。
// 手写清单必然漂——要么从代码推导，要么写个会红的检查。
//
// 用法：
//   npx tsx scripts/probe-config.ts            # 打印字段全集
//   npx tsx scripts/probe-config.ts --check    # 再核 8.4 有没有漏写
//   npx tsx scripts/probe-config.ts --user     # 额外检查真实 config.json 里的未知键
//
// `--user` 值得单独说：**config.json 里拼错的键会被静默忽略**——
// 写 `mcpTimeOutMs` 不报错、不生效，用户只会觉得「配了没用」。这个检查专门逮它。
// 只打印**键名**，绝不打印值（里面全是 apiKey / authToken）。
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CONFIG_TS = "src/agent/config.ts"
const DOC = process.env.DOC || "AGENT-WHITEPAPER.md"
const CONFIG_JSON = join(homedir(), ".yyagent", "config.json")

/** 从 YyagentConfig 接口里取顶层字段名 */
function extractFields(src: string): { fields: string[]; commented: Map<string, string> } {
  const lines = src.split(/\r?\n/)
  const start = lines.findIndex((l) => /^export interface YyagentConfig\b/.test(l))
  if (start < 0) throw new Error(`在 ${CONFIG_TS} 里找不到 YyagentConfig 接口`)
  const fields: string[] = []
  const commented = new Map<string, string>()
  // 累积整块 `/** ... */` 注释：只看最后一行的做法会把多行注释截成半句话
  let buf: string[] = []
  let inComment = false
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\}/.test(line)) break // 接口结束
    const open = /^\s*\/\*\*\s?(.*)$/.exec(line)
    if (open) {
      inComment = true
      buf = [open[1].replace(/\*\/\s*$/, "").trim()]
      if (/\*\//.test(line)) {
        inComment = false
      }
      continue
    }
    if (inComment) {
      const cont = /^\s*\*?\s?(.*)$/.exec(line)
      if (cont) buf.push(cont[1].replace(/\*\/\s*$/, "").trim())
      if (/\*\//.test(line)) inComment = false
      continue
    }
    const m = /^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/.exec(line)
    if (m) {
      fields.push(m[1])
      const text = buf.filter(Boolean).join(" ").replace(/\s+/g, " ").trim()
      if (text) commented.set(m[1], text)
      buf = []
    }
  }
  return { fields, commented }
}

const src = readFileSync(CONFIG_TS, "utf8")
const { fields, commented } = extractFields(src)

console.log(`YyagentConfig 字段全集（来源 ${CONFIG_TS}）：${fields.length} 个\n`)
for (const f of fields) console.log(`  ${f.padEnd(22)}${commented.get(f) ?? ""}`)

let problems = 0

// ---- --check：白皮书 8.4 是否提到每个字段 ----
if (process.argv.includes("--check")) {
  console.log("\n=== 文档漂移检查（白皮书 8.4） ===")
  if (!existsSync(DOC)) {
    console.log(`找不到 ${DOC}（.gitignore 里，只在本机存在），跳过`)
  } else {
    const doc = readFileSync(DOC, "utf8")
    const section = doc.split("### 8.4 ")[1]?.split("### 8.5 ")[0] ?? ""
    const missing = fields.filter((f) => !section.includes(`\`${f}\``) && !section.includes(f))
    if (missing.length) {
      problems += missing.length
      console.log(`❌ 代码里有、8.4 没提（${missing.length} 个）：`)
      for (const f of missing) console.log(`   ${f}`)
    } else {
      console.log(`✅ 8.4 覆盖了全部 ${fields.length} 个字段`)
    }
  }
}

// ---- --user：真实 config.json 的未知键（拼错 = 静默失效） ----
if (process.argv.includes("--user")) {
  console.log("\n=== 用户 config.json 未知键检查 ===")
  if (!existsSync(CONFIG_JSON)) {
    console.log(`没有 ${CONFIG_JSON}，跳过`)
  } else {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(readFileSync(CONFIG_JSON, "utf8"))
    } catch (e) {
      console.log(`❌ config.json 解析失败（网关会退回默认配置！）：${(e as Error).message}`)
      process.exitCode = 1
      parsed = {}
    }
    const known = new Set(fields)
    const unknown = Object.keys(parsed).filter((k) => !known.has(k))
    console.log(`顶层键 ${Object.keys(parsed).length} 个（只打印键名，不打印值）`)
    if (unknown.length) {
      problems += unknown.length
      console.log(`❌ 未知键 ${unknown.length} 个——**会被静默忽略，配了不生效**：`)
      for (const k of unknown) {
        // 给个「最像的已知字段」提示，省得用户自己找拼错在哪
        const near = fields
          .map((f) => ({ f, d: levenshtein(k.toLowerCase(), f.toLowerCase()) }))
          .sort((a, b) => a.d - b.d)[0]
        console.log(`   ${k}${near && near.d <= 4 ? `   （是不是想写 ${near.f}？）` : ""}`)
      }
    } else {
      console.log("✅ 没有未知键")
    }
  }
}

if (problems) process.exitCode = 1

/** 小编辑距离，只用来提示「是不是想写 X」，不追求算法纯度 */
function levenshtein(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}
