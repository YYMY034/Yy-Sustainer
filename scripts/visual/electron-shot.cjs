/**
 * T96：Electron 截图 runner（无头，offscreen 渲染）。
 *
 *   npx electron scripts/visual/electron-shot.cjs --base=http://127.0.0.1:PORT --out=DIR --json=FILE [--views=main,settings]
 *
 * 为什么用 Electron 而不是 playwright：本机没有 playwright/无头浏览器（check-t43 实录），
 * 但仓库 devDependencies 里本来就有 Electron 44——零新依赖。无 GPU 环境三开关
 * （disable-gpu / disable-gpu-compositing / no-sandbox，坑 #2）一个不少。
 *
 * 布局快照产出：整页 PNG（截图给人工/识图判定用）+ 几何快照 JSON
 * （横向溢出 / composer 出界 / #messages 存在 / 页面错误）。
 * 注意：**只开一个窗口**，settings 视图靠点 #settingsBtn 切过去——
 * offscreen 窗口销毁后第二个窗口 loadURL 会 ERR_FAILED(-2)，别开两个。
 */
const { app, BrowserWindow } = require("electron")
const fs = require("fs")
const path = require("path")

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const BASE = arg("base", "http://127.0.0.1:8642")
const OUT = arg("out", "logs/visual")
const JSON_OUT = arg("json", path.join(OUT, "results.json"))
const VIEWS = (arg("views", "main,settings")).split(",").map((s) => s.trim()).filter(Boolean)

app.disableHardwareAcceleration()
app.commandLine.appendSwitch("disable-gpu")
app.commandLine.appendSwitch("disable-gpu-compositing")
app.commandLine.appendSwitch("no-sandbox")

const GEOMETRY_JS = `JSON.stringify((function(){
  var composer = document.querySelector('#composer')
  var msgs = document.querySelector('#messages')
  var cr = composer ? composer.getBoundingClientRect() : null
  return {
    title: document.title,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    composerBottom: cr ? Math.round(cr.bottom) : null,
    composerVisible: cr ? (cr.height > 20 && cr.bottom <= window.innerHeight + 1 && cr.top < window.innerHeight) : false,
    hasMessages: !!msgs,
    settingsShown: document.querySelector('#setPage') ? document.querySelector('#setPage').classList.contains('show') : false,
    isLight: document.documentElement.classList.contains('light'),
    pageErrors: (window.__pageErrors || []).slice(0, 10)
  }
})())`

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const results = []
  let win
  try {
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      webPreferences: { offscreen: true, preload: path.join(__dirname, "visual-preload.cjs") },
    })
    await win.loadURL(BASE + "/")
    await new Promise((r) => setTimeout(r, 1800))
    for (const view of VIEWS) {
      if (view === "settings") {
        // 从主视图导航过去（当前只支持 settings；未知视图按 settings 兜底处理会误导，直接记错）
        const clicked = await win.webContents.executeJavaScript(
          `(function(){ var b = document.querySelector('#settingsBtn'); if (b) b.click(); return !!b })()`,
        )
        if (!clicked) { results.push({ view, error: "找不到 #settingsBtn" }); continue }
        await new Promise((r) => setTimeout(r, 1000))
      } else if (view === "main-dark") {
        // T107：暗色主题视图——先回主视图（设置页开着时点返回），再点主题切换
        const back = await win.webContents.executeJavaScript(
          `(function(){ var s = document.querySelector('#setPage'); if (s && s.classList.contains('show')) { var b = document.querySelector('#setBack'); if (b) b.click(); return 'back' } return 'main' })()`,
        )
        if (back !== "main") await new Promise((r) => setTimeout(r, 800))
        const toggled = await win.webContents.executeJavaScript(
          `(function(){ var b = document.querySelector('#themeBtn'); if (b) b.click(); return !!b })()`,
        )
        if (!toggled) { results.push({ view, error: "找不到 #themeBtn" }); continue }
        await new Promise((r) => setTimeout(r, 900))
      }
      const geoRaw = await win.webContents.executeJavaScript(GEOMETRY_JS)
      const img = await win.webContents.capturePage()
      const file = path.join(OUT, `web-${view}.png`)
      fs.writeFileSync(file, img.toPNG())
      results.push({ view, file, geo: JSON.parse(geoRaw) })
    }
  } catch (e) {
    results.push({ view: "fatal", error: String((e && e.message) || e) })
  } finally {
    try { if (win) win.destroy() } catch { /* 已销毁 */ }
    fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2))
    app.exit(0)
  }
})
