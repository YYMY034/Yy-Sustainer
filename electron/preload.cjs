// Yy Sustainer preload：受控暴露系统文件夹选择（sandbox 模式下 preload 只能 require("electron") 的 contextBridge/ipcRenderer 子集）
const { contextBridge, ipcRenderer, webUtils } = require("electron")

contextBridge.exposeInMainWorld("yyagentApi", {
  isElectron: true,
  // 返回选中的绝对路径；用户取消返回 null
  pickFolder: () => ipcRenderer.invoke("yyagent:pick-folder"),
  // 自绘标题栏窗口控制（无边框模式下页面顶栏的最小化/关闭按钮）
  winMinimize: () => ipcRenderer.invoke("yyagent:win-minimize"),
  winClose: () => ipcRenderer.invoke("yyagent:win-close"),
  // T141 成果分享：资源管理器中显示文件（拖进微信/QQ 即可发送）；非 Electron 环境无此 API
  showInFolder: (p) => ipcRenderer.invoke("yyagent:show-in-folder", p),
  // T150 拖放：把拖入窗口的 File 对象解析成本地绝对路径（Electron 32+ 移除了 File.path，必须走 webUtils）
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) } catch { return "" }
  },
})
