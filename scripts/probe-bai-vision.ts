// 验证 visionModel 链路：用配置里的 visionModel（现为 bai/qwen3.8-flash）识别一张纯色图。
// 注意：全局 proxy dispatcher 是 tools.ts 顶层副作用挂上的，必须先 import 它，否则本脚本直连海外会被墙。
import "../src/agent/tools.js"
import { describeImage } from "../src/agent/vision.js"
import { loadConfig } from "../src/agent/config.js"
import { resolve } from "node:path"

const cfg = loadConfig()
console.log("visionModel =", cfg.visionModel)
const img = resolve(process.cwd(), ".workbuddy/tmp/red.png")
const t0 = Date.now()
try {
  const desc = await describeImage(img)
  console.log(`✅ 识图成功 | ${Date.now() - t0}ms`)
  console.log("描述:", desc.slice(0, 200))
} catch (e) {
  console.log(`❌ 识图失败 | ${Date.now() - t0}ms`)
  console.log((e as Error).message.slice(0, 300))
}
process.exit(0)
