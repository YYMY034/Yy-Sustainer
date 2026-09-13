import { readFileSync, writeFileSync } from 'node:fs'

const P = 'web/index.html'
const lines = readFileSync(P, 'utf8').split('\n')

const startMark = '// T37 文件管理图标：按类型着色'
const endMark = 'async function loadFiles(rel = "") {'
const anchor = '// T37 独立会话图标（齿轮）'
const oldNote = '// 注：本块 const 位于脚本尾部初始化调用之后，但 fmIcon 只在 loadFiles 的 await 之后被调用（脚本已求值完），'
const newNote = '// 注：本块必须留在 render() 之前的脚本前部——render() 会在脚本尾部初始化时同步执行，'
const newNote2 = '// 产物区（消息末尾）也要用同一套图标；若挪到后面会 TDZ 报错（见白皮书「TDZ 大坑」）。'

const s = lines.findIndex((l) => l.startsWith(startMark))
const e = lines.findIndex((l) => l.startsWith(endMark))
const a = lines.findIndex((l) => l.startsWith(anchor))
if (s < 0 || e < 0 || a < 0) throw new Error(`标记未找到 s=${s} e=${e} a=${a}`)

// 保底：块内必须包含 fmIcon 与 FM_GLYPH_COLOR，防止切错
const slice = lines.slice(s, e).join('\n')
if (!slice.includes('function fmIcon') || !slice.includes('FM_GLYPH_COLOR')) throw new Error('切片内容不符预期')

// 截到 fmIcon 的收尾大括号为止（其后到 endMark 之间只允许空行/注释）
let cut = e
for (let i = e - 1; i >= s; i--) {
  if (lines[i] === '}') { cut = i + 1; break }
}
const block = lines.slice(s, cut)
const blockIdx = block.findIndex((l) => l.startsWith(oldNote))
if (blockIdx >= 0) block[blockIdx] = newNote
block.splice(blockIdx >= 0 ? blockIdx + 1 : 0, blockIdx >= 0 ? 1 : 0, ...(blockIdx >= 0 ? [newNote2] : []))

// 先删原块（连同紧随其后的空行）
let delEnd = cut
while (delEnd < lines.length && lines[delEnd].trim() === '') delEnd++
lines.splice(s, delEnd - s)

// 再插到 render() 之前的锚点前（若原块在锚点之前，索引可能偏移——锚点重新查找）
const a2 = lines.findIndex((l) => l.startsWith(anchor))
if (a2 < 0) throw new Error('锚点消失')
lines.splice(a2, 0, block.join('\n'), '')

writeFileSync(P, lines.join('\n'))
console.log(`搬移完成：原位置 ${s + 1} 起，块长 ${block.length} 行，插入到 ${a2 + 1} 前`)
