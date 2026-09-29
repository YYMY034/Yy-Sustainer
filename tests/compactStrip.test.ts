/**
 * 剥离模型误输出的裸 tool_call 文本（白皮书 10.31 残留项）。
 * 弱模型会把工具调用输出成文本，该文本从没真实执行过，进历史/摘要只会被模仿放大
 * （10.31 E 轮实测：摘要里出现 tool_call，模型最终消息变成工具调用回声）。
 * 只认 tool_call 这一种实测形态；别的文本形态（如裸 JSON）无法可靠区分，不猜。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { contentToText, buildCompactedStored, type HistoryMessage } from "../src/agent/compact.js"

const msg = (role: "user" | "assistant", content: unknown, ts?: number): HistoryMessage =>
  ({ role, content, ...(ts === undefined ? {} : { ts }) }) as HistoryMessage

const TAG = "<" + "tool" + "_call>"
const CL = "</" + "tool" + "_call>"

test("裸 tool_call 块整块剥掉，周围正常文本保留", () => {
  const raw = [
    "我来读取这个文件。",
    TAG,
    "<function=read>",
    '{"file_path":"src/mcp/client.ts"}',
    CL,
    "读完了，继续下一个。",
  ].join("\n")
  const out = contentToText(raw)
  assert.ok(out.includes("我来读取这个文件"), out)
  assert.ok(out.includes("读完了，继续下一个"), out)
  assert.ok(!out.includes(TAG), out)
  assert.ok(!out.includes("file_path"), "参数内容也不该留")
})

test("未闭合的开头标签：从那之后全是虚构调用，一并切掉（模型被截断的形态）", () => {
  const raw = "正常前半句。\n" + TAG + "\n<function=read>\n" + '{"file_path":"x.ts"}'
  const out = contentToText(raw)
  assert.equal(out.trim(), "正常前半句。")
})

test("整条只有 tool_call 块 → 短标记而非空串（空 content 上游可能非法）", () => {
  const only = TAG + "\n<function=glob>\n" + '{"pattern":"src/**"}' + "\n</" + "tool" + "_call>"
  assert.equal(contentToText(only), "（无效的工具调用文本，已忽略）")
})

test("碎片标签也剥；正常文本原样通过", () => {
  assert.ok(!contentToText("前文 </" + "tool" + "_call> 后文").includes("</" + "tool" + "_call>"))
  assert.ok(!contentToText(TAG + " 后面什么都没有").includes(TAG))
  const normal = "正常的话，带 [调用 read(...)] 拍平标记。"
  assert.equal(contentToText(normal), normal)
  assert.equal(contentToText([{ type: "text", text: normal }]), normal)
})
test("端到端：落库形态无 tool_call XML，结构化 parts 拍平不受影响", () => {
  const fake = TAG + "\n<function=glob>\n" + '{"p":"src/**"}' + "\n</" + "tool" + "_call>"
  const hist: HistoryMessage[] = [
    msg("user", "审阅目录", 1000),
    { role: "assistant", content: [{ type: "text", text: "先 glob。" + fake }], ts: 1100 } as HistoryMessage,
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "glob", input: { p: "src/**" } }], ts: 1200 } as HistoryMessage,
  ]
  const all = buildCompactedStored("已 glob 并开始读文件", hist).map((s) => String(s.content)).join("\n")
  assert.ok(!all.includes(TAG), all)
  assert.ok(all.includes("[调用 glob("), "结构化 parts 的可读拍平不受影响")
})
