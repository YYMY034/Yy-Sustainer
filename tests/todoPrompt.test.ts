/**
 * T93 P3：todo 清单注入的守卫。
 *
 * 起因：`todo_write` 是**唯一**的 todo 工具——只有写、没有读，而且是全量覆盖语义。
 * 提示词让模型「感觉发散时主动用 todo_write 收回主线」，但它要收回主线只能凭记忆
 * 重写整个清单；而长任务跑过 30 步之后记忆已经被压缩成一段摘要。
 * 于是模型实际上再也读不回自己定过的计划——长任务跑偏最直接的根源。
 *
 * 修法是把当前清单注入 systemSuffix。这里盯三件事：
 *   ① 有清单就必须注入，且把「当前真实状态」说清楚（不是历史记录）
 *   ② 没清单就返回空串——不能注入一段「【当前任务计划】（0/0）」占地方
 *   ③ 脏数据不能让它抛（读文件/解析都可能失败，注入失败不该拖垮一轮）
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const SRC = (p: string): string => readFileSync(join(process.cwd(), p), "utf8")
import { todoPrompt } from "../src/agent/todo.js"

const DIR = join(homedir(), ".yyagent", "todo")

function writeTodo(sid: string, items: unknown): void {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(join(DIR, `${sid}.json`), JSON.stringify(items))
}
function clean(): void {
  try { rmSync(DIR, { recursive: true, force: true }) } catch { /* 本来就不存在 */ }
}

test("有清单：注入并说清这是「当前真实状态」", () => {
  clean()
  writeTodo("s1", [
    { content: "读代码", status: "done" },
    { content: "改 loop.ts", status: "in_progress" },
    { content: "跑测试", status: "pending" },
  ])
  const p = todoPrompt("s1")
  assert.ok(p.includes("【当前任务计划】"), p)
  assert.ok(p.includes("1/3 已完成"), p)
  assert.ok(p.includes("- [x] 读代码"), p)
  assert.ok(p.includes("- [>] 改 loop.ts"), p)
  assert.ok(p.includes("- [ ] 跑测试"), p)
  // 关键：要让它知道这是当前状态、可以直接改，而不是一段历史流水
  assert.ok(p.includes("当前真实状态"), p)
  assert.ok(p.includes("不要凭记忆重写"), p)
})

test("没清单：返回空串（不能注入一段 0/0 占地方）", () => {
  clean()
  assert.equal(todoPrompt("nope"), "")
  assert.equal(todoPrompt(undefined), "")
  writeTodo("s-empty", [])
  assert.equal(todoPrompt("s-empty"), "")
})

test("脏数据不抛：坏 JSON / 非数组 / 缺字段", () => {
  clean()
  mkdirSync(DIR, { recursive: true })
  writeFileSync(join(DIR, "bad.json"), '{"not":"an array"}')
  assert.equal(todoPrompt("bad"), "")
  writeFileSync(join(DIR, "broken.json"), '[{"content":"x",')
  assert.equal(todoPrompt("broken"), "")
  writeFileSync(join(DIR, "nulls.json"), JSON.stringify([null, { content: "ok", status: "pending" }, 42]))
  const p = todoPrompt("nulls")
  assert.ok(p.includes("- [ ] ok"), `脏条目应被过滤，实际：${p}`)
  assert.ok(!p.includes("null"), p)
})

test("status 不在枚举里的条目按未完成渲染（不崩）", () => {
  clean()
  writeTodo("s-weird", [{ content: "怪状态", status: "whatever" }])
  const p = todoPrompt("s-weird")
  assert.ok(p.includes("- [ ] 怪状态"), p)
  assert.ok(p.includes("0/1"), p)
})

test("网关与 TUI 用同一个函数（抄两份迟早漂）", () => {
  const gw = SRC("src/gateway.ts")
  const tui = SRC("src/tui/App.tsx")
  const todoSrc = SRC("src/agent/todo.ts")
  assert.ok(gw.includes("todoPrompt(sessionId)"), "网关没注入")
  assert.ok(tui.includes("todoPrompt(active.id)"), "TUI 没注入")
  // 两边都必须从 todo.ts 导入，而不是各自实现一份
  assert.ok(gw.includes('from "./agent/todo.js"'), "网关该从 todo.ts 导入")
  assert.ok(tui.includes('from "../agent/todo.js"'), "TUI 该从 todo.ts 导入")
  assert.equal((todoSrc.match(/export function todoPrompt/g) ?? []).length, 1, "todoPrompt 只能有一份定义")
  // 反向：不许有人在网关/TUI 里另写一份渲染逻辑
  assert.equal(/function todoPrompt/.test(gw), false, "网关里又实现了一份")
  assert.equal(/function todoPrompt/.test(tui), false, "TUI 里又实现了一份")
})

process.on("exit", () => {
  try { rmSync(DIR, { recursive: true, force: true }) } catch { /* 临时 */ }
})
