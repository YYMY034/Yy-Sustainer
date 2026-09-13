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
ok("D7 模板串仅首尾定界反引号（内容无裸反引号）", (prompt.match(/`/g) || []).length === 4); // T73 起为 2 个模板串：SYSTEM_PROMPT + SCOPE_NOTE
ok("D8 模板串无插值残留", !/\$\{/.test(prompt));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
