// T49 chart 围栏渲染器断言（check-t49/t50 已被其他任务占用，用描述性后缀）
import { readFileSync } from "node:fs";
const root = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("OK   " + name) } else { fail++; console.log("FAIL " + name) } };
const web = readFileSync(root + "/web/index.html", "utf8");
const prompt = readFileSync(root + "/src/agent/prompt.ts", "utf8");
const fnStart = web.indexOf("function renderChartBlock");
const fnBody = web.slice(fnStart, fnStart + 9000);

console.log("A. fmtBlock 围栏路由");
ok("A1 fenceLang 声明", web.includes('let fenceLang = ""'));
ok("A2 围栏开行捕获语言", web.includes('fenceLang = ((line.match(/^\\s*```([A-Za-z0-9_-]*)/) ?? [])[1] ?? "").toLowerCase()'));
ok("A3 chart 分支先于思维导图分支", web.indexOf('lang === "chart"') > -1 && web.indexOf('lang === "chart"') < web.indexOf("looksLikeTree", web.indexOf('lang === "chart"')));
ok("A4 坏 JSON 回退（chart 为 null 时不 push）", /if \(chart\) \{ out\.push\(chart\); return \}/.test(web));

console.log("B. renderChartBlock 渲染器");
ok("B1 函数存在", fnStart > -1);
ok("B2 JSON.parse 容错", /JSON\.parse/.test(fnBody) && /catch/.test(fnBody));
ok("B3 style 白名单 line/bar/scatter", /line|bar|scatter/.test(fnBody));
ok("B4 系列上限 12", /slice\(0,\s*12\)/.test(fnBody));
ok("B5 每系列点数上限 2000", /slice\(0,\s*2000\)/.test(fnBody));
ok("B6 柱状图 y 轴含 0 起点", /Math\.min\(0,\s*ymin\)/.test(fnBody));
ok("B7 hex 色校验", /\^#\[0-9a-fA-F\]\{3,8\}\$/.test(fnBody));
ok("B8 viewBox 尺寸模板", /viewBox="0 0 \$\{W\} \$\{H\}"/.test(fnBody) && /const W = 660/.test(fnBody));
ok("B9 图例（多系列有命名才画）", /const named = series\.filter\(\(s\) => s\.name\)/.test(fnBody) && /named\.length > 1/.test(fnBody));
ok("B10 输出 chartbox 容器", web.includes('<div class="chartbox">'));
ok("B11 无有效数据 return null", /return null/.test(fnBody));

console.log("C. CSS");
ok("C1 .chartbox 样式", web.includes(".chartbox { background: var(--panel2)"));
ok("C2 svg 自适应宽度", web.includes(".chartbox svg { display: block; width: 100%"));

console.log("D. 提示词");
ok("D1 提示词提到 chart 围栏", /chart/.test(prompt));
ok("D2 围栏信息行写法说明", /围栏/.test(prompt) && /chart/.test(prompt));
ok("D3 不编造数据", /编造/.test(prompt));
ok("D4 超出形态走 HTML 文件", /HTML 文件/.test(prompt));
ok("D5 style 三形态说明", /line|bar|scatter/.test(prompt));
ok("D6 series 结构说明", /series/.test(prompt));
ok("D7 模板串仅首尾定界反引号（内容无裸反引号）", (prompt.match(/`/g) || []).length === 6); // T91 起为 3 个模板串：SYSTEM_PROMPT + SCOPE_NOTE + COMPACT_BASE
ok("D8 模板串无插值残留", !/\$\{/.test(prompt));

console.log("E. svg 围栏协议（10.33：模型手写 SVG 净化直通）");
const sanStart = web.indexOf("function sanitizeSvg(src)");
const sanBody = web.slice(sanStart, sanStart + 3000);
ok("E1 路由器有 svg 分支", web.includes('if (lang === "svg")'));
ok("E2 svg 分支与 chart 同址（都在思维导图兜底之前）", web.indexOf('lang === "svg"') > -1 && web.indexOf('lang === "svg"') < web.indexOf('lang === "chart"') + 400);
ok("E3 净化失败降级（svg 为 null 时不 push，落代码块）", /if \(svg\) \{ out\.push\(svg\); return \}/.test(web));
ok("E4 sanitizeSvg 存在", sanStart > -1);
ok("E5 可执行/可外载元素整体剥（script/foreignObject/style）", /script\|foreignObject\|style/.test(sanBody));
ok("E6 on* 事件属性三种引号形态都剥（按源码片段匹配，避开多层转义地狱）",
  sanBody.includes('\\s*=\\s*"[^"]*"') && sanBody.includes("\\s*=\\s*'[^']*'") && sanBody.includes("[^\\s>]+"));
ok("E7 href 只允许 # 片段", sanBody.includes("(?:xlink:)?href") && /startsWith\("#"\)/.test(sanBody));
ok("E8 危险 scheme 与实体编码属性值删除", /javascript\|vbscript/.test(sanBody) && /&#/.test(sanBody));
ok("E9 renderSvgBlock 输出 svgbox 容器", /function renderSvgBlock/.test(web) && web.includes('<div class="svgbox">'));
ok("E10 .svgbox CSS（含溢出兜底）", web.includes(".svgbox { background: var(--panel2)") && web.includes(".svgbox svg { display: block; width: 100%"));
ok("E11 提示词登记 svg 围栏（第 3.5 步）", /第 3\.5 步/.test(prompt) && /svg/.test(prompt));
ok("E12 提示词写清硬约束（script/事件/外链会被剥）", /script/.test(prompt) && /事件属性/.test(prompt) && /# 片段/.test(prompt));
ok("E13 提示词教主题适配（CSS 变量，不写死色值）", /var\(--panel\)/.test(prompt) && /var\(--text\)/.test(prompt) && /CSS 变量/.test(prompt));
console.log("F. 第二道闸：解析后 DOM 清场（10.34）");
const hardenCalls = (web.match(/hardenSvgBoxes\(/g) || []).length;
ok("F1 hardenSvgBoxes 定义 + 三处调用（主渲染/流式/辅助对话）", hardenCalls >= 4, `共 ${hardenCalls} 处`);
ok("F2 策略是纯函数（node 可测）：svgElForbidden/svgAttrForbidden", /function svgElForbidden/.test(web) && /function svgAttrForbidden/.test(web));
ok("F3 流式收口点已接（最热的路径，围栏在流式中闭合）", /el\.innerHTML = fmtBlock\(streamBuf\); hardenSvgBoxes\(el\)/.test(web));
ok("F4 主渲染收口点已接", /hardenSvgBoxes\(box\)/.test(web));
ok("F5 清场作用域限定 .svgbox（不碰其他围栏产物）", /\.svgbox */.test(web));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
