#!/usr/bin/env node
/**
 * Tabbit Browser MCP server（T44）—— 官方 tabbit-cli.exe 的 MCP 封装。
 *
 * 为什么要换掉旧的 .workbuddy/vendor/tabbit-browser/mcp-server.js：
 *   那个 server 走 Chrome DevTools Protocol，要求浏览器以 `--remote-debugging-port=9222`
 *   启动。用户日常双击打开的 Tabbit 没有这个端口，于是每次调用都返回 "Not connected"，
 *   它的 tabbit_launch 又会 taskkill 掉正在用的浏览器进程 —— 属于"要么用不了、要么毁现场"。
 *
 *   Tabbit 官方提供了 LocalAgent CLI（Windows 在 %LOCALAPPDATA%\Tabbit\LocalAgent\bin\tabbit-cli.exe），
 *   通过已经运行的浏览器实例直连，不需要调试端口、不重启浏览器，支持真实点击/填表/截图/多标签接管。
 *
 * 本文件只做「MCP 工具 ↔ CLI 命令」的翻译，不做业务逻辑。
 * 环境变量：
 *   TABBIT_CLI   覆盖 tabbit-cli 可执行文件路径
 *   TABBIT_TASK  任务名（同一任务内多次调用共享浏览器上下文），默认 Yy Sustainer（T58：对外可见名用产品名）
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const TIMEOUT_MS = 150_000
const MAX_TEXT = 12_000
const TASK = process.env.TABBIT_TASK || "Yy Sustainer"

/** 剥掉 CLI 每次都会打印的实例标识行，只留 JSON */
function cleanOut(raw) {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() && !/^TABBIT_PLAYWRIGHT_INSTANCE=/.test(l))
  return lines.join("\n").trim()
}

/** inspect 会回整棵无障碍树，动辄几万字符——截断，免得一次调用吃掉整个上下文 */
function cap(text) {
  if (text.length <= MAX_TEXT) return text
  return `${text.slice(0, MAX_TEXT)}\n...[已截断，完整回执共 ${text.length} 字符；需要细节请用 tabbit_receipt 按 requestId 取，或缩小 page 的抓取范围]`
}

function cliPath() {
  if (process.env.TABBIT_CLI) return process.env.TABBIT_CLI
  if (process.platform === "win32") {
    const la = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
    return join(la, "Tabbit", "LocalAgent", "bin", "tabbit-cli.exe")
  }
  return join(homedir(), ".local", "bin", "tabbit-cli")
}

const CLI = cliPath()

function runCli(args, stdinText) {
  return new Promise((resolve) => {
    if (!existsSync(CLI)) {
      resolve(`[失败] 找不到 tabbit-cli：${CLI}\nTabbit 浏览器似乎没有安装（或路径变了）。可用环境变量 TABBIT_CLI 指定。`)
      return
    }
    const child = spawn(CLI, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    let out = ""
    let err = ""
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      resolve(`[超时] tabbit-cli ${args.join(" ")} 超过 ${TIMEOUT_MS}ms 未返回。`)
    }, TIMEOUT_MS)
    child.stdout.on("data", (d) => (out += d.toString("utf8")))
    child.stderr.on("data", (d) => (err += d.toString("utf8")))
    child.on("error", (e) => {
      clearTimeout(timer)
      resolve(`[失败] 启动 tabbit-cli 出错：${e.message}`)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const body = cleanOut(out)
      if (code === 0 && body) resolve(body)
      else if (code === 0) resolve(`[空结果] tabbit-cli ${args.join(" ")} 没有输出。${err.trim()}`)
      else resolve(`[失败 code=${code}] tabbit-cli ${args.join(" ")}\n${body}\n${err.trim()}`)
    })
    if (stdinText != null) child.stdin.write(stdinText, "utf8")
    child.stdin.end()
  })
}

const TOOLS = [
  {
    name: "tabbit_tabs",
    description:
      "列出 Tabbit 浏览器当前所有标签页（tabId / 标题 / URL / 是否活动 / 分组）。" +
      "想对用户已经开着的页面动手（如某个后台、某个文档）时先调它拿到 tabId，再用 tabbit_claim 接管。只读，不新建任务。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tabbit_claim",
    description:
      "把浏览器里已存在的标签页接管进当前任务（接管后才允许用 tabbit_run 操作它们）。tabIds 来自 tabbit_tabs。",
    inputSchema: {
      type: "object",
      properties: { tabIds: { type: "array", items: { type: "string" }, description: "要接管的 tabId 列表" } },
      required: ["tabIds"],
    },
  },
  {
    name: "tabbit_run",
    description:
      "在 Tabbit 浏览器里执行一段 Playwright 代码（真实点击 / 填表 / 导航 / 抓取），返回执行回执。" +
      "代码体里可直接用 page、context、expect；用 `return 值` 把结果带回来。例：`await page.goto('https://x.com',{waitUntil:'domcontentloaded'}); return await page.title();`。" +
      "若回执 status 是 queued，说明还没跑完，接着调 tabbit_inspect 等待结果，不要重复提交。",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Playwright 代码体（不含 import，可用 page/context/expect）" },
        requestId: { type: "string", description: "可选，本次请求标识，便于之后用 tabbit_receipt 精确取回" },
      },
      required: ["code"],
    },
  },
  {
    name: "tabbit_inspect",
    description: "等待并取回上一次 tabbit_run 的结果（用于回执返回 queued 时）。waitMs 默认 60000。",
    inputSchema: {
      type: "object",
      properties: {
        waitMs: { type: "number", description: "最长等待毫秒数，默认 60000，上限 120000" },
        requestId: { type: "string", description: "可选，只想取某个 requestId 的结果" },
      },
    },
  },
  {
    name: "tabbit_screenshot",
    description: "给当前页面（或整页）截图，返回产物路径。用于「看一眼页面上有什么」。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "可选，截图文件名" },
        fullPage: { type: "boolean", description: "true = 整页长截图，默认只截可视区" },
      },
    },
  },
  {
    name: "tabbit_receipt",
    description: "按 requestId 精确取回某次请求的回执（跨进程重启后仍可查，兜底用）。",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string", description: "之前 tabbit_run 使用的 requestId" } },
      required: ["requestId"],
    },
  },
  {
    name: "tabbit_diagnose",
    description: "检查 Tabbit 浏览器与 CLI 的连通状态（实例号、控制器状态、能力版本）。连不上时先调它定位原因。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tabbit_finish",
    description:
      "结束当前任务。默认保留标签页与分组（用户还能接着用）；discard=true 时关闭本任务新建的标签页。" +
      "任务做完后调用一次，避免长期占用浏览器控制权。",
    inputSchema: { type: "object", properties: { discard: { type: "boolean", description: "true = 顺带关掉本任务新建的标签" } } },
  },
]

async function dispatch(name, args) {
  const task = ["--task", TASK]
  switch (name) {
    case "tabbit_tabs":
      return runCli(["tabs", ...task])
    case "tabbit_claim":
      return runCli(["claim", ...task, ...(args.tabIds ?? []).flatMap((id) => ["--tab", String(id)])])
    case "tabbit_run": {
      const extra = args.requestId ? ["--request", String(args.requestId)] : []
      return runCli(["nodejs", ...task, ...extra], String(args.code ?? ""))
    }
    case "tabbit_inspect": {
      const ms = Math.min(120_000, Math.max(1000, Number(args.waitMs) || 60_000))
      const extra = args.requestId ? ["--request", String(args.requestId)] : []
      return runCli(["inspect", ...task, "--wait-ms", String(ms), ...extra])
    }
    case "tabbit_screenshot":
      return runCli([
        "screenshot",
        ...task,
        ...(args.name ? ["--name", String(args.name)] : []),
        ...(args.fullPage ? ["--full-page"] : []),
      ])
    case "tabbit_receipt":
      return runCli(["receipt", ...task, "--request", String(args.requestId)])
    case "tabbit_diagnose":
      // 不带 --task：诊断的用途是"动手前先看浏览器连不连得上"，此刻任务往往还不存在，
      // 带 --task 会被 CLI 以 "Unknown task name" 拒掉，反而误报成故障
      return runCli(["diagnose"])
    case "tabbit_finish":
      return runCli(["finish", ...task, ...(args.discard ? ["--discard"] : [])])
    default:
      return `[失败] 未知工具：${name}`
  }
}

const server = new Server({ name: "tabbit", version: "2.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text = cap(await dispatch(req.params.name, req.params.arguments ?? {}))
  return { content: [{ type: "text", text }] }
})

await server.connect(new StdioServerTransport())
