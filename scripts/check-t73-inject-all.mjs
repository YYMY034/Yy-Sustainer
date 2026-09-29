// T73 断言：主提示词全路径注入 + 三层不污染机制（作用域声明 / 统一拼接入口 / 解析侧容错）
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const ok = (n, v) => { if (v) { pass++; console.log("OK   " + n) } else { fail++; console.log("FAIL " + n) } };
const R = (p) => readFileSync(p, "utf8");
const prompt = R("src/agent/prompt.ts");
const loop = R("src/agent/loop.ts");
const hooks = R("src/agent/hooks.ts");
// T93 L1：判定逻辑搬到 hookJudge.ts，断言要跟着去那个文件
const judge = R("src/agent/hookJudge.ts");
const vision = R("src/agent/vision.ts");
const gateway = R("src/gateway.ts");

console.log("A. 统一拼接入口（prompt.ts）");
ok("A1 导出 SCOPE_NOTE", /export const SCOPE_NOTE = `/.test(prompt));
ok("A2 导出 composeSystem", prompt.includes("export function composeSystem"));
// T91：首层由「恒 SYSTEM_PROMPT」变成「完整层 / 精简层二选一」，但拼接顺序链本身不变
ok("A3 composeSystem 顺序：基础层→注入→技能→[声明+角色]→后缀", /const layers: string\[\] = \[[\s\S]*?\]\s*if \(p\.injection\)[\s\S]*?if \(p\.skills\)[\s\S]*?if \(p\.role\) \{\s*layers\.push\(SCOPE_NOTE\)[\s\S]*?if \(p\.suffix\)/.test(prompt));
ok("A4 作用域声明含「输出以专用指令为准」", prompt.includes("以紧随其后的专用指令为准"));
ok("A5 作用域声明含裸 JSON 要求", prompt.includes("第一个字符就是左花括号"));
// T91：精简层只对「显式传 compactBase 的内部单一职责调用」生效（压缩/钩子/识图/拆分），
// 主对话路径**默认分支仍是 SYSTEM_PROMPT**，且 fullBaseForInternal:true 可整体回退。
// 这条盯的就是「默认必须是完整层」——别让精简层悄悄变成主路径。
ok(
  "A6 主提示词默认完整层（仅内部调用显式 compactBase 才精简，且可配置回退）",
  prompt.includes("p.compactBase && !fullBaseForInternal() ? COMPACT_BASE : SYSTEM_PROMPT") &&
    prompt.includes("fullBaseForInternal === true"),
);

console.log("B. 四处调用点全部接入");
// T91：调用点变成多行，且 skills 按 compactBase 决定是否注入（精简层不带技能文档）
ok("B1 loop.ts prepare 用 composeSystem（role=opts.system）", /const system = composeSystem\(\{[\s\S]{0,200}?injection,[\s\S]{0,200}?role: opts\.system,[\s\S]{0,200}?suffix: opts\.systemSuffix,/.test(loop));
ok("B2 loop.ts 已无 SYSTEM_PROMPT 直接引用（统一走 composeSystem）", !/import \{ SYSTEM_PROMPT \}/.test(loop));
ok("B3 basePrompt 逃生口已移除（全路径无例外）", !loop.includes("basePrompt") && !gateway.includes("basePrompt"));
// T91：四个内部调用点都显式带上 compactBase: true（它们是「不看用户对话、不碰工具、只做单一判定」的场景）。
// 「注入基础层」这件事本身没变——变的只是注入哪一层。
ok("B4 拆分器注入基础层（system 仍是只输出 JSON 的角色指令）", /disableInjection: true,[\s\S]{0,80}?system: "你是任务拆分器/.test(gateway));
ok("B5 compactHistory 注入（role=历史压缩器，T91 走精简层）", /system: composeSystem\(\{\s*compactBase: true,\s*role: "你是历史压缩器/.test(loop));
ok("B6 hooks.ts 注入（role=钩子检查器，T91 走精简层）", /system: composeSystem\(\{\s*compactBase: true,\s*role:\s*"你是钩子检查器/.test(judge));
ok("B7 vision.ts 注入（role=图像转述器，T91 走精简层）", /system: composeSystem\(\{\s*compactBase: true,\s*role: "你是图像转述器/.test(vision));

console.log("C. 解析侧容错（防污染工程兜底）");
// T93 L1：改为按 hookId 精确匹配 + 行首锚定（name 子串匹配会串台）
ok("C1 钩子判定按 hookId 精确匹配且行首锚定", /const hook = byId\.get\(id\)/.test(judge) && /\^\(/.test(judge));
ok("C2 钩子判定先剥 thinking 块（内聚在解析器里，任何后端都受益）", /replace\(\/<\(thinking\|think\)>/.test(judge));
ok("C3 拆分器解析保留「剥 thinking + 取最后 JSON 块」", gateway.includes("clean.match(/\\{[\\s\\S]*\\}(?!\\s*\\{)/g)"));
ok("C4 钩子失败仍 fail-open（catch 原样返回）", hooks.includes("return output"));

console.log("D. 模板串约束");
// T91 新增 COMPACT_BASE 模板串 → 反引号从 4 个变 6 个（SYSTEM_PROMPT / SCOPE_NOTE / COMPACT_BASE 各两个）
ok("D1 prompt.ts 反引号仅 6 个（三个模板串定界）", (prompt.match(/`/g) || []).length === 6);
ok("D2 prompt.ts 无插值残留", !/\$\{/.test(prompt));
ok("D3 SCOPE_NOTE 内无三连反引号", !/```/.test(prompt));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
