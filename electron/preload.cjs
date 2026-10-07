// Yy Sustainer preload：受控暴露系统文件夹选择（sandbox 模式下 preload 只能 require("electron") 的 contextBridge/ipcRenderer 子集）
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("yyagentApi", {
  isElectron: true,
  // 返回选中的绝对路径；用户取消返回 null
  pickFolder: () => ipcRenderer.invoke("yyagent:pick-folder"),
  // 自绘标题栏窗口控制（无边框模式下页面顶栏的最小化/关闭按钮）
  winMinimize: () => ipcRenderer.invoke("yyagent:win-minimize"),
  winClose: () => ipcRenderer.invoke("yyagent:win-close"),
  // T135 成果分享：资源管理器中显示文件（拖进微信/QQ 即可发送）；非 Electron 环境无此 API
  showInFolder: (p) => ipcRenderer.invoke("yyagent:show-in-folder", p),
})
