/**
 * P1-11 场景专用工具：表格（xlsx/csv 读写）、Word 文档生成、图像生成、视频生成。
 * - 表格用 exceljs，Word 用 docx（都已 npm install）
 * - 图像/视频生成：调 provider 的 OpenAI 兼容 images/generations 接口（config.providers 里任一通道）；
 *   无可用通道时返回清晰错误提示。视频生成接口尚未标准化，先返回引导（走 delegate/搜索方案）。
 * - 输出统一写当前会话 cwd（工具上下文 currentCwd()），文件路径回传给模型。
 */
import { z } from "zod"
import { tool, type Tool } from "ai"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve, extname } from "node:path"
import { loadConfig } from "./config.js"
import { toolCtx } from "./tools.js"

function currentCwd(): string {
  return toolCtx.getStore()?.cwd ?? process.cwd()
}

// ---------- 表格：读取 ----------

export const xlsxReadTool = tool({
  description:
    "读取本地表格文件（.xlsx/.csv）内容，返回结构化 JSON（sheet 名 + 行数据）。用于查看/分析表格数据，最多返回前 500 行。",
  inputSchema: z.object({
    path: z.string().describe("表格文件路径（相对当前工作区或绝对路径）"),
    sheet: z.string().optional().describe("工作表名（缺省取第一个）"),
  }),
  async execute({ path: p, sheet }) {
    const full = resolve(currentCwd(), p)
    if (!existsSync(full)) return `[失败] 文件不存在: ${full}`
    const ext = extname(full).toLowerCase()
    try {
      if (ext === ".csv") {
        const ExcelJS = (await import("exceljs")).default
        const wb = new ExcelJS.Workbook()
        const ws = await wb.csv.readFile(full)
        const rows = wsToRows(ws)
        return JSON.stringify({ sheet: "csv", rows: rows.slice(0, 500), totalRows: rows.length }, null, 2)
      }
      if (ext !== ".xlsx" && ext !== ".xls") return `[失败] 不支持的表格类型: ${ext}（支持 xlsx/csv）`
      const ExcelJS = (await import("exceljs")).default
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(full)
      const names = wb.worksheets.map((w) => w.name)
      const target = (sheet && names.includes(sheet) ? wb.getWorksheet(sheet) : wb.worksheets[0])
      if (!target) return `[失败] 找不到工作表`
      const rows = wsToRows(target)
      return JSON.stringify({ sheets: names, activeSheet: target.name, rows: rows.slice(0, 500), totalRows: rows.length }, null, 2)
    } catch (e) {
      return `[失败] 读取表格出错: ${(e as Error).message}`
    }
  },
})

function wsToRows(ws: import("exceljs").Worksheet): unknown[][] {
  const rows: unknown[][] = []
  for (let i = 1; i <= Math.min(ws.rowCount ?? 0, 2000); i++) {
    const vals = ws.getRow(i).values as unknown[] | { [key: string]: unknown }
    const arr = Array.isArray(vals) ? vals.slice(1) : []
    rows.push(arr)
  }
  // 去掉末尾连续空行
  while (rows.length && rows[rows.length - 1].every((c) => c == null || c === "")) rows.pop()
  return rows
}

// ---------- 表格：写入 ----------

export const xlsxWriteTool = tool({
  description:
    "把数据写成 Excel 表格（.xlsx）或 CSV 文件，保存到当前工作区，返回文件路径。rows 是二维数组（第一行当表头）。",
  inputSchema: z.object({
    path: z.string().describe("输出文件路径（.xlsx 或 .csv，相对当前工作区）"),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe("二维数组数据，第一行为表头"),
    sheet: z.string().optional().describe("工作表名（xlsx 时可选，默认 Sheet1）"),
  }),
  async execute({ path: p, rows, sheet }) {
    if (!Array.isArray(rows) || !rows.length) return "[失败] rows 必须是非空二维数组"
    const full = resolve(currentCwd(), p)
    const ext = extname(full).toLowerCase()
    try {
      const ExcelJS = (await import("exceljs")).default
      const wb = new ExcelJS.Workbook()
      if (ext === ".csv") {
        const ws = wb.addWorksheet("csv")
        ws.addRows(rows)
        await wb.csv.writeFile(full)
      } else if (ext === ".xlsx") {
        const ws = wb.addWorksheet(sheet || "Sheet1")
        ws.addRows(rows)
        // 表头加粗
        ws.getRow(1).font = { bold: true }
        await wb.xlsx.writeFile(full)
      } else {
        return "[失败] 输出文件只能是 .xlsx 或 .csv"
      }
      return `[已生成] ${full}（${rows.length} 行 × ${rows[0]?.length ?? 0} 列）`
    } catch (e) {
      return `[失败] 写表格出错: ${(e as Error).message}`
    }
  },
})

// ---------- Word 文档生成 ----------

export const docxWriteTool = tool({
  description:
    "把 Markdown 风格的结构化内容生成 Word 文档（.docx），保存到当前工作区，返回文件路径。支持标题（#/##/###）、段落、加粗 **text**、列表（- 开头）。",
  inputSchema: z.object({
    path: z.string().describe("输出文件路径（.docx，相对当前工作区）"),
    content: z.string().describe("文档内容（Markdown 风格：# 标题 / ## 二级 / 段落 / - 列表）"),
    title: z.string().optional().describe("文档元数据标题"),
  }),
  async execute({ path: p, content, title }) {
    const full = resolve(currentCwd(), p)
    if (extname(full).toLowerCase() !== ".docx") return "[失败] 输出文件必须是 .docx"
    try {
      const docx = await import("docx")
      const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx
      const boldRuns = (text: string): InstanceType<typeof TextRun>[] => {
        // 把 **bold** 标记转成 TextRun 数组（段落内加粗）
        const runs: InstanceType<typeof TextRun>[] = []
        const re = /\*\*(.+?)\*\*/g
        let last = 0, m2
        while ((m2 = re.exec(text))) {
          if (m2.index > last) runs.push(new TextRun({ text: text.slice(last, m2.index) }))
          runs.push(new TextRun({ text: m2[1], bold: true }))
          last = m2.index + m2[0].length
        }
        if (last < text.length) runs.push(new TextRun({ text: text.slice(last) }))
        return runs.length ? runs : [new TextRun({ text })]
      }
      const paras: InstanceType<typeof Paragraph>[] = []
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trimEnd()
        if (!line.trim()) { paras.push(new Paragraph({ text: "" })); continue }
        const h = line.match(/^(#{1,4})\s+(.*)$/)
        if (h) {
          const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][h[1].length - 1]
          paras.push(new Paragraph({ text: h[2], heading: level }))
          continue
        }
        if (/^[-*]\s+/.test(line)) {
          paras.push(new Paragraph({ children: boldRuns(line.replace(/^[-*]\s+/, "")), bullet: { level: 0 } }))
          continue
        }
        paras.push(new Paragraph({ children: boldRuns(line) }))
      }
      const doc = new Document({
        title: title || undefined,
        sections: [{ children: paras }],
      })
      mkdirSync(resolve(full, ".."), { recursive: true })
      const buf = await Packer.toBuffer(doc)
      writeFileSync(full, buf)
      return `[已生成] ${full}`
    } catch (e) {
      return `[失败] 生成 Word 出错: ${(e as Error).message}`
    }
  },
})

// ---------- 图像生成 ----------

export const imggenTool = tool({
  description:
    "AI 生成图片：按文字描述生成一张图片，保存为当前工作区下的 PNG 并返回路径。需要已配置支持图像生成的模型通道（自动选用可用的 provider）。",
  inputSchema: z.object({
    prompt: z.string().describe("图片描述（越具体越好：主体、风格、构图、色调）"),
    filename: z.string().optional().describe("输出文件名（默认 generated-<时间戳>.png）"),
    size: z.string().optional().describe("尺寸，如 1024x1024 / 512x512（默认 1024x1024，服务商不支持时自动回落）"),
  }),
  async execute({ prompt, filename, size }) {
    const cfg = loadConfig()
    // T15 优先用设置里指定的默认生图模型（provider/modelId），失败再自动遍历
    const pinned = cfg.imageModel
    const order: Array<[string, { baseURL: string; apiKey: string; models?: string[] }]> = []
    if (pinned) {
      const [pn, ...rest] = pinned.split("/")
      const pv = cfg.providers[pn]
      if (pv) order.push([pn, { ...pv, models: [rest.join("/")] } satisfies { baseURL: string; apiKey: string; models?: string[] }])
    }
    for (const [name, pv] of Object.entries(cfg.providers)) {
      if (pinned && name === pinned.split("/")[0]) continue
      order.push([name, pv])
    }
    if (!order.length) return "[失败] 尚未配置任何模型通道，请先在设置里添加模型"
    const errors: string[] = []
    for (const [name, pv] of order) {
      if (!pv.baseURL || pv.apiKey === "REPLACE_ME") continue
      try {
        const r = await fetch(`${pv.baseURL.replace(/\/+$/, "")}/images/generations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${pv.apiKey}` },
          body: JSON.stringify({ model: guessImageModel(pv.models), prompt, size: size || "1024x1024", n: 1, response_format: "b64_json" }),
          signal: AbortSignal.timeout(120_000),
        })
        if (!r.ok) { errors.push(`${name}: HTTP ${r.status}`); continue }
        const data = await r.json() as { data?: Array<{ b64_json?: string; url?: string }> }
        const item = data.data?.[0]
        if (!item) { errors.push(`${name}: 响应无数据`); continue }
        let buf: Buffer
        if (item.b64_json) buf = Buffer.from(item.b64_json, "base64")
        else if (item.url) {
          const img = await fetch(item.url, { signal: AbortSignal.timeout(60_000) })
          if (!img.ok) { errors.push(`${name}: 图片下载失败 HTTP ${img.status}`); continue }
          buf = Buffer.from(await img.arrayBuffer())
        } else { errors.push(`${name}: 既无 b64 也无 url`); continue }
        const out = resolve(currentCwd(), filename || `generated-${Date.now()}.png`)
        mkdirSync(resolve(out, ".."), { recursive: true })
        writeFileSync(out, buf)
        return `[已生成] ${out}（${(buf.length / 1024).toFixed(0)} KB，通道 ${name}）`
      } catch (e) {
        errors.push(`${name}: ${(e as Error).message}`)
      }
    }
    return `[失败] 所有通道都生成失败：${errors.join("；")}。注意：普通对话模型通道通常不支持图像生成，需在 设置→模型→默认生图模型 配置图像生成服务（如通义万相、DALL·E 兼容接口）。`
  },
})

function guessImageModel(models?: string[]): string | undefined {
  // 常见图像模型关键词优先
  const kw = ["image", "dall", "flux", "wanx", "cogview", "seedream", "sd", "stable"]
  return models?.find((m) => kw.some((k) => m.toLowerCase().includes(k))) ?? models?.[0]
}

// ---------- 视频生成 ----------

export const videogenTool = tool({
  description:
    "AI 生成视频（实验性）：按文字描述生成短视频。需要已配置支持视频生成的通道（如可灵、通义万相视频版）。多数对话通道不支持，失败时会给出明确提示。",
  inputSchema: z.object({
    prompt: z.string().describe("视频内容描述（主体 + 运镜 + 时长感受）"),
    filename: z.string().optional().describe("输出文件名（默认 generated-<时间戳>.mp4）"),
  }),
  async execute({ prompt, filename }) {
    const cfg = loadConfig()
    const providers = Object.entries(cfg.providers)
    if (!providers.length) return "[失败] 尚未配置任何模型通道"
    const errors: string[] = []
    for (const [name, pv] of providers) {
      if (!pv.baseURL || pv.apiKey === "REPLACE_ME") continue
      try {
        // 视频接口行业未统一，先探测常见 async 任务式接口（阿里系 videos/generations）
        const r = await fetch(`${pv.baseURL.replace(/\/+$/, "")}/videos/generations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${pv.apiKey}` },
          body: JSON.stringify({ model: pv.models?.[0], prompt }),
          signal: AbortSignal.timeout(30_000),
        })
        if (!r.ok) { errors.push(`${name}: HTTP ${r.status}`); continue }
        const data = await r.json() as { output?: { task_id?: string }; task_id?: string }
        const taskId = data.output?.task_id ?? data.task_id
        if (!taskId) { errors.push(`${name}: 未返回任务 id`); continue }
        // 轮询任务状态（最多 8 分钟）
        for (let i = 0; i < 48; i++) {
          await new Promise((res) => setTimeout(res, 10_000))
          const q = await fetch(`${pv.baseURL.replace(/\/+$/, "")}/videos/generations/${taskId}`, {
            headers: { Authorization: `Bearer ${pv.apiKey}` },
          })
          if (!q.ok) continue
          const st = await q.json() as { output?: { task_status?: string; video_url?: string } }
          const status = st.output?.task_status
          if (status === "SUCCEEDED" && st.output?.video_url) {
            const out = resolve(currentCwd(), filename || `generated-${Date.now()}.mp4`)
            mkdirSync(resolve(out, ".."), { recursive: true })
            const v = await fetch(st.output.video_url)
            writeFileSync(out, Buffer.from(await v.arrayBuffer()))
            return `[已生成] ${out}（通道 ${name}）`
          }
          if (status === "FAILED") { errors.push(`${name}: 任务失败`); break }
        }
        errors.push(`${name}: 轮询超时`)
      } catch (e) {
        errors.push(`${name}: ${(e as Error).message}`)
      }
    }
    return `[失败] 视频生成不可用：${errors.join("；")}。当前没有支持视频生成的通道——视频生成需要专门的服务（如可灵 API、通义万相视频），配置后重试。`
  },
})

// ---------- 组装 ----------

export function sceneTools(): Record<string, Tool> {
  return {
    xlsx_read: xlsxReadTool,
    xlsx_write: xlsxWriteTool,
    docx_write: docxWriteTool,
    imggen: imggenTool,
    videogen: videogenTool,
  } as Record<string, Tool>
}
