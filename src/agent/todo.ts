import { tool } from "ai"
import { z } from "zod"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { toolCtx } from "./tools.js"

/**
 * P2-4 进度可见 + 会话隔离：
 * - todo 按会话存储：~/.yyagent/todo/<sessionId>.json（新对话不会再看到旧任务的进度）
 * - 兼容旧全局文件 ~/.yyagent/todo.json（只读回退，读后即迁移删除）
 * - toolCtx 传 sessionId（网关 runTurn / TUI 均已设置 cwd 上下文；TUI 走 active.id 传入）
 */

const TODO_DIR = join(homedir(), ".yyagent", "todo")
const LEGACY_FILE = join(homedir(), ".yyagent", "todo.json")

export interface TodoItem {
  content: string
  status: "pending" | "in_progress" | "done"
}

function sessionFile(sessionId: string): string {
  return join(TODO_DIR, `${sessionId}.json`)
}

/** 读指定会话的 todo；无 sessionId 时回退旧全局文件（读到非空即迁移到……不，无 id 无法归属，直接清掉） */
export function readTodo(sessionId?: string): TodoItem[] {
  if (sessionId) {
    const f = sessionFile(sessionId)
    if (!existsSync(f)) return []
    try {
      return JSON.parse(readFileSync(f, "utf8")) as TodoItem[]
    } catch {
      return []
    }
  }
  // 无会话上下文：兼容读旧全局文件
  try {
    return JSON.parse(readFileSync(LEGACY_FILE, "utf8")) as TodoItem[]
  } catch {
    return []
  }
}

/**
 * T93 P3：把当前 todo 清单渲染成一段注入系统提示的文本。
 *
 * 为什么需要它：`todo_write` 是**唯一**的 todo 工具——**只有写，没有读**。
 * 而它是全量覆盖语义，模型想「收回主线」只能凭记忆重写整个清单。
 * 短任务无所谓；**长任务跑过 30 步之后记忆已经被压缩成一段摘要**，
 * 于是模型实际上再也读不回自己定过的计划——这是长任务跑偏最直接的根源。
 *
 * 放在 `todo.ts` 而不是各自写在网关/TUI 里：两个入口都要注入，
 * 抄两份迟早漂（config.longTask 的教训）。
 */
export function todoPrompt(sessionId?: string): string {
  let items: TodoItem[] = []
  try {
    items = readTodo(sessionId)
  } catch {
    return ""
  }
  if (!Array.isArray(items) || !items.length) return ""
  const done = items.filter((i) => i && i.status === "done").length
  const lines = items
    .filter((i) => i && typeof i.content === "string")
    .map((i) => `- [${i.status === "done" ? "x" : i.status === "in_progress" ? ">" : " "}] ${i.content}`)
    .join("\n")
  if (!lines) return ""
  return (
    `【当前任务计划】（${done}/${items.length} 已完成）\n` +
    `${lines}\n` +
    `以上是你此前用 todo_write 维护的清单的**当前真实状态**，不是历史记录。` +
    `完成一步后直接用 todo_write 全量更新它；要调整计划也基于这份改，不要凭记忆重写。`
  )
}

/** 写指定会话的 todo；items 为空数组 = 清除该会话 todo */
export function writeTodo(sessionId: string, items: TodoItem[]): void {
  mkdirSync(TODO_DIR, { recursive: true })
  const f = sessionFile(sessionId)
  if (!items.length) {
    try {
      rmSync(f)
    } catch {
      /* 不存在即成功 */
    }
    return
  }
  writeFileSync(f, JSON.stringify(items, null, 2))
}

/** 删除会话时连 todo 一起清理 */
export function deleteTodo(sessionId: string): void {
  try {
    rmSync(sessionFile(sessionId))
  } catch {
    /* 不存在即成功 */
  }
}

export function makeTodoTool(): Record<string, unknown> {
  return {
    todo_write: tool({
      description:
        "维护当前任务计划/进度清单。复杂任务开始前先写出分步计划；执行中随时更新状态（至少完成一步就更新一次）。任务全部完成时传空数组 items=[] 清除清单（进度条随之消失）。这既是计划也是给用户的进度展示。",
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              content: z.string().describe("步骤内容"),
              status: z.enum(["pending", "in_progress", "done"]).describe("状态"),
            }),
          )
          .describe("完整清单（全量覆盖）；空数组 = 清除清单"),
      }),
      async execute({ items }) {
        // 会话 id 从调用上下文取：网关 runTurn 用 toolCtx 注入；拿不到就退回全局文件（TUI 旧路径兼容）
        const sessionId = (toolCtx.getStore() as { sessionId?: string } | undefined)?.sessionId
        if (sessionId) {
          writeTodo(sessionId, items as TodoItem[])
        } else {
          mkdirSync(join(TODO_DIR, ".."), { recursive: true })
          writeFileSync(LEGACY_FILE, JSON.stringify(items, null, 2))
        }
        const done = items.filter((i) => i.status === "done").length
        return items.length ? `计划已更新：${done}/${items.length} 完成` : "清单已清除"
      },
    }),
  }
}
