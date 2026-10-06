// 主题色 UI probe 的 Electron 入口：无头窗口加载网关页面，注入断言脚本，
// 把结果 JSON 打到 stdout（约定前缀 YY_PROBE_RESULT:）后退出。
const { app, BrowserWindow } = require("electron")
app.commandLine.appendSwitch("disable-gpu")
app.disableHardwareAcceleration()

const URL = process.env.YY_PROBE_URL
if (!URL) { console.error("YY_PROBE_URL not set"); process.exit(2) }

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 800 })
  win.webContents.on("console-message", (_e, _lv, msg) => { if (String(msg).includes("[accent]")) console.log("PAGE:", msg) })
  try {
    await win.loadURL(URL)
  } catch (e) {
    console.error("YY_PROBE_RESULT:", JSON.stringify([["loadURL", false, String(e)]]))
    app.exit(3)
    return
  }
  // 给启动时的 loadUsage/refreshState 一点时间
  await new Promise((r) => setTimeout(r, 1200))
  const script = `(${async function () {
    const out = []
    const $ = (s) => document.querySelector(s)
    const cs = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
    const html = document.documentElement
    const push = (label, ok, extra) => out.push([label, !!ok, extra === undefined ? "" : String(extra).slice(0, 80)])
    // 1 初始态：默认 graphite + 浅色主题 → #1a1a1a（白底黑字）
    push("初始 html.accent-graphite", html.classList.contains("accent-graphite"), [...html.classList].join(","))
    push("初始 --accent=#1a1a1a", cs() === "#1a1a1a", cs())
    push("初始石墨按钮 .on", $('[data-accent="graphite"]')?.classList.contains("on"))
    // 2 点蔚蓝 → 类切换 + 计算值变 + 视觉选中态跟着走
    $('[data-accent="azure"]').click()
    push("点蔚蓝后 html.accent-azure", html.classList.contains("accent-azure"), [...html.classList].filter(c => c.startsWith("accent-")).join(","))
    push("点蔚蓝后 --accent=#2563eb", cs() === "#2563eb", cs())
    push("蔚蓝按钮 .on", $('[data-accent="azure"]')?.classList.contains("on"))
    push("石墨按钮失去 .on", !$('[data-accent="graphite"]')?.classList.contains("on"))
    push("localStorage=azure", localStorage.getItem("yyagent-accent") === "azure", localStorage.getItem("yyagent-accent"))
    // 3 切深色 → azure 深色档 #6b9ff5（CSS 类自动接管，无需 JS 再算）
    $('#segTheme [data-t="dark"]').click()
    await new Promise((r) => setTimeout(r, 80))
    push("深色下 --accent=#6b9ff5", cs() === "#6b9ff5", cs())
    push("深色下保持 accent-azure", html.classList.contains("accent-azure"))
    // 4 用量图：隔离网关正常响应（无数据也返回结构）→ 不该停留在「暂不可用」
    try {
      usageCache = null
      await loadUsage()
      const t = $("#usageCharts").textContent || ""
      push("用量图渲染出内容", !t.includes("暂不可用"), t.trim().slice(0, 60))
    } catch (e) { push("loadUsage 不抛", false, e) }
    // 5 换一个色再切回 graphite：验证互相切换不粘连
    $('[data-accent="amber"]').click()
    push("点暖橙后 --accent=#f0b45c(深色档)", cs() === "#f0b45c", cs())
    $('[data-accent="graphite"]').click()
    push("切回石墨 --accent=#c8cdd3(深色)", cs() === "#c8cdd3", cs())
    // 6 T130 修正四：思考块间距——fmtBlock 对旧格式（带 \n padding 的历史消息）与新格式都不产生块间空白
    const noBlank = (label, src) => {
      const html = fmtBlock(src)
      const blocks = html.split('class="think-block"').length - 1
      push(label + "：两个思考块", blocks === 2, blocks + " blocks")
      // 思考块之间的部分不允许有空行（\n\n）——pre-wrap 下就是真实空白高度
      const between = html.slice(html.indexOf("</div></div>") > -1 ? html.indexOf("</div></div>") : 0)
      push(label + "：块间无空白行", !/\n\s*\n/.test(html.replace(/think-full[\s\S]*?<\/div>/g, "")), JSON.stringify(html.slice(0, 120)))
    }
    noBlank("旧格式带padding", "<thinking>\n思考一\n\n</thinking>\n\n\n<thinking>\n思考二\n</thinking>\n\n正文开始")
    noBlank("极端累积换行", "<thinking>a</thinking>\n\n\n\n\n\n<thinking>b</thinking>")
    // 正文连续空行折叠成一个（单空行分段保留）
    const para = fmtBlock("段落一\n\n\n\n\n段落二")
    push("正文连续空行折叠成一个", (para.match(/\n/g) || []).length === 2, JSON.stringify(para))
    // 新格式（无 padding）正常渲染
    push("新格式正常", (fmtBlock("<thinking>新</thinking>结果").match(/think-block/g) || []).length === 1)
    return JSON.stringify(out)
  }.toString()})()`
  try {
    const res = await win.webContents.executeJavaScript(script, true)
    console.log("YY_PROBE_RESULT:", res)
  } catch (e) {
    console.error("YY_PROBE_RESULT:", JSON.stringify([["executeJavaScript", false, String(e)]]))
  }
  app.exit(0)
})
