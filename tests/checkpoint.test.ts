/**
 * T93 P1：轮内 checkpoint（断点恢复第一块）的行为守卫。
 *
 * 背景：一个回合原来只在**开头**（用户消息）和**结尾**（助手回复）落库，中间几十分钟的
 * 工具调用与已流出的正文全在内存。进程被杀 → 会话文件只剩一条用户消息，什么都找不回来。
 *
 * 这些断言盯的是「坏了也不会当场报错」的那类性质：
 * - 路径穿越：sessionId 不校验就等于任意路径写入（`../../foo` 能写到 sessions 目录外）
 * - 结构版本：老 checkpoint 必须读不出来，而不是被猜着用
 * - 半截文件：checkpoint 是「进程被杀」场景下唯一的线索，不能自己先烂掉
 * - 恢复语义：没有正文产出时也要给一条能落库的消息，否则 adopt 会写出空消息
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  CHECKPOINT_VERSION,
  CHECKPOINT_EVERY_MS,
  CHECKPOINT_EVERY_STEPS,
  clearCheckpoint,
  describeCheckpoint,
  isValidSessionId,
  listCheckpoints,
  loadCheckpoint,
  resumeAssistantContent,
  saveCheckpoint,
} from "../src/session/checkpoint.js"

const DIR = join(homedir(), ".yyagent", "checkpoints")

function clean(): void {
  try { rmSync(DIR, { recursive: true, force: true }) } catch { /* 目录本来就不存在 */ }
}

const base = (over: Record<string, unknown> = {}) => ({
  sessionId: "s-1",
  title: "会话A",
  cwd: "C:\\work\\proj",
  userTs: 1000,
  userText: "帮我把这个仓库的测试跑一遍",
  images: 0,
  startedAt: 1000,
  updatedAt: 2000,
  streamedText: "",
  steps: [],
  ...over,
})

test("sessionId 必须过路径校验（否则是任意路径写入）", () => {
  const bad = ["", "a b", "a/b", "a\\b", "../evil", "..\\evil", "/abs", ".", "..", "a".repeat(65), null, undefined, 42, {}, []]
  for (const v of bad) {
    assert.equal(isValidSessionId(v), false, `${JSON.stringify(v)} 不该通过校验`)
  }
  for (const v of ["s-1", "abc_DEF-123", "a".repeat(64), "x"]) {
    assert.equal(isValidSessionId(v), true, `${v} 是合法 id`)
  }
  // 校验不过 → 直接不写。不能抛错（checkpoint 是保险丝，不是主链路）
  clean()
  assert.equal(saveCheckpoint(base({ sessionId: "../../evil" }) as never), false)
  const leftovers = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.includes("evil")) : []
  assert.deepEqual(leftovers, [], "不该在任何位置留下 evil 相关文件")
  // sessions 目录是真实存在的（不是被创建出来的），这里只是确认没往那儿写东西
  assert.deepEqual(
    existsSync(DIR) ? readdirSync(DIR) : [],
    [],
    "checkpoint 目录应该还是空的",
  )
})

test("存 → 读 → 清 的闭环，且字段原样带回来", () => {
  clean()
  const steps = [{ name: "bash", argsSummary: "npm test" }]
  const compacted = [{ role: "user" as const, content: "[滚动摘要]\n目标", ts: 500 }]
  assert.equal(
    saveCheckpoint(base({
      streamedText: "已经跑了一半",
      steps,
      compactedStored: compacted,
      model: "sensenova/glm-5.2",
    })) as unknown as boolean,
    true,
  )
  const c = loadCheckpoint("s-1")
  assert.ok(c, "应该读得到")
  assert.equal(c!.streamedText, "已经跑了一半")
  assert.equal(c!.userText, "帮我把这个仓库的测试跑一遍")
  assert.equal(c!.v, CHECKPOINT_VERSION)
  assert.equal(c!.model, "sensenova/glm-5.2")
  assert.deepEqual(c!.steps, steps)
  assert.deepEqual(c!.compactedStored, compacted)
  clearCheckpoint("s-1")
  assert.equal(loadCheckpoint("s-1"), undefined)
  // 幂等：再清一次、以及清一个不存在的，都不抛
  clearCheckpoint("s-1")
  clearCheckpoint("不存在")
})

test("结构版本不符 → 读不出来（不猜、不静默迁移）", () => {
  clean()
  mkdirSync(DIR, { recursive: true })
  writeFileSync(join(DIR, "old.json"), JSON.stringify({ v: 999, sessionId: "old", userTs: 1 }))
  assert.equal(loadCheckpoint("old"), undefined, "老版本必须读不出来")
  assert.equal(listCheckpoints().some((c) => c.sessionId === "old"), false, "也不该被算成有效 checkpoint 误报给用户")
})

test("文件损坏（半截 JSON）→ undefined，而不是抛错", () => {
  clean()
  mkdirSync(DIR, { recursive: true })
  writeFileSync(join(DIR, "broken.json"), '{"v":1,"sessionId":"broken","userTs":1,')
  assert.equal(loadCheckpoint("broken"), undefined)
  assert.deepEqual(listCheckpoints().map((c) => c.sessionId), [], "坏文件不该让整个扫描失败")
})

test("listCheckpoints 只认合法的 <id>.json，跳过 tmp 残留", () => {
  clean()
  mkdirSync(DIR, { recursive: true })
  saveCheckpoint(base({ sessionId: "a", title: "A", updatedAt: 1000 }))
  saveCheckpoint(base({ sessionId: "b", title: "B", updatedAt: 5000 }))
  // 这些是原子写的临时残留 / 别的产物，必须被跳过
  writeFileSync(join(DIR, "a.1234.abcdef.tmp"), "junk")
  writeFileSync(join(DIR, "note.txt"), "junk")
  const list = listCheckpoints()
  assert.deepEqual(list.map((c) => c.sessionId), ["b", "a"], "应按 updatedAt 倒序，且只收合法文件")
})

test("steps 超量时只保留最近的一批（文件不能无限涨）", () => {
  clean()
  const steps = Array.from({ length: 500 }, (_, i) => ({ name: `t${i}`, argsSummary: "x".repeat(9000) }))
  saveCheckpoint(base({ steps }))
  const c = loadCheckpoint("s-1")
  assert.ok(c)
  assert.ok(c!.steps.length <= 200, `steps 应被裁到 200 以内，实际 ${c!.steps.length}`)
  assert.ok(c!.steps.length > 0, "最近的一批要留住")
  assert.equal(c!.steps[c!.steps.length - 1].name, "t499", "必须是**最近**的，不是最早的")
  // 单字段也要裁，否则 500 步 × 9k 字符照样把文件撑爆
  assert.ok(c!.steps[0].argsSummary.length <= 2000, `单字段应裁到 2000 以内，实际 ${c!.steps[0].argsSummary.length}`)
})

test("恢复用的助手消息：有正文就给「已产出部分」，没正文也要能落库", () => {
  const withText = resumeAssistantContent({ ...base(), streamedText: "跑完了 7 个测试" } as never)
  assert.ok(withText.content.includes("跑完了 7 个测试"))
  assert.ok(withText.content.includes("进程被中断"), "要说清这是中断前的部分，否则用户会以为答完了")
  assert.equal(withText.hadOutput, true)

  const empty = resumeAssistantContent({ ...base(), streamedText: "   \n " } as never)
  assert.equal(empty.hadOutput, false)
  assert.ok(empty.content.trim().length > 0, "没正文也不能落一条空消息")
  assert.ok(empty.content.includes("进程被中断"))
})

test("describeCheckpoint 把线索量说清楚（有字数/步数/陈旧标记）", () => {
  const s = describeCheckpoint(base({ title: "长任务A", streamedText: "你好世界", steps: [{ name: "bash", argsSummary: "" }] }) as never)
  assert.ok(s.includes("长任务A"), s)
  assert.ok(s.includes("4 字"), s)
  assert.ok(s.includes("1 步工具"), s)

  const stale = describeCheckpoint(base({ title: "老A", updatedAt: Date.now() - 3 * 24 * 3600_000 }) as never)
  assert.ok(stale.includes("陈旧"), stale)

  // 没标题时退回 sessionId，不能出现空会话名
  const noTitle = describeCheckpoint(base({ title: "" }) as never)
  assert.ok(noTitle.includes("s-1"), noTitle)
})

test("阈值是有理数且讲得通（定时 20s / 定步 5 步）", () => {
  assert.equal(CHECKPOINT_EVERY_MS, 20_000)
  assert.equal(CHECKPOINT_EVERY_STEPS, 5)
  // 太密会把热路径拖慢，太疏等于没有
  assert.ok(CHECKPOINT_EVERY_MS >= 5_000 && CHECKPOINT_EVERY_MS <= 60_000)
  assert.ok(CHECKPOINT_EVERY_STEPS >= 1 && CHECKPOINT_EVERY_STEPS <= 20)
})

test("写盘必须是原子写：不留 tmp 残留", () => {
  clean()
  saveCheckpoint(base())
  const files = readdirSync(DIR)
  assert.deepEqual(files, ["s-1.json"], `目录里只该有目标文件，实际：${files.join(", ")}`)
})
