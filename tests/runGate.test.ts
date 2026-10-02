import { test } from "node:test"
import assert from "node:assert/strict"
import { RunGate } from "../src/util/runGate.js"

test("RunGate：容量内直接放行", () => {
  const g = new RunGate(2)
  assert.equal(g.hasSlot, true)
  g.acquire()
  g.acquire()
  assert.equal(g.running, 2)
  assert.equal(g.hasSlot, false)
})

test("RunGate：超容量排队，释放按先到先得唤醒", async () => {
  const g = new RunGate(1)
  await g.acquire()
  const order: string[] = []
  const p1 = g.acquire().then(() => order.push("w1"))
  const p2 = g.acquire().then(() => order.push("w2"))
  assert.equal(g.waiting, 2)
  g.release()
  await p1
  assert.deepEqual(order, ["w1"])
  assert.equal(g.waiting, 1)
  g.release()
  await p2
  assert.deepEqual(order, ["w1", "w2"])
  assert.equal(g.running, 1) // 最后一个等待者被唤醒后占用中
})

test("RunGate：release 不超发（active 不为负）", async () => {
  const g = new RunGate(1)
  g.release()
  g.release()
  assert.equal(g.running, 0)
  await g.acquire()
  assert.equal(g.running, 1)
})

test("RunGate：max=0 表示不设限", async () => {
  const g = new RunGate(0)
  for (let i = 0; i < 5; i++) await g.acquire()
  assert.equal(g.running, 5)
  assert.equal(g.hasSlot, true)
})

test("RunGate：setMax 上调时唤醒等待者", async () => {
  const g = new RunGate(1)
  await g.acquire()
  const w = g.acquire()
  assert.equal(g.waiting, 1)
  g.setMax(2)
  await w
  assert.equal(g.running, 2)
  assert.equal(g.waiting, 0)
})

test("RunGate：maxWaitMs 反映队首等待时长", async () => {
  const g = new RunGate(1)
  await g.acquire()
  const p = g.acquire(Date.now() - 5000) // 模拟 5 秒前开始排队
  assert.ok(g.maxWaitMs >= 4900, `maxWaitMs=${g.maxWaitMs}`)
  g.release()
  await p
})
