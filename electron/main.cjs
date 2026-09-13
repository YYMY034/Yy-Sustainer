// Yy Sustainer Electron 壳：只负责拉起引擎网关子进程 + 开窗口。引擎逻辑零改动。
//
// 发行版（打包后）与开发态走**两条不同的启动路径**：
//  · 开发态：系统 node + node_modules/tsx 直接解释 src/gateway.ts（热改即生效，方便调试）
//  · 发行版：Electron 自带的 Node（ELECTRON_RUN_AS_NODE=1）执行 dist/gateway.mjs 单文件包
//    —— 用户机器上**不需要安装 Node**，也不需要 node_modules
//
// 发行版为什么用 resources/ 而不是 asar：
//  ① ELECTRON_RUN_AS_NODE 模式下没有 asar 补丁，asar 里的文件读不到；
//  ② 网关是按请求现读 web/index.html 的（静态文件热更新），必须以真实文件存在；
//  ③ 引擎还会用 __dirname 派生 web/、scripts/toast.ps1、yyagentd.config.json —— 都在 resources/ 同级。
//  所以 dist/ web/ scripts/ yyagentd.config.json 走 extraResources（见 electron-builder.yml）。
const { app, BrowserWindow, shell, dialog, ipcMain } = require("electron")
const { spawn } = require("node:child_process")
const http = require("node:http")
const net = require("node:net")
const path = require("node:path")
const fs = require("node:fs")
const os = require("node:os")

// 某些环境（远程/虚拟桌面/沙盒）无可用 GPU，禁用硬件加速避免崩溃
app.commandLine.appendSwitch("disable-gpu")
app.commandLine.appendSwitch("disable-gpu-compositing")
app.commandLine.appendSwitch("no-sandbox")
app.disableHardwareAcceleration()

const HOST = "127.0.0.1"
const DEFAULT_PORT = Number(process.env.YYAGENT_GATEWAY_PORT || 8642)
const ROOT = path.join(__dirname, "..")
const IS_PACKAGED = app.isPackaged
// 发行版里 resources/ 就是引擎的"项目根"（dist 与 web 是兄弟目录，与开发态的 src/web 同构）
const ENGINE_ROOT = IS_PACKAGED ? process.resourcesPath : ROOT

let engine = null
let win = null
let PORT = DEFAULT_PORT

// 引擎日志落盘：GUI 程序在 Windows 上没有控制台，stdio inherit 的输出会直接消失，
// 出问题时用户无从反馈。统一写到 ~/.yyagent/logs/engine.log（与网关自身的 logs 同处）。
function engineLogPath() {
  const dir = path.join(os.homedir(), ".yyagent", "logs")
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
  return path.join(dir, "engine.log")
}

// 端口占用处理：默认 8642 可能被上一份没退干净的实例（或别的程序）占着。
// 不处理的话 waitForEngine 会 probe 到**别人的**服务并误判启动成功，窗口连上去行为诡异。
function findFreePort(start, triesLeft = 20) {
  return new Promise((resolve) => {
    if (triesLeft <= 0) return resolve(start)
    const srv = net.createServer()
    srv.once("error", () => resolve(findFreePort(start + 1, triesLeft - 1)))
    srv.once("listening", () => srv.close(() => resolve(start)))
    srv.listen(start, HOST)
  })
}

function startEngine(port) {
  const env = { ...process.env, YYAGENT_GATEWAY_PORT: String(port) }
  let cmd
  let args
  if (IS_PACKAGED) {
    // ★ 发行版：用 Electron 自带的 Node 执行单文件引擎，用户无需安装 Node
    cmd = process.execPath
    args = [path.join(ENGINE_ROOT, "dist", "gateway.mjs")]
    env.ELECTRON_RUN_AS_NODE = "1"
  } else {
    // 开发态：系统 node + tsx 解释 TS 源码
    cmd = process.env.npm_node_execpath || "node"
    args = [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(ROOT, "src", "gateway.ts")]
  }
  // 工作目录 = agent 的默认工作区。发行版里安装目录不可当工作区（Program Files 只读、
  // 且用户根本不会去那儿找文件），退到用户主目录；界面里还能再手动选文件夹。
  const cwd = IS_PACKAGED ? app.getPath("home") : ROOT

  let logStream = null
  try { logStream = fs.createWriteStream(engineLogPath(), { flags: "a" }) } catch { /* 忽略 */ }

  engine = spawn(cmd, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  if (logStream) {
    const stamp = `\n===== 引擎启动 ${new Date().toISOString()}  cmd=${cmd}  port=${port} =====\n`
    logStream.write(stamp)
    engine.stdout?.pipe(logStream, { end: false })
    engine.stderr?.pipe(logStream, { end: false })
  } else {
    engine.stdout?.on("data", (d) => process.stdout.write(d))
    engine.stderr?.on("data", (d) => process.stderr.write(d))
  }
  engine.on("exit", (code) => {
    console.log(`[yyagent-electron] engine exited (${code})`)
    engine = null
  })
}

function waitForEngine(port, retries = 60, delayMs = 500) {
  return new Promise((resolve, reject) => {
    const probe = (n) => {
      const req = http.get({ host: HOST, port, path: "/api/state", timeout: 1500 }, (res) => {
        res.resume()
        if (res.statusCode === 200) return resolve()
        retry(n)
      })
      req.on("error", () => retry(n))
      req.on("timeout", () => { req.destroy(); retry(n) })
    }
    const retry = (n) => {
      if (n <= 0) return reject(new Error("引擎启动超时"))
      setTimeout(() => probe(n - 1), delayMs)
    }
    probe(retries)
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "Yy Sustainer",
    backgroundColor: "#14161a", // 页面加载后由主题（localStorage yyagent-theme）接管
    autoHideMenuBar: true,
    frame: false, // 无边框：标题栏由页面自绘（左侧展开按钮 + 拖拽区 + 最小化/关闭）
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  })
  // 页面里所有外链交给系统浏览器，不在窗口内跳走
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://${HOST}:${PORT}`)) return { action: "allow" }
    shell.openExternal(url)
    return { action: "deny" }
  })
  win.loadURL(`http://${HOST}:${PORT}`)
  // T69/T70：F12 / Ctrl+Shift+I 调出 DevTools，底部停靠（与 Chrome F12 一致），再按一次关闭。
  // frame:false 无菜单栏且 autoHideMenuBar，快捷键是 DevTools 唯一入口；浏览器直开
  // http://127.0.0.1:8642 的场景用浏览器自带 F12，无需此监听。
  // T70 关键：DevTools 打开后焦点在其自己的 webContents 里，主窗口的 before-input-event
  // 收不到按键——必须给 devToolsWebContents 也挂同一监听才能「再按 F12 关闭」。
  // devToolsWebContents 会被 Electron 复用，用标志位防重复挂载（叠挂会 toggle 两次=没按）。
  const toggleDevTools = (e, input) => {
    if (input.type !== "keyDown") return
    const k = (input.key || "").toLowerCase()
    const isF12 = k === "f12"
    const isCtrlShiftI = input.control && input.shift && k === "i"
    if (!isF12 && !isCtrlShiftI) return
    e.preventDefault()
    if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools()
    else win.webContents.openDevTools({ mode: "bottom" })
  }
  const bindToggle = (wc) => {
    if (!wc || wc.__f12Hooked) return
    wc.__f12Hooked = true
    wc.on("before-input-event", toggleDevTools)
  }
  bindToggle(win.webContents)
  win.webContents.on("devtools-opened", () => bindToggle(win.webContents.devToolsWebContents))
}

app.whenReady().then(async () => {
  PORT = await findFreePort(DEFAULT_PORT)
  startEngine(PORT)
  try {
    await waitForEngine(PORT)
  } catch (e) {
    dialog.showErrorBox(
      "Yy Sustainer 启动失败",
      `${e.message}\n\n引擎日志：${engineLogPath()}\n\n常见原因：\n` +
        `· 首次启动被杀软拦截（放行后再打开）\n` +
        `· 端口 ${DEFAULT_PORT} 附近被占用且无法自动换端口\n` +
        `· 安装不完整（重新安装一次即可）`,
    )
    app.quit()
    return
  }
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  app.quit()
})

// #28 系统文件夹选择对话框：渲染进程经 preload bridge 调用（sandbox 下 preload 只能用 ipcRenderer.invoke）
ipcMain.handle("yyagent:pick-folder", async () => {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, {
    title: "选择工作区文件夹",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "选这个文件夹",
  })
  if (r.canceled || !r.filePaths?.length) return null
  return r.filePaths[0]
})

// 自绘标题栏窗口控制：页面顶栏的最小化/关闭按钮（frame:false 无边框模式）
ipcMain.handle("yyagent:win-minimize", () => { win?.minimize() })
ipcMain.handle("yyagent:win-close", () => { win?.close() })

app.on("before-quit", () => {
  if (engine) {
    try { engine.kill() } catch { /* 忽略 */ }
    engine = null
  }
})
