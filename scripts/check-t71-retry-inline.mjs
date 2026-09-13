// T71 断言：API 出错重发提示从输入框上方 banner 移进输出区流式状态行
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const ok = (n, v) => { if (v) { pass++; console.log("OK   " + n) } else { fail++; console.log("FAIL " + n) } };
const html = readFileSync("web/index.html", "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const seg = script.slice(script.indexOf('m.type === "retry"'), script.indexOf('m.type === "compacted"'));

console.log("A. retry 处理段");
ok("A1 不再写 banner", !seg.includes('$("banner")'));
ok("A2 不再写顶栏 status（过程状态一律进输出区）", !seg.includes('$("status")'));
ok("A3 写入 streamStatusText", seg.includes("streamStatusText = left > 0 ? `${m.info} · ${left}s 后重试` : m.info"));
ok("A4 ensureStream 兜底建流式气泡", seg.includes("ensureStream()"));
ok("A5 状态行缺席时 render() 补渲染", seg.includes('if (!$("streamStatusText")) render()'));
ok("A6 倒计时原地刷新 paint", seg.includes('const paint = () => { const s = $("streamStatusText"); if (s) s.textContent = streamStatusText }'));
ok("A7 会话过滤保留", seg.includes('if (m.sessionId && m.sessionId !== activeId) return'));

console.log("B. 全局回归");
ok("B1 banner 仍服务于其他错误（下载/导出/撤回等）", (script.match(/\$\("banner"\)\.style\.display = "block"/g) || []).length >= 8);
ok("B2 发送时仍清 banner", /sendMsg|async function send/.test(script) && script.includes('$("banner").style.display = "none"'));
ok("B3 stream-status 渲染模板仍在（render 的流式气泡）", html.includes('<div class="stream-status" id="streamStatus"'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
