param(
  [string]$Title = "YYAgent",
  [string]$Message = "任务完成"
)
# Windows 10/11 原生 Toast 通知（无需模块）
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $t = [System.Security.SecurityElement]::Escape($Title)
  $m = [System.Security.SecurityElement]::Escape($Message)
  $xml.LoadXml("<toast><visual><binding template=""ToastText02""><text id=""1"">$t</text><text id=""2"">$m</text></binding></visual></toast>")
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  $appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  "toast-ok"
} catch {
  # 兜底：提示音
  try { [console]::beep(800, 300) } catch {}
  "toast-fallback: $($_.Exception.Message)"
}
