/**
 * 系统托盘接线守卫（关窗不退出，托盘右键才真退）。
 *
 *  为什么用静态断言：Electron 壳（electron/main.cjs）在沙箱里没法真跑 GUI，
 *  而托盘的坑全是「接线」型——preventDefault 漏写、quitting 标志设晚一步、
 *  app.quit() 留在 window-all-closed 里。这些错法语法全对、跑起来也不报错，
 *  只是行为不符合预期。所以钉住形状，并用造错验证过每根钉子有牙。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const main = readFileSync(fileURLToPath(new URL("../electron/main.cjs", import.meta.url)), "utf8")

test("Tray/Menu/nativeImage 从 electron 导入", () => {
  assert.match(main, /const \{ app, BrowserWindow, shell, dialog, ipcMain, Tray, Menu, nativeImage \} = require\("electron"\)/)
})

test("close 拦截：preventDefault + hide，页面 × 与系统关闭两条路径都变「藏起来」", () => {
  assert.match(main, /win\.on\("close", \(e\) => \{/, "没有拦截 close——点 × 就是真退出")
  assert.match(main, /e\.preventDefault\(\)/, "没 preventDefault——拦不住关窗")
  assert.match(main, /win\.hide\(\)/, "没有 hide——藏都没处藏")
})

test("quitting 标志是唯一放行口，且在 preventDefault 之前判", () => {
  assert.match(main, /let quitting = false/, "没有 quitting 标志")
  // 只在 close 处理器的作用域里比顺序（F12 处理器里也有 e.preventDefault()，全局 indexOf 会指错）
  const closeAt = main.indexOf('win.on("close"')
  assert.ok(closeAt > 0, "没有 close 处理器")
  const closeBody = main.slice(closeAt, main.indexOf("\n  })", closeAt))
  const guard = closeBody.indexOf("if (quitting) return")
  const prevent = closeBody.indexOf("e.preventDefault()")
  assert.ok(guard > 0 && prevent > guard, "quitting 判定必须排在 preventDefault 之前——反了则 app.quit() 会被自己的 close 拦下")
})

test("托盘「退出」：先设 quitting 再 app.quit()（顺序反了退不掉）", () => {
  assert.match(main, /\{ quitting = true; app\.quit\(\) \}/, "退出菜单没有「设标志再 quit」的完整写法")
})

test("window-all-closed 不再 quit（窗口全关也继续在托盘跑）", () => {
  const start = main.indexOf('app.on("window-all-closed"')
  assert.ok(start > 0, "没有 window-all-closed 处理器")
  const body = main.slice(start, main.indexOf("\n})", start))
  const code = body.replace(/\/\/[^\n]*/g, "") // 剥行注释——注释里提 app.quit 不算真调用
  assert.ok(!code.includes("app.quit()"), "window-all-closed 里还有 app.quit()——全关即退出，托盘白做")
})

test("托盘菜单含「显示主窗口」与「退出」两项 + 单击唤窗", () => {
  assert.match(main, /\{ label: "显示主窗口", click: \(\) => showWindow\(\) \}/)
  assert.match(main, /\{ label: "退出", click: \(\) => \{ quitting = true; app\.quit\(\) \} \}/)
  assert.match(main, /tray\.on\("click", \(\) => showWindow\(\)\)/, "左键单击没接唤窗——藏起来后只能右键")
})

test("showWindow：最小化先 restore，再 show + focus；窗口没了就重建", () => {
  assert.match(main, /if \(!win\) \{ createWindow\(\); return \}/, "窗口被销毁后点托盘没有重建路径")
  assert.match(main, /if \(win\.isMinimized\(\)\) win\.restore\(\)/, "最小化状态直接 show 不会还原")
  assert.match(main, /win\.show\(\)\s*\n\s*win\.focus\(\)/, "没有 focus——唤出后在后台")
})

test("托盘与窗口同生（关窗后有落脚点）", () => {
  const cw = main.indexOf("createWindow()\n  createTray()")
  assert.ok(cw > 0, "createTray 没有紧随 createWindow——窗口创建失败/被销毁时托盘不一定在")
})

test("before-quit：杀引擎 + 销毁托盘", () => {
  assert.match(main, /tray\.destroy\(\)/, "退出没销毁托盘——个别平台留鬼影")
  assert.match(main, /engine\.kill\(\)/, "退出没杀引擎——后台进程永驻")
})

test("图标多路径兜底（开发态/发行态/都没有），不能因缺图标起不来", () => {
  assert.match(main, /path\.join\(ROOT, "yyagent\.ico"\)/, "缺开发态候选")
  assert.match(main, /path\.join\(ENGINE_ROOT, "web", "yyagent\.ico"\)/, "缺发行态候选")
  assert.match(main, /nativeImage\.createFromDataURL\(/, "缺兜底图标——发行版 resources 缺 ico 时托盘起不来")
})

test("藏托盘时静默：close 处理器里不弹任何通知（用户明确要求）", () => {
  const closeAt = main.indexOf('win.on("close"')
  assert.ok(closeAt > 0, "没有 close 处理器")
  const closeBody = main.slice(closeAt, main.indexOf("\n  })", closeAt))
  assert.ok(!closeBody.includes("displayBalloon"), "藏托盘时弹了通知——用户要求静默")
  assert.ok(!main.includes("trayBalloonShown"), "气球一次性标志还在——通知代码没删干净")
})
