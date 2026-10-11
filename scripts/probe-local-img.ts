/**
 * T141：本地 ComfyUI 生图端到端实测——真实调用 sceneTools.localComfyImage
 * （提交工作流 → 轮询 → /view 取图 → 写盘），验证 imggen 的本地通道完整链路。
 * 前置：ComfyUI 运行在 127.0.0.1:8188 且已装 Qwen-Image-2.1-Turbo 三件套。
 */
import { mkdirSync, existsSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localComfyImage } from "../src/agent/sceneTools.js"

const out = join(tmpdir(), `yy-local-img-${Date.now()}.png`)
mkdirSync(join(out, ".."), { recursive: true })
const t0 = Date.now()
const r = await localComfyImage("a small red mailbox on a white fence, sunny day, photo", "512x512", out)
const ms = Date.now() - t0
const ok = !!r && existsSync(out) && statSync(out).size > 50_000
console.log(`${ok ? "ok  " : "FAIL"} 本地生图端到端（${(ms / 1000).toFixed(0)}s）${r ? " — " + r : " — 返回 null"}`)
process.exit(ok ? 0 : 1)
