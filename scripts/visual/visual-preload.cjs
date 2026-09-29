/**
 * T96：页面级错误收集 preload（配合 electron-shot.cjs）。
 * 在页面脚本跑之前装上，window.onerror / unhandledrejection 全收进 __pageErrors。
 */
window.__pageErrors = []
window.addEventListener("error", (e) => {
  window.__pageErrors.push(String((e && e.message) || e.type || "unknown error"))
})
window.addEventListener("unhandledrejection", (e) => {
  window.__pageErrors.push("unhandledrejection: " + String(e && e.reason))
})
