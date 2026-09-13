// T73 断言：主提示词全路径注入 + 三层不污染机制（作用域声明 / 统一拼接入口 / 解析侧容错）
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const ok = (n, v) => { if (v) { pass++; console.log("OK   " + n) } else { fail++; console.log("FAIL " + n) } };
const R = (p) => readFileSync(p, "utf8");
const prompt = R("src/agent/prompt.ts");
const loop = R("src/agent/loop.ts");
const hooks = R("src/agent/hooks.ts");
const vision = R("src/agent/vision.ts");
const gateway = R("src/gateway.ts");

console.log("A. 统一拼接入口（prompt.ts）");
ok("A1 导出 SCOPE_NOTE", /export const SCOPE_NOTE = `/.test(prompt));
ok("A2 导出 composeSystem", prompt.includes("export function composeSystem"));
ok("A3 composeSystem 顺序：基础层→注入→技能→[声明+角色]→后缀", /const layers: string\[\] = \[SYSTEM_PROMPT\][\s\S]*?if \(p\.injection\)[\s\S]*?if \(p\.skills\)[\s\S]*?if \(p\.role\) \{\s*layers\.push\(SCOPE_NOTE\)[\s\S]*?if \(p\.suffix\)/.test(prompt));
ok("A4 作用域声明含「输出以专用指令为准」", prompt.includes("以紧随其后的专用指令为准"));
ok("A5 作用域声明含裸 JSON 要求", prompt.includes("第一个字符就是左花括号"));
ok("A6 主提示词无关闭开关（composeSystem 首层恒为 SYSTEM_PROMPT）", prompt.includes("const layers: string[] = [SYSTEM_PROMPT]"));

console.log("B. 四处调用点全部接入");
ok("B1 loop.ts prepare 用 composeSystem（role=opts.system）", /const system = composeSystem\(\{ injection, skills: skillsPrompt\(\), role: opts\.system, suffix: opts\.systemSuffix \}\)/.test(loop));
ok("B2 loop.ts 已无 SYSTEM_PROMPT 直接引用（统一走 composeSystem）", !/import \{ SYSTEM_PROMPT \}/.test(loop));
ok("B3 basePrompt 逃生口已移除（全路径无例外）", !loop.includes("basePrompt") && !gateway.includes("basePrompt"));
ok("B4 拆分器注入基础层（system 仍是只输出 JSON 的角色指令）", /disableInjection: true, system: "你是任务拆分器/.test(gateway));
ok("B5 compactHistory 注入（role=历史压缩器）", /system: composeSystem\(\{\s*role: "你是历史压缩器/.test(loop));
ok("B6 hooks.ts 注入（role=钩子检查器）", /system: composeSystem\(\{\s*role: "你是钩子检查器/.test(hooks));
ok("B7 vision.ts 注入（role=图像转述器）", /system: composeSystem\(\{\s*role: "你是图像转述器/.test(vision));

console.log("C. 解析侧容错（防污染工程兜底）");
ok("C1 钩子判定改为关键字查找（不再要求行首 FAIL）", /txt\.match\(\/FAIL\[:：\]\?/.test(hooks) && !/\^FAIL/.test(hooks));
ok("C2 钩子判定先剥 thinking 块", /replace\(\/<\(thinking\|think\)>/.test(hooks));
ok("C3 拆分器解析保留「剥 thinking + 取最后 JSON 块」", gateway.includes("clean.match(/\\{[\\s\\S]*\\}(?!\\s*\\{)/g)"));
ok("C4 钩子失败仍 fail-open（catch 原样返回）", hooks.includes("return output"));

console.log("D. 模板串约束");
ok("D1 prompt.ts 反引号仅 4 个（两个模板串定界）", (prompt.match(/`/g) || []).length === 4);
ok("D2 prompt.ts 无插值残留", !/\$\{/.test(prompt));
ok("D3 SCOPE_NOTE 内无三连反引号", !/```/.test(prompt));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
