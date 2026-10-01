/**
 * T112：发布流水线（一键出包 + 打 tag + 可选上传 GitHub Release）。
 *
 *   node scripts/release.mjs --version 0.4.0            # 出包 + commit + tag
 *   node scripts/release.mjs --version 0.4.0 --push     # 上述 + push（含 tag）+ 尝试 gh release create
 *
 * 前置：工作区必须干净（未提交改动会让版本号和产物对不上号）。
 * 产物目录固定 release-new/（release/ 被系统句柄锁死过一次，见白皮书 13.4）。
 */
import { execSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const run = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: "inherit", ...opts })
const sh = (cmd) => execSync(cmd, { cwd: root, encoding: "utf8" }).trim()

const args = process.argv.slice(2)
const argOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null
}
const version = argOf("--version")
const push = args.includes("--push")

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("用法：node scripts/release.mjs --version x.y.z [--push]")
  process.exit(2)
}

// ① 工作区必须干净
const dirty = sh("git status --porcelain")
if (dirty) {
  console.error("工作区有未提交改动，先提交或 stash（版本号必须和产物对得上号）：\n" + dirty)
  process.exit(1)
}

// ② 升版本号（package.json + package-lock.json）
const pkgFile = join(root, "package.json")
const pkg = JSON.parse(readFileSync(pkgFile, "utf8"))
pkg.version = version
writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n")
const lockFile = join(root, "package-lock.json")
if (existsSync(lockFile)) {
  const lock = JSON.parse(readFileSync(lockFile, "utf8"))
  lock.version = version
  if (lock.packages?.[""]) lock.packages[""].version = version
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n")
}
console.log(`[release] 版本号 → ${version}`)

// ③ 出包（bundle + electron-builder，输出固定 release-new/）
console.log("[release] 开始出包（几分钟）…")
run("node scripts/bundle.mjs")
run("npx electron-builder --win nsis -c.directories.output=release-new")
const installer = join(root, "release-new", `Yy Sustainer-${version}-Setup.exe`)
if (!existsSync(installer)) {
  console.error(`[release] 没找到产物：${installer}——electron-builder 的版本号来自 package.json，检查上面构建日志`)
  process.exit(1)
}
console.log(`[release] 产物就绪：${installer}`)

// ④ commit + tag
run(`git add package.json package-lock.json`)
run(`git commit -m "release v${version}"`)
run(`git tag v${version}`)
console.log(`[release] 已提交并打 tag v${version}`)

// ⑤ 推送 + GitHub Release
if (!push) {
  console.log(`[release] 完成。发布上线手动执行：\n  git push origin main --tags\n  gh release create v${version} "release-new/Yy Sustainer-${version}-Setup.exe" --title "Yy Sustainer ${version}" --generate-notes`)
  process.exit(0)
}
run("git push origin main --tags")
console.log("[release] 已推送。尝试 gh release create …")
try {
  run(`gh release create v${version} "${installer}" --title "Yy Sustainer ${version}" --generate-notes`)
  console.log(`[release] ✅ GitHub Release v${version} 已发布`)
} catch {
  console.log(`[release] gh 不可用，手动上传：https://github.com/YYMY034/Yy-Sustainer/releases/new?tag=v${version}（附件：${installer}）`)
}
