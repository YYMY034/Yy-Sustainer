/**
 * T91 密钥保护回归：加解密往返 / 幂等 / 篡改检测 / 落盘审计（只读）。
 * 运行：npx tsx scripts/check-t91-secrets.ts
 *
 * 注意：本脚本**不改动**任何文件。真正的明文→密文迁移由 loadConfig() 启动时自动完成（幂等），
 * 这里只做断言与审计——包括「磁盘上是否还留着明文 key」这一条。
 */
import { readFileSync, readdirSync } from "node:fs"
import { dirname } from "node:path"
import { configPath } from "../src/agent/config.js"
import { decryptSecret, encryptSecret, isEncrypted, keyProtection } from "../src/agent/secrets.js"

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { pass++; console.log(`  PASS  ${name}`) } else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`) }
}

console.log("1. 加解密往返（含空值与中文）")
for (const s of ["sk-abcdef1234567890", "含中文的密钥-测试", "a".repeat(500)]) {
  const enc = encryptSecret(s)
  ok(`往返一致：${s.slice(0, 18)}${s.length > 18 ? "…" : ""}`, decryptSecret(enc) === s)
  ok(`落盘形态是密文：${s.slice(0, 10)}…`, isEncrypted(enc) && !enc.includes(s))
}
ok("空串不加密（原样返回）", encryptSecret("") === "")
ok("占位符 REPLACE_ME 不加密", encryptSecret("REPLACE_ME") === "REPLACE_ME")
ok("非密文解密原样返回", decryptSecret("plain-text") === "plain-text")

console.log("\n2. 幂等：已加密的值不会被二次加密")
{
  const once = encryptSecret("sk-once")
  ok("二次调用结果不变", encryptSecret(once) === once)
  ok("三次调用仍可解", decryptSecret(encryptSecret(once)) === "sk-once")
}

console.log("\n3. 篡改检测：坏密文不抛异常、返回空串（避免一个坏值拖垮配置加载）")
{
  const enc = encryptSecret("sk-tamper")
  ok("加密确实产出了密文（主密钥可用）", isEncrypted(enc), "若失败：主密钥文件坏了，删掉 ~/.yyagent/.master.key 会重新生成")
  const parts = enc.split(":")
  const body = parts[3] ?? ""
  const broken = `${parts[0]}:${parts[1]}:${parts[2]}:${body.slice(0, -4)}AAAA`
  let threw = false
  let out = ""
  try { out = decryptSecret(broken) } catch { threw = true }
  ok("不抛异常", !threw)
  ok("返回空串（该通道需重填，程序照常启动）", out === "")
  ok("结构残缺的密文也返回空串", decryptSecret("enc:v1:onlyiv") === "")
}

console.log("\n4. 密钥保护强度")
{
  const kind = keyProtection()
  const label: Record<string, string> = {
    dpapi: "DPAPI（绑定当前 Windows 用户，系统级保护）",
    env: "YYAGENT_MASTER_KEY 环境变量",
    file: "本地密钥文件 0600（非 Windows 或 DPAPI 不可用）",
    memory: "进程内临时密钥（重启即失效）",
  }
  console.log(`  当前：${kind} — ${label[kind]}`)
  ok("不是「进程内临时密钥」这种不可用状态", kind !== "memory", "重启后旧密文将无法解开")
}

console.log("\n5. 落盘审计：配置文件里不应再有明文密钥")
{
  const dir = dirname(configPath())
  let plaintextHits = 0
  let encHits = 0
  for (const f of readdirSync(dir)) {
    if (!/^config\.json(\.bak.*)?$/.test(f)) continue
    const raw = readFileSync(`${dir}/${f}`, "utf8")
    if (/"apiKey"\s*:\s*"enc:/.test(raw)) encHits++
    if (/"apiKey"\s*:\s*"(?!enc:|REPLACE_ME")/.test(raw)) { plaintextHits++; console.log(`      明文残留：${f}`) }
  }
  ok("没有明文 apiKey 残留", plaintextHits === 0, `${plaintextHits} 个文件仍有明文`)
  ok("至少有一个文件已是密文（迁移已生效）", encHits > 0)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0
