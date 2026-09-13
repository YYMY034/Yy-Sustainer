$log = "C:\Users\YYMY\Documents\Catpaw\YYAgent\yyagentd\logs\shortcut-update.log"
$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop "YYAgent.lnk"
$tmpPath = Join-Path $desktop "YYAgent.new.lnk"
try {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($tmpPath)
  $lnk.TargetPath = "C:\Users\YYMY\Documents\Catpaw\YYAgent\yyagentd\node_modules\electron\dist\electron.exe"
  $lnk.Arguments = "C:\Users\YYMY\Documents\Catpaw\YYAgent\yyagentd"
  $lnk.WorkingDirectory = "C:\Users\YYMY\Documents\Catpaw\YYAgent\yyagentd"
  $lnk.IconLocation = "C:\Users\YYMY\Documents\Catpaw\YYAgent\yyagent.ico,0"
  $lnk.Description = "YYAgent Desktop"
  $lnk.WindowStyle = 7
  $lnk.Save()
  # 用流读写覆盖（open+truncate，非删除操作）
  $bytes = [System.IO.File]::ReadAllBytes($tmpPath)
  $fs = [System.IO.FileStream]::new($lnkPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  $fs.Write($bytes, 0, $bytes.Length)
  $fs.Close()
  [System.IO.File]::Delete($tmpPath)
  [System.IO.File]::WriteAllText($log, "OK: stream-overwrote $lnkPath ($($bytes.Length) bytes) -> electron.exe + yyagent.ico")
} catch {
  [System.IO.File]::WriteAllText($log, "FAIL: $($_.Exception.Message)")
}
