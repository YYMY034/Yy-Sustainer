// Yy Sustainer 引擎单文件打包（esbuild）
//
// 为什么需要它：发行版不能要求用户装 Node，也不能在运行时用 tsx 解释 .ts
// （electron/main.cjs 原来 spawn 的是「系统 node + node_modules/tsx + src/gateway.ts」，
// 这三样在别人机器上都不存在）。这里把整个引擎连同依赖打成**一个文件**，
// 之后由 Electron 自己的 Node（ELECTRON_RUN_AS_NODE=1）直接执行，零外部依赖。
//
// 两个必须踩对的点（都实测过）：
//  ① 产出必须是 **esm**，不能是 cjs —— 引擎里有 3 处 `import.meta`（gateway.ts 的
//     `__dirname` 决定 WEB_DIR、tasks.ts 找 yyagentd.config.json、启动自检），
//     改成 cjs 会让 import.meta 变成空值 → UI 目录解析失败。
//  ② 但纯 esm 产出会让 CJS 依赖（ws 等）里的动态 require 炸
//     `Dynamic require of "events" is not supported`（esbuild 的 __require 垫片会抛）。
//     解法：banner 里用 createRequire 造一个真的 `require` 绑定 —— esbuild 生成的
//     __require 会优先复用它，于是两边都满足，且**不用改一行业务代码**。
import { build } from "esbuild"
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const outDir = resolve(root, "dist")
const outFile = resolve(outDir, "gateway.mjs")

const BANNER = [
  "// Yy Sustainer 引擎单文件包（esbuild bundled）",
  "// 由 `npm run bundle` 生成，请勿手改；改源码后重新打包。",
  'import { createRequire as __yyCreateRequire } from "node:module";',
  "const require = __yyCreateRequire(import.meta.url);",
].join("\n")

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const t0 = Date.now()
try {
  await build({
    entryPoints: [resolve(root, "src/gateway.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm", // ← 见文件头 ①：必须 esm，否则 import.meta 失效
    target: "node20",
    banner: { js: BANNER }, // ← 见文件头 ②：补一个真 require
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
    // 只排除真正无法/不该打包的东西。目前引擎没有原生模块，全部内联。
    external: [],
  })
} catch (e) {
  console.error("[bundle] 打包失败：")
  console.error(e?.message || e)
  process.exit(1)
}

const bytes = statSync(outFile).size
const kb = (bytes / 1024).toFixed(0)
const mb = (bytes / 1048576).toFixed(2)

writeFileSync(
  resolve(outDir, "build-manifest.json"),
  JSON.stringify(
    {
      entry: "src/gateway.ts",
      output: "dist/gateway.mjs",
      bytes,
      format: "esm",
      target: "node20",
      builtAt: new Date().toISOString(),
      note: "发行版里由 Electron 以 ELECTRON_RUN_AS_NODE=1 执行本文件，用户无需安装 Node。",
    },
    null,
    2,
  ),
)

console.log(`[bundle] dist/gateway.mjs  ${mb} MB (${kb} KB)  用时 ${Date.now() - t0}ms`)
console.log("[bundle] 自检：node dist/gateway.mjs 应能直接监听（YYAGENT_GATEWAY_PORT 可指定端口）")
