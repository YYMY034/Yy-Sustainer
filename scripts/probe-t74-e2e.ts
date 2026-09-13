// T74 端到端：走真实引擎链路（含默认全工具）打**挂掉的通道**，验证：
//   1) 抛出来的 message 是真实原因（ECONNREFUSED / 401 / 402），不再是 "No output generated"
//   2) 上层能据此判出「不该重试」
// 用配置里已存在的 local/bai 通道（指向 127.0.0.1:8899，当前无监听）——无需改动任何配置。
import { runAgentStream } from "../src/agent/loop.js"
import { describeFailure, retryBudget } from "../src/agent/errors.js"

const CASES = (process.env.MODEL ? [process.env.MODEL] : ["bai/qwen3.8-flash", "local/glm-5.3-flash", "sensenova/glm-5.2"]).slice()

for (const MODEL of CASES) {
  console.log(`\n===== ${MODEL} =====`)
  let text = ""
  const t0 = Date.now()
  try {
    const r = await runAgentStream(
      "只回复两个字：你好",
      { model: MODEL, cwd: process.cwd() },
      { onText: (d) => { text += d }, onStatus: () => {}, onToolEvent: () => {} },
    )
    console.log(`✅ 成功 | ${Date.now() - t0}ms | text=${JSON.stringify(r.text)} | steps=${r.steps}`)
  } catch (e) {
    const info = describeFailure(e)
    console.log(`❌ 失败 | ${Date.now() - t0}ms`)
    console.log(`  thrown.message : ${(e as Error).message}`)
    console.log(`  kind=${info.kind} retryable=${info.retryable} 预算=${retryBudget(info.kind)}`)
    console.log(`  用户会看到     : [出错] ${info.message}`)
    console.log(`  已流出文本     : ${JSON.stringify(text)}`)
    const opaque = /No output generated|Failed to process successful response/i.test((e as Error).message)
    console.log(`  ${opaque ? "❌ 仍是 SDK 废话" : "✅ 已暴露真实原因"}`)
  }
}
process.exit(0)
