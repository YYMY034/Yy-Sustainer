/**
 * T93 L2：A/B 对照与门槛计算的守卫。
 *
 * 这一层刚被自检抓到两个真 bug，所以这里的断言格外细：
 *   ① 一致率分母错（减了本就没计入 total 的 bothUnknown）→ 算出 566.7% 这种数
 *   ② 「候选没判」和「候选判错」被混成一个数——两者要采取的行动完全不同
 *
 * 另外钉住门槛的**分辨力**：一个永远判 PASS 的后端必须被拦下，
 * 一个逐字复述标注的后端必须能过。少了任何一边，门槛都只是个装饰。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { applyGates, compareBackends, toVerdictMap, type SamplePair, type VerdictMap } from "../src/agent/hookAb.js"
import { LABELED_SAMPLES, HOOK_IDS, labeledSetStats, riskSampleIds } from "../src/agent/hookSamples.js"
import type { HookVerdict } from "../src/agent/hookJudge.js"

const SAFETY = "builtin-safety"
const FORMAT = "builtin-format"

const v = (hookId: string, pass: boolean, reason?: string): HookVerdict => ({ hookId, pass, ...(pass ? {} : { reason }) })

/** 构造一份「样本 → 判定」的对照表 */
function table(entries: Record<string, HookVerdict[]>): Map<string, VerdictMap> {
  const m = new Map<string, VerdictMap>()
  for (const [id, vs] of Object.entries(entries)) m.set(id, toVerdictMap(vs))
  return m
}

const SAMPLES: SamplePair[] = [
  { id: "a" },
  { id: "b", risk: true },
  { id: "c" },
  { id: "d", risk: true },
]

test("完全一致 → 一致率 100%，零分歧", () => {
  const base = table({ a: [v(SAFETY, true)], b: [v(SAFETY, false)], c: [v(SAFETY, false)] })
  const ags = compareBackends(SAMPLES, base, base, [SAFETY])
  assert.equal(ags[0].total, 3)
  assert.equal(ags[0].agree, 3)
  assert.equal(ags[0].agreementRate, 1)
  assert.equal(ags[0].regressions.length, 0)
  assert.equal(ags[0].falseAlarms.length, 0)
  assert.equal(ags[0].bothUnknown, 1, "样本 d 两边都没有 → 两边都判不出")
})

test("**一致率永远是 0–1**（回归：分母曾错减 bothUnknown，算出过 566.7%）", () => {
  // 只有 1 条样本有判定，3 条两边都判不出——旧的错误分母会把它算成 1/0.2
  const base = table({ a: [v(SAFETY, true)] })
  const cand = table({ a: [v(SAFETY, true)] })
  const ags = compareBackends(SAMPLES, base, cand, [SAFETY])
  assert.equal(ags[0].total, 1)
  assert.equal(ags[0].bothUnknown, 3)
  assert.ok(ags[0].agreementRate >= 0 && ags[0].agreementRate <= 1, `一致率越界：${ags[0].agreementRate}`)
  assert.equal(ags[0].agreementRate, 1)
})

test("方向分开数：漏报 / 误报 / 候选没判 是三个不同的数", () => {
  const base = table({
    a: [v(SAFETY, true)],
    b: [v(SAFETY, false)],
    c: [v(SAFETY, false)],
  })
  const cand = table({
    a: [v(SAFETY, false)], // 基线 PASS、候选 FAIL → 误报
    b: [v(SAFETY, true)], //  基线 FAIL、候选 PASS → 漏报
    // c 缺失 → 候选没判（也算漏报，但单独计数）
  })
  const ags = compareBackends(SAMPLES, base, cand, [SAFETY])
  assert.equal(ags[0].falseAlarms.length, 1, "误报应 1 条")
  assert.equal(ags[0].falseAlarms[0].id, "a")
  assert.equal(ags[0].regressions.length, 2, "漏报应 2 条（b 判反 + c 没判）")
  assert.equal(ags[0].candidateUnknown, 1, "候选没判应单独计数")
  assert.equal(ags[0].agree, 0)
})

test("候选没判 ≠ 判错：宁可分开报，否则排查时方向都看不出来", () => {
  const base = table({ a: [v(SAFETY, true)], b: [v(SAFETY, false)] })
  const cand = table({}) // 后端整个没输出
  const ags = compareBackends(SAMPLES, base, cand, [SAFETY])
  assert.equal(ags[0].candidateUnknown, 2)
  assert.equal(ags[0].regressions.length, 2)
  assert.equal(ags[0].falseAlarms.length, 0, "没判不该被记成误报")
})

// ---------- 门槛 ----------

test("门槛有分辨力：永远判 PASS 必须被拦下", () => {
  const base = table({ a: [v(SAFETY, true)], b: [v(SAFETY, false)], c: [v(FORMAT, false)] })
  const cand = table({ a: [v(SAFETY, true)], b: [v(SAFETY, true)], c: [v(FORMAT, true)] })
  const samples: SamplePair[] = [{ id: "a" }, { id: "b", risk: true }, { id: "c" }]
  const gate = applyGates(compareBackends(samples, base, cand, [SAFETY, FORMAT]), samples, base, {
    riskSampleIds: new Set(["b"]),
  })
  assert.equal(gate.ok, false)
  assert.ok(gate.failures.some((f) => f.includes("风险集") && f.includes("b")), "安全钩子的风险集回退必须报出来")
  assert.ok(gate.failures.some((f) => f.includes(FORMAT) && f.includes("一致率")), "格式钩子的一致率不达标也要报")
})

test("门槛有分辨力：永远判 FAIL 也必须被拦下（误报方向）", () => {
  const base = table({ a: [v(FORMAT, true)], b: [v(FORMAT, true)] })
  const cand = table({ a: [v(FORMAT, false)], b: [v(FORMAT, false)] })
  const samples: SamplePair[] = [{ id: "a" }, { id: "b" }]
  const gate = applyGates(compareBackends(samples, base, cand, [FORMAT]), samples, base)
  assert.equal(gate.ok, false)
  assert.ok(gate.failures.some((f) => f.includes("误报")), `误报必须报出来：${gate.failures.join("; ")}`)
})

test("门槛有分辨力：逐字复述标注必须能过（否则门槛永远红，同样没用）", () => {
  const base = table({ a: [v(SAFETY, true)], b: [v(SAFETY, false)] })
  const samples: SamplePair[] = [{ id: "a" }, { id: "b", risk: true }]
  const gate = applyGates(compareBackends(samples, base, base, [SAFETY]), samples, base, {
    riskSampleIds: new Set(["b"]),
  })
  assert.equal(gate.ok, true, `完全一致却不通过：${gate.failures.join("; ")}`)
})

test("安全类钩子：风险集之外的回退只卡一致率，不卡零回退门槛", () => {
  const base = table({ a: [v(SAFETY, false)], b: [v(SAFETY, false)] })
  const cand = table({ a: [v(SAFETY, true)], b: [v(SAFETY, false)] })
  const samples: SamplePair[] = [{ id: "a" }, { id: "b", risk: true }]
  const gate = applyGates(compareBackends(samples, base, cand, [SAFETY]), samples, base, {
    riskSampleIds: new Set(["b"]),
  })
  assert.equal(gate.ok, false, "一致率掉到 50% 仍应不过")
  assert.equal(gate.failures.some((f) => f.includes("风险集")), false, "b 没回退，不该报风险集")
})

test("非安全类钩子不套零回退门槛（格式钩子的错误代价方向相反）", () => {
  const base = table({ a: [v(FORMAT, false)] })
  const cand = table({ a: [v(FORMAT, true)] })
  const samples: SamplePair[] = [{ id: "a", risk: true }]
  const gate = applyGates(compareBackends(samples, base, cand, [FORMAT]), samples, base, {
    riskSampleIds: new Set(["a"]),
  })
  // 一致率 0% 会挂，但原因不该是「风险集回退」——那条只属于安全钩子
  assert.equal(gate.ok, false)
  assert.equal(gate.failures.some((f) => f.includes("风险集")), false, "格式钩子被套了安全钩子的门槛")
})

test("两边都判不出时不许悄悄放行（没有数据 ≠ 通过）", () => {
  const base = table({})
  const cand = table({})
  const samples: SamplePair[] = [{ id: "a" }]
  const gate = applyGates(compareBackends(samples, base, cand, [SAFETY]), samples, base)
  assert.equal(gate.ok, false, "一条样本都没有还判通过，等于没测")
  assert.ok(gate.failures.some((f) => f.includes("没有可比较的样本")), gate.failures.join("; "))
})

// ---------- 标注集本身 ----------

test("标注集：反例不少于正例（误报比漏报更常见，样本不能一边倒）", () => {
  const st = labeledSetStats()
  for (const id of HOOK_IDS) {
    assert.ok(st.expects[id].pass > 0, `${id} 没有 PASS 样本——门槛只能测漏报，测不到误报`)
    assert.ok(st.expects[id].fail > 0, `${id} 没有 FAIL 样本——门槛只能测误报，测不到漏报`)
  }
})

test("标注集：风险集非空且都标注了 FAIL（零回退门槛要有对象）", () => {
  const ids = riskSampleIds()
  assert.ok(ids.size > 0, "风险集是空的——安全钩子的零回退门槛没有可测的样本")
  for (const s of LABELED_SAMPLES.filter((x) => x.risk)) {
    assert.equal(s.expect[SAFETY].pass, false, `风险样本 ${s.id} 却标注 PASS，自相矛盾`)
  }
})

test("标注集：id 唯一、kind 合法、每个样本至少标注一条钩子", () => {
  const seen = new Set<string>()
  for (const s of LABELED_SAMPLES) {
    assert.ok(!seen.has(s.id), `样本 id 重复：${s.id}`)
    seen.add(s.id)
    assert.ok(s.kind === "boundary" || s.kind === "adversarial", `${s.id} kind 非法`)
    assert.ok(Object.keys(s.expect).length > 0, `${s.id} 没有标注任何钩子`)
    assert.ok(s.tool && s.output.trim(), `${s.id} 缺工具名或输出`)
  }
})

test("标注集：对抗样本确实难（把 FAIL 关键词写进无害输出）", () => {
  // 没有对抗样本的话，门槛测的只是「模型会不会被关键词骗到」的反面
  const adv = LABELED_SAMPLES.filter((s) => s.kind === "adversarial")
  assert.ok(adv.length >= 5, `对抗样本只有 ${adv.length} 条，太少`)
  // 至少有一条「输出里含 rm/删除 关键词但标注 PASS」
  const trap = adv.filter((s) => /rm |删除|del /i.test(s.output) && s.expect[SAFETY]?.pass === true)
  assert.ok(trap.length >= 1, "没有「含关键词但应放行」的对抗样本")
})
