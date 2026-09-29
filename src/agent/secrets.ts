/**
 * T91 密钥保护：**内存明文、落盘密文**。
 *
 * 背景：历史版本把 5 个 provider 的 apiKey 连同 3 份 config.json.bak-* 全量明文写在
 * ~/.yyagent/config.json 里（共 15 处），任何能读到用户目录的进程、任何一次误分享/误同步
 * 都等于把 key 交出去。这里把落盘形态换成密文，调用方（loadConfig 的读者）完全无感——
 * 解密在 loadConfig 里做，全进程内部始终是明文，所以没有任何工具/网关代码需要改。
 *
 * 主密钥来源（按优先级）：
 *  1. 环境变量 YYAGENT_MASTER_KEY（base64，32 字节）——无头/CI/多机同步用
 *  2. Windows：DPAPI（CryptProtectData, CurrentUser）保护的 ~/.yyagent/.master.key
 *     —— 密钥由操作系统绑定到当前用户账户，换用户/换机器都解不开，这是 Windows 上的
 *     「系统凭据保护」原语（不需要额外的原生依赖，走系统自带的 System.Security）
 *  3. 其他平台：~/.yyagent/.master.key（0600）本地密钥文件，明文存储但受文件权限保护，
 *     首次生成时在控制台明确告知降级原因（不静默假装安全）
 *
 * 加密算法：AES-256-GCM，落盘格式 `enc:v1:<iv>:<tag>:<ciphertext>`（均为 base64）。
 * 解密失败（换机器/换用户/文件损坏）不抛异常——返回空串并告警，让应用照常启动，
 * 用户重新填一次 key 即可，不至于因为一个密钥文件打不开就整个 agent 起不来。
 */
import { execFileSync } from "node:child_process"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const DIR = join(homedir(), ".yyagent")
const KEY_FILE = join(DIR, ".master.key")
const PREFIX = "enc:v1:"

let cachedKey: Buffer | null = null
let warned = false
/** 实际生效的密钥来源（供自检显示，不靠猜） */
let keySource: "dpapi" | "env" | "file" | "memory" = "memory"

/** 值是否已是密文（幂等判据：加密过的不要重复加密） */
export function isEncrypted(v: unknown): boolean {
  return typeof v === "string" && v.startsWith(PREFIX)
}

/** 占位符/空值不做加密——它们不是秘密，保持配置文件可读可诊断 */
export function isSecretLike(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0 && v.trim() !== "REPLACE_ME"
}

function warnOnce(msg: string): void {
  if (warned) return
  warned = true
  console.error(`[密钥保护] ${msg}`)
}

/** DPAPI 保护/解保护：走系统自带的 System.Security，不引入原生依赖。失败返回 null。
 *  编码必须**两侧对称**：Node 侧一律把输入 base64 后经环境变量传入，PowerShell 侧一律 FromBase64String 还原。
 *  （踩过的坑：protect 写成 UTF8.GetBytes($env:...) 时，实际被保护的是「base64 文本」本身，
 *   于是读回来的密钥长度变成 45 字节而不是 32 —— AES-256 直接 "Invalid key length"，
 *   而且失败发生在解密链路上，表现为「明明有密钥文件却全部解不开」。） */
function dpapi(input: Buffer, mode: "protect" | "unprotect"): Buffer | null {
  if (process.platform !== "win32") return null
  const op = mode === "protect" ? "Protect" : "Unprotect"
  const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:YY_SECRET_IN); $p=[Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($p))`
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, YY_SECRET_IN: input.toString("base64") },
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const clean = String(out).replace(/[^A-Za-z0-9+/=]/g, "")
    return clean ? Buffer.from(clean, "base64") : null
  } catch {
    return null
  }
}

/** 取主密钥（首次生成并落盘）。任何一步失败都回落到进程内随机密钥——加密仍生效，只是重启后解不开旧密文。 */
function masterKey(): Buffer {
  if (cachedKey) return cachedKey
  const env = process.env.YYAGENT_MASTER_KEY?.trim()
  if (env) {
    try {
      const b = Buffer.from(env, "base64")
      if (b.length >= 32) {
        cachedKey = b
        keySource = "env"
        return b
      }
    } catch {
      /* 环境变量不是合法 base64 → 走文件 */
    }
  }
  try {
    if (existsSync(KEY_FILE)) {
      const raw = readFileSync(KEY_FILE, "utf8").trim()
      if (process.platform === "win32") {
        const plain = dpapi(Buffer.from(raw, "base64"), "unprotect")
        if (plain) {
          cachedKey = Buffer.from(plain.toString("utf8"), "base64")
          keySource = "dpapi"
          return cachedKey
        }
        warnOnce("DPAPI 解保护失败（换用户/换机器？）——请重新填写 API Key，程序继续启动")
      } else {
        cachedKey = Buffer.from(raw, "base64")
        keySource = "file"
        return cachedKey
      }
    }
    // 生成新密钥
    const fresh = randomBytes(32)
    mkdirSync(DIR, { recursive: true })
    if (process.platform === "win32") {
      const prot = dpapi(Buffer.from(fresh.toString("base64"), "utf8"), "protect")
      if (prot) {
        writeFileSync(KEY_FILE, prot.toString("base64") + "\n", "utf8")
        try { chmodSync(KEY_FILE, 0o600) } catch { /* Windows 上 chmod 意义有限 */ }
        cachedKey = fresh
        keySource = "dpapi"
        return fresh
      }
      warnOnce("DPAPI 不可用，主密钥降级为本地文件存储（仍加密，但保护强度依赖文件权限）")
    } else {
      warnOnce("非 Windows 平台：主密钥以 0600 权限存于 ~/.yyagent/.master.key，仅靠文件权限保护")
    }
    writeFileSync(KEY_FILE, fresh.toString("base64") + "\n", "utf8")
    try { chmodSync(KEY_FILE, 0o600) } catch { /* 忽略 */ }
    cachedKey = fresh
    keySource = "file"
    return fresh
  } catch (e) {
    warnOnce(`主密钥不可用（${(e as Error).message}）——本次会话使用进程内临时密钥`)
    cachedKey = randomBytes(32)
    keySource = "memory"
    return cachedKey
  }
}

/** 加密：已是密文或空值原样返回（幂等，可反复对同一配置调用） */
export function encryptSecret(plain: string): string {
  if (!isSecretLike(plain) || isEncrypted(plain)) return plain
  try {
    const iv = randomBytes(12)
    const c = createCipheriv("aes-256-gcm", masterKey(), iv)
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()])
    const tag = c.getAuthTag()
    return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`
  } catch (e) {
    warnOnce(`加密失败（${(e as Error).message}），该值保持明文`)
    return plain
  }
}

/** 解密：非密文原样返回；失败返回空串（不抛，避免一个坏值拖垮整个配置加载） */
export function decryptSecret(v: string): string {
  if (!isEncrypted(v)) return v
  try {
    const body = v.slice(PREFIX.length)
    const [ivB, tagB, ctB] = body.split(":")
    if (!ivB || !tagB || !ctB) return ""
    const d = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB, "base64"))
    d.setAuthTag(Buffer.from(tagB, "base64"))
    return Buffer.concat([d.update(Buffer.from(ctB, "base64")), d.final()]).toString("utf8")
  } catch {
    warnOnce("存在无法解密的密钥（换机器/换用户/密钥文件被替换）——对应通道需要重新填写 API Key")
    return ""
  }
}

/**
 * 历史明文副本清理：config.json.bak-* 是历次改配置留下的备份，里面同样是明文 key。
 * 迁移时把它们就地改成密文（同一把主密钥，随时可解），既不留明文残留，也不销毁用户数据。
 * 返回被处理的文件名列表，供调用方告知用户。
 */
export function redactLegacyBackupKeys(dir: string): string[] {
  const done: string[] = []
  try {
    for (const f of readdirSync(dir)) {
      if (!/^config\.json\.bak/.test(f)) continue
      const p = join(dir, f)
      try {
        const raw = readFileSync(p, "utf8")
        if (!/"apiKey"\s*:\s*"(?!enc:)/.test(raw)) continue
        const cfg = JSON.parse(raw) as { providers?: Record<string, { apiKey?: string }>; authToken?: string }
        let touched = false
        // 只有**真的变成了密文**才算处理过——加密失败时 encryptSecret 原样返回，
        // 早期版本不看返回值就标 touched=true，结果日志报「已处理」而磁盘上还是明文。
        const enc = (v: string): string => {
          const next = encryptSecret(v)
          if (next !== v) touched = true
          return next
        }
        for (const pv of Object.values(cfg.providers ?? {})) {
          if (pv?.apiKey && !isEncrypted(pv.apiKey)) pv.apiKey = enc(pv.apiKey)
        }
        if (cfg.authToken && !isEncrypted(cfg.authToken)) cfg.authToken = enc(cfg.authToken)
        if (touched) {
          writeFileSync(p, JSON.stringify(cfg, null, 2))
          done.push(f)
        }
      } catch {
        /* 坏文件跳过 */
      }
    }
  } catch {
    /* 目录不存在等 */
  }
  return done
}

/** 供设置页/自检显示：当前密钥保护的实际强度 */
export function keyProtection(): "dpapi" | "env" | "file" | "memory" {
  if (keySource === "memory") masterKey() // 尚未初始化时先初始化一次，返回值才是真实来源
  return keySource
}
