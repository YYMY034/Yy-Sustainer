// T68 断言：导轨显隐切换瞬间免过渡落位（修「收侧栏后导轨先偏上、再滑回中间」）
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const ok = (n, v) => { if (v) { pass++; console.log("OK   " + n) } else { fail++; console.log("FAIL " + n) } };
const html = readFileSync("web/index.html", "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

console.log("A. syncRailOffsetInstant 本体");
ok("A1 函数存在", script.includes("function syncRailOffsetInstant()"));
ok("A2 show 检查", /function syncRailOffsetInstant\(\) \{\s*const rail = \$\("qaRail"\)\s*if \(!rail \|\| !rail\.classList\.contains\("show"\)\) return/.test(script));
ok("A3 display:none 早退（CSS 判定隐藏时不同步）", script.includes('if (getComputedStyle(rail).display === "none") return'));
ok("A4 免过渡设 transform", script.includes('rail.style.transition = "none"'));
ok("A5 强制 reflow", script.includes("void rail.offsetWidth"));
ok("A6 恢复过渡", /void rail\.offsetWidth[^\n]*\n\s*rail\.style\.transition = ""/.test(script));

console.log("B. 显隐切换点全部接入（4 处类切换 + 1 处重建）");
const calls = (script.match(/syncRailOffsetInstant\(\)/g) || []).length;
ok("B1 调用匹配共 7 次（1 定义 + 6 调用点）", calls === 7);
ok("B2 collapseSidebar 末尾", /localStorage\.setItem\("yyagent-side", "collapsed"\)\n\s*syncRailOffsetInstant\(\)/.test(script));
ok("B3 expandSidebar 末尾", /localStorage\.setItem\("yyagent-side", "open"\)\n\s*syncRailOffsetInstant\(\)/.test(script));
ok("B4 openAssist 末尾", /\$\("assistInput"\)\.focus\(\)\n\s*syncRailOffsetInstant\(\)/.test(script));
ok("B5 closeAssist 末尾", /\$\("assistBtn"\)\.classList\.remove\("active"\)\n\s*syncRailOffsetInstant\(\)/.test(script));
ok("B6 applyRailMode 末尾（设置变更+启动恢复）", /b\.dataset\.v === mode\)\)\n\s*syncRailOffsetInstant\(\)/.test(script));
ok("B7 renderQaRail 末尾改用免过渡版", /paintQaRipple\(rail\) \/\/ 整条导轨离开：清掉残留波纹\s*\}\n\s*\/\/ T68：重建即免过渡定位[^\n]*\n\s*syncRailOffsetInstant\(\)/.test(script));

console.log("C. 回归保护");
ok("C1 滚动跟随仍走普通过渡（updateQaRailOffset 未改 transform 语义）", script.includes('rail.style.transform = offset ? `translateY(${offset}px)` : ""'));
ok("C2 过渡仍为 .18s（CSS 未动）", /#qaRail \{[^}]*transition: transform \.18s ease-out/.test(html));

console.log("D. 语法配平");
const bo = (script.match(/\{/g) || []).length, bc = (script.match(/\}/g) || []).length;
ok("D1 花括号配平", bo === bc);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
