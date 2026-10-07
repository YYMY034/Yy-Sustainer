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
  const assertFn = async function () {
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
    // 7 T133：侧栏任务项点击 → 自动化页编辑表单；▶ 按钮 → 原地立即运行
    const cr = await fetch("/api/tasks/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "demo-probe", cron: "0 9 * * *", prompt: "测试任务" }) })
    push("创建测试任务", cr.ok)
    await loadTasks()
    const item = document.querySelector('#taskList .taskitem[data-name="demo-probe"]')
    push("侧栏渲染出任务项", !!item)
    item.querySelector(".trun").style.opacity = "1" // 无头环境无 hover，强制可见以便点击
    try { item.click() } catch (e) { push("item.click 同步异常", false, e && e.stack ? String(e.stack).split("\n").slice(0, 3).join(" | ") : e) }
    const ap = $("#autoPage")
    push("autoPage 节点存在", !!ap, typeof ap)
    push("主点击切到自动化页", !!ap && ap.classList.contains("show"))
    push("表单标题=编辑任务", $("#autoFormTitle").textContent.includes("demo-probe"), $("#autoFormTitle").textContent)
    push("任务名锁定（disabled）", $("#afName").disabled === true)
    push("cron 已填入", $("#afCron").value === "0 9 * * *", $("#afCron").value)
    // 回主界面再点 ▶：验证 stopPropagation（不触发跳编辑）+ 运行请求发出
    showPage(null)
    $("#status").textContent = ""
    item.querySelector(".trun").click()
    await new Promise((r) => setTimeout(r, 400))
    push("▶ 不触发页面跳转", !$("#autoPage").classList.contains("show"))
    push("▶ 触发运行提示", $("#status").textContent.includes("demo-probe"), $("#status").textContent)
    // 8 T134：思考活动行 + 工具图标——pending 行（brain 图标+spinner）→ off 定格时长
    ensureStream()
    upsertThink(true)
    renderActivity()
    let line = document.querySelector("#activity .act-line.pending")
    push("思考 on → pending 活动行", !!line, line ? line.className : "null")
    push("思考行有 brain 图标", !!line?.querySelector(".aico svg"), line ? line.querySelector(".aico").innerHTML.slice(0, 40) : "")
    push("思考行文案=思考", line?.querySelector(".nm")?.textContent === "思考", line?.querySelector(".nm")?.textContent)
    push("pending 行有 spinner", !!line?.querySelector(".spinner"))
    await new Promise((r) => setTimeout(r, 30)) // 让思考行有真实时长
    upsertThink(false)
    renderActivity()
    line = document.querySelector("#activity .act-line.done")
    push("思考 off → done + 时长", !!line && /^\d+(\.\d+)?(ms|s)$/.test(line.querySelector(".ms")?.textContent ?? ""), line?.querySelector(".ms")?.textContent)
    // 工具行图标映射抽查（read → 放大镜）
    upsertStep({ toolCallId: "t1", name: "read", kind: "call", input: { file_path: "a.ts" } }, "call")
    upsertStep({ toolCallId: "t1", kind: "result", output: "ok" }, "result")
    renderActivity()
    const readLine = [...document.querySelectorAll("#activity .act-line.done")].find((l) => l.querySelector(".nm")?.textContent === "已读取")
    push("读取行=放大镜图标", !!readLine?.querySelector(".aico svg"))
    push("时长格式化", fmtDur(4200) === "4.2s" && fmtDur(420) === "420ms" && fmtDur(42000) === "42s", `${fmtDur(4200)}/${fmtDur(420)}/${fmtDur(42000)}`)
    // WS 接线：模拟后端广播 {type:"think"} 走真实 onmessage 分支（sessionId 用当前会话）
    window.__steps = []
    const fakeMsg = (obj) => ws.onmessage({ data: JSON.stringify(obj) })
    fakeMsg({ type: "think", sessionId: activeId, on: true })
    push("ws think on → 活动行", !!document.querySelector("#activity .act-line.pending"))
    fakeMsg({ type: "think", sessionId: activeId, on: false })
    push("ws think off → 定格", !!document.querySelector("#activity .act-line.done"))
    // 别的会话的 think 事件不应渲染到当前活动流
    window.__steps = []
    fakeMsg({ type: "think", sessionId: "other-session", on: true })
    push("异会话 think 不串场", !document.querySelector("#activity .act-line.pending"))
    // 9 T135：成果分享三函数——absPathFor 绝对直通/相对拼 cwd、shareUrlFor 带 token 与路径
    push("absPathFor 绝对路径直通", absPathFor("C:\\work\\a.html") === "C:\\work\\a.html")
    push("absPathFor UNC 直通", absPathFor("\\\\srv\\share\\a.html").startsWith("\\\\srv"))
    const testCwd = "C:\\proj\\demo"
    sessions.push({ id: "probe-sess", cwd: testCwd })
    activeId = "probe-sess"
    push("absPathFor 相对路径拼 cwd", absPathFor("out/a.html") === "C:\\proj\\demo/out/a.html", absPathFor("out/a.html"))
    const su = await shareUrlFor("out/a.html")
    push("shareUrlFor 形态", su.startsWith(location.origin + "/api/file?p=") && su.includes("out%2Fa.html"), su)
    push("无 cwd 时相对路径原样返回", (sessions.find((s) => s.id === activeId).cwd = "", absPathFor("b.html") === "b.html"))
    sessions.pop()
    activeId = null
    return JSON.stringify(out)
  }
  const script = `(async () => { try { return await (${assertFn.toString()})() } catch (e) { return JSON.stringify([["脚本异常", false, e && e.stack ? String(e.stack).split("\\n").slice(0, 4).join(" | ") : String(e)]]) } })()`
  try {
    const res = await win.webContents.executeJavaScript(script, true)
    console.log("YY_PROBE_RESULT:", res)
  } catch (e) {
    console.error("YY_PROBE_RESULT:", JSON.stringify([["executeJavaScript", false, String(e)]]))
  }
  app.exit(0)
})
