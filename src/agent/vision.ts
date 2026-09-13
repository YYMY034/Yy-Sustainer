import { existsSync, readFileSync } from "node:fs"
import { generateText } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { loadConfig, resolveModel } from "./config.js"
import { composeSystem } from "./prompt.js"

const IMG_RE = /\.(png|jpe?g|webp|gif|bmp)$/i

export function isImageFile(p: string): boolean {
  return IMG_RE.test(p)
}

/** 主模型是否支持图片直传（provider 配 supportsImages: true） */
export function mainModelSupportsImages(modelSpec?: string): boolean {
  try {
    const config = loadConfig()
    const name = (modelSpec ?? config.model).split("/")[0]
    return config.providers[name]?.supportsImages === true
  } catch {
    return false
  }
}

/** 用配置的识图模型（config.visionModel）描述一张图片，返回描述文本 */
export async function describeImage(absPath: string, visionModelSpec?: string): Promise<string> {
  return describeImageBase64(readFileSync(absPath).toString("base64"), visionModelSpec)
}

/** P1-4 识图分流：直接吃 base64（Web 客户端上传的图片没有落盘），回答由调用方的主模型生成 */
export async function describeImageBase64(b64: string, visionModelSpec?: string): Promise<string> {
  const config = loadConfig()
  const spec = visionModelSpec ?? config.visionModel
  if (!spec) throw new Error("未设置识图模型（设置页可配置默认识图模型）")
  const { providerName, provider, modelId } = resolveModel(config, spec)
  const prov = createOpenAICompatible({ name: providerName, baseURL: provider.baseURL, apiKey: provider.apiKey })
  const r = await generateText({
    model: prov.chatModel(modelId),
    // T73：识图转述同样注入基础层；严格输出契约（只转述、不额外发挥）放 role 槽
    system: composeSystem({
      role: "你是图像转述器。只做一件事：把图片内容完整、忠实地转述成中文文字（界面元素、文字、图表、数据、关键信息）。不要评价、不要替用户回答图片里的问题、不要输出对话语句——你的输出会被转交给另一个模型作为唯一信息来源。",
    }),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "请详细描述这张图片的全部内容，尽量完整、忠实，不要遗漏任何文字。" },
          { type: "image", image: b64 },
        ],
      },
    ],
    maxRetries: 2,
  })
  return r.text
}

export function readTextAttachment(absPath: string): string {
  return readFileSync(absPath, "utf8").slice(0, 20_000)
}

export function attachmentExists(absPath: string): boolean {
  return existsSync(absPath)
}
