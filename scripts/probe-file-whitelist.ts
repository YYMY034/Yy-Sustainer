// 探针：`/api/file` 的白名单与 MIME 是否真的按预期工作（T93 抽表重构后的接线验证）。
//
// 为什么需要它：`src/util/filetypes.ts` 的单测只能证明「表本身对」，
// 证明不了「路由真的用了这张表」。抽表重构最容易犯的错就是接线接错/漏改一处。
//
// 用法：先起网关（可隔离 HOME），再
//   BASE=http://127.0.0.1:8642 node --import tsx scripts/probe-file-whitelist.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ALLOWED_FILE_EXT, MIME_BY_EXT } from "../src/util/filetypes.js"

const BASE = process.env.BASE || "http://127.0.0.1:8642"

let pass = 0
let fail = 0
const ok = (n: string, v: unknown, extra = "") => {
  if (v) {
    pass++
    console.log(`  OK   ${n}${extra ? "  " + extra : ""}`)
  } else {
    fail++
    console.log(`  FAIL ${n}${extra ? "  " + extra : ""}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), "yyagent-fileprobe-"))

/** 探针要覆盖的样本：合法图片（含历史 bug 的 avif）、合法文档、必须被拦的可执行文件 */
const samples: Array<{ name: string; ext: string; expect: number }> = [
  { name: "sample.avif", ext: ".avif", expect: 200 },
  { name: "sample.png", ext: ".png", expect: 200 },
  { name: "sample.svg", ext: ".svg", expect: 200 },
  { name: "sample.csv", ext: ".csv", expect: 200 },
  { name: "evil.exe", ext: ".exe", expect: 403 },
  { name: "secret.pem", ext: ".pem", expect: 403 },
]

try {
  for (const s of samples) writeFileSync(join(dir, s.name), "probe-payload")

  console.log(`探针目标 ${BASE}  样本目录 ${dir}\n`)
  console.log("=== /api/file 白名单行为 ===")
  for (const s of samples) {
    const url = `${BASE}/api/file?p=${encodeURIComponent(join(dir, s.name))}`
    let status = 0
    let ctype = ""
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) })
      status = r.status
      ctype = r.headers.get("content-type") ?? ""
      await r.arrayBuffer()
    } catch (e) {
      ok(`${s.name} 可请求`, false, String(e).slice(0, 120))
      continue
    }
    ok(`${s.name} → ${s.expect}`, status === s.expect, `实际 ${status}`)
    if (s.expect === 200) {
      const want = MIME_BY_EXT[s.ext] ?? "application/octet-stream"
      ok(`${s.name} Content-Type = ${want}`, ctype.startsWith(want), `实际 ${ctype}`)
    }
  }

  console.log("\n=== 表与路由的一致性 ===")
  // 白名单里抽几个「最可能被漏掉」的，确认路由放行的集合和表一致
  for (const ext of [".avif", ".webp", ".bmp", ".ps1", ".env"]) {
    const p = join(dir, `x${ext}`)
    writeFileSync(p, "x")
    const r = await fetch(`${BASE}/api/file?p=${encodeURIComponent(p)}`, { signal: AbortSignal.timeout(5000) })
    await r.arrayBuffer()
    ok(`表里有 ${ext} → 路由放行`, ALLOWED_FILE_EXT.has(ext) && r.status === 200, `实际 ${r.status}`)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
} finally {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结果 */
  }
}
