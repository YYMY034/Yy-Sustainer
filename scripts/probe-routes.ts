// 路由清单推导器 + 文档漂移检查。
//
// 为什么需要它：白皮书 8.2 的表是**手写的**，于是必然过期——本轮核对发现表头写着
// 「共 62 条精确路由」，实际代码里是 73 条字面量路由 + 6 条动态路由，而且表里
// 整整漏了 15 条（/api/allowlist、/api/backup、/api/ollama/*、/api/onboard/*、
// /api/sandbox、/api/notify、/api/longtask …）。
// 这和 avif 那个 bug 是同一类问题：**手工维护一份必须和代码一致的东西，等于埋雷。**
//
// 所以路由清单改为从这里推导：`npx tsx scripts/probe-routes.ts`
//   - 默认：打印清单 + 计数
//   - `--check`：额外与白皮书 8.2 的表比对，列出「文档漏了/文档多了」
//
// 提取方式是**启发式**（正则扫源码，不是真 AST）：本项目的路由写法很规整
// （字面量走 `m === "X" && p === "Y"`，动态走 `p.match(/^\/api\/.../)`），
// 够用且不引入依赖。写法变了要回来改这个脚本——但**脚本跑出来的清单永远比手写表新**。
//
// 已知的宽容点（如实记录，别当成 bug）：
//   1. 文档侧扫的是**整个 8.2 小节**，不只看端点清单——所以某个路由只要在小节任何位置
//      出现过（哪怕只在提示段落里提一句）就算「已记录」。这偏宽松，但比漏检好：
//      漏检会让人以为文档是全的，宽松只会在极端情况下放过一条。
//   2. 动态路由的方法判定靠「同块内往前扫 80 行」，方法判定写在更外层时会标成 `*`。
//
// 自测方式（换一份故意写错的文档，验证两个方向都能报）：
//   DOC=scripts/__tmp-doc.md npx tsx scripts/probe-routes.ts --check
//   实测：漏 72 条 / 多 1 条，如期报出。
import { readFileSync, existsSync } from "node:fs"

const GW = "src/gateway.ts"
// DOC 可用环境变量覆盖，便于拿一份「故意写错」的文档做自测（见文件末尾的验证记录）
const DOC = process.env.DOC || "AGENT-WHITEPAPER.md"

interface Route {
  method: string
  path: string
  kind: "literal" | "dynamic"
  line: number
}

const src = readFileSync(GW, "utf8")
const lines = src.split(/\r?\n/)

/** 动态路由的捕获组 → `{param}`；文档里也这么写 */
function normalizeDynamic(re: string): string {
  // 捕获到的是正则字面量 `/^\/api\/...\/`，先剥掉两侧的斜杠
  let p = re.replace(/^\//, "").replace(/\/$/, "")
  p = p.replace(/^\^/, "").replace(/\$$/, "")
  p = p.replace(/\\\//g, "/")
  // 把各种捕获组统一成 {param}（`([\w-]+)`、`([a-zA-Z][\w-]{0,31})` …）
  p = p.replace(/\(\[[^\]]*\][^)]*\)/g, "{param}")
  p = p.replace(/\([^)]*\)/g, "{param}")
  return p
}

/** 文档里的 `{id}` / `{name}` 也归一成 `{param}`，否则和代码侧对不上 */
function normalizeDocPath(p: string): string {
  return p.replace(/\{[^}]*\}/g, "{param}")
}

const routes: Route[] = []

// ---- 1) 字面量路由：m === "GET" && p === "/api/xxx" ----
const litRe = /m === "([A-Z]+)"\s*&&\s*p === "([^"]+)"/g
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  let mm: RegExpExecArray | null
  litRe.lastIndex = 0
  while ((mm = litRe.exec(line))) {
    routes.push({ method: mm[1], path: mm[2], kind: "literal", line: i + 1 })
  }
}

// ---- 2) 动态路由：p.match(/^\/api\/.../) —— 方法在同块内的 m === "X" 里 ----
// 注意：`dynRe`/`litRe` 是带 g 的正则，`lastIndex` 会在 exec 与 test 之间互相污染
// （踩过一次：外层 while 因此死循环、把堆撑爆）。判定「这一行是不是新路由」用非 g 副本。
const dynRe = /(?:mt|m2)\s*=\s*p\.match\((\/\^.*?\/)\)/g
const dynReTest = /(?:mt|m2)\s*=\s*p\.match\((\/\^.*?\/)\)/
const litReTest = /m === "([A-Z]+)"\s*&&\s*p === "([^"]+)"/
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  let mm: RegExpExecArray | null
  dynRe.lastIndex = 0
  while ((mm = dynRe.exec(line))) {
    const path = normalizeDynamic(mm[1])
    // 往后扫到下一个动态路由 / 下一个字面量路由为止，收集块内出现的方法
    const methods = new Set<string>()
    const guard = /m === "([A-Z]+)"/
    const inline = guard.exec(line) // 同行写法：if (mt && m === "GET")
    if (inline) methods.add(inline[1])
    for (let j = i + 1; j < Math.min(i + 80, lines.length); j++) {
      if (dynReTest.test(lines[j]) || litReTest.test(lines[j])) break
      const g = guard.exec(lines[j])
      if (g) methods.add(g[1])
    }
    // 一个块都没扫到方法（说明方法判定在更外层），标成 * 而不是猜
    if (!methods.size) methods.add("*")
    for (const method of methods) {
      routes.push({ method, path, kind: "dynamic", line: i + 1 })
    }
    if (mm[0] === "") dynRe.lastIndex++ // 空匹配兜底，防死循环
  }
}

// 去重（同一路由可能因块内多次判断被扫到）
const seen = new Set<string>()
const uniq = routes.filter((r) => {
  const k = `${r.method} ${r.path}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})

uniq.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))

const literal = uniq.filter((r) => r.kind === "literal")
const dynamic = uniq.filter((r) => r.kind === "dynamic")

console.log(`路由清单（来源 ${GW}）`)
console.log(`  字面量 ${literal.length} 条 · 动态 ${dynamic.length} 条 · 合计 ${uniq.length} 条\n`)

const byMethod: Record<string, number> = {}
for (const r of uniq) byMethod[r.method] = (byMethod[r.method] ?? 0) + 1
console.log("按方法：" + Object.entries(byMethod).map(([k, v]) => `${k} ${v}`).join(" · ") + "\n")

console.log("| 方法 | 路径 | 类型 | 行 |")
console.log("|---|---|---|---|")
for (const r of uniq) console.log(`| ${r.method} | \`${r.path}\` | ${r.kind} | ${r.line} |`)

// ---- 3) --check：与白皮书 8.2 的表比对 ----
if (process.argv.includes("--check")) {
  console.log("\n=== 文档漂移检查（白皮书 8.2 的端点表） ===")
  if (!existsSync(DOC)) {
    console.log(`找不到 ${DOC}（该文件在 .gitignore 里，只在本机存在），跳过`)
  } else {
    const doc = readFileSync(DOC, "utf8")
    const section = doc.split("### 8.2 ")[1]?.split("### 8.3 ")[0] ?? ""
    const docPaths = new Set<string>()
    // 直接扫整节里的 /api/... 路径（不依赖表格格式——8.2 从表格改成散文式之后，
    // 只认 `|` 行的解析器会一条都读不到，那种「检查器静默失效」最危险）。
    // 字符类含 `{},` 是为了能吃掉 `{recall,edit}` 这种分组写法。
    const tokenRe = /\/api\/[A-Za-z0-9_\-/{},.]*/g
    let tm: RegExpExecArray | null
    while ((tm = tokenRe.exec(section))) {
      let t = tm[0].replace(/[.,]+$/, "") // 去掉句末的点/逗号
      // 排除三类「不是具体路由」的写法（每一条都是踩过的坑）：
      //   1. 通配符说明（`/api/*`）—— 被字符类截成 `/api/ollama/` 这种残尾
      //   2. 以 / 结尾的残尾（说明后面跟了字符类之外的符号）
      //   3. 花括号不配平（如 `{toggle(create/delete)}` 被 `(` 截断）
      if (t.includes("*")) continue
      if (t.endsWith("/")) continue
      if ((t.match(/\{/g)?.length ?? 0) !== (t.match(/\}/g)?.length ?? 0)) continue
      // 展开 {a,b,c} 分组；**只展开含逗号的**——`{id}` 这种单元素花括号是占位符，
      // 要留给 normalizeDocPath 转成 {param}，不能当成「只有一种取值」直接替换掉
      const brace = /\{[^}]*,[^}]*\}/.exec(t)
      if (brace) {
        const inner = brace[0].slice(1, -1)
        const [pre, post] = [t.slice(0, brace.index), t.slice(brace.index + brace[0].length)]
        for (const alt of inner.split(",")) docPaths.add(normalizeDocPath(`${pre}${alt.trim()}${post}`))
      } else {
        docPaths.add(normalizeDocPath(t))
      }
    }

    const codePaths = new Set(uniq.map((r) => r.path))
    const missing = [...codePaths].filter((p) => !docPaths.has(p)).sort()
    const extra = [...docPaths].filter((p) => !codePaths.has(p)).sort()

    console.log(`文档声明 ${docPaths.size} 条 · 代码实际 ${codePaths.size} 条`)
    console.log(`\n❌ 代码里有、文档没写（${missing.length} 条）：`)
    for (const p of missing) console.log(`   ${p}`)
    console.log(`\n⚠️  文档写了、代码里没有（${extra.length} 条）：`)
    for (const p of extra) console.log(`   ${p}`)
    if (!missing.length && !extra.length) console.log("\n✅ 文档与代码一致")
  }
}
