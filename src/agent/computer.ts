import { tool, type Tool } from "ai"
import { z } from "zod"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { runPowerShell } from "./ps.js"
import { gate, type PermissionMode } from "./permissions.js"
import type { QuestionBroker } from "./ask.js"

/**
 * T44 桌面操控：让 agent 有"模拟点击"的真本事 —— 移动鼠标、点击、拖拽、滚动、
 * 输入文字、按组合键、切换前台窗口、截屏并识图。
 *
 * 实现走 Windows 原生 user32.dll（PowerShell + Add-Type P/Invoke），
 * 不引入 robotjs / nircmd 之类原生依赖，零安装成本。
 *
 * 为什么不是 MCP：这类能力需要跟着会话权限档位走（confirm-all 时要逐次确认），
 * 内置工具能直接拿 toolCtx 里的 broker，MCP 子进程拿不到。
 */

const GUI_PS_VERSION = "t44-2"
const GUI_DIR = join(homedir(), ".yyagent", "bin")
const GUI_SCRIPT = join(GUI_DIR, "gui.ps1")
const SHOT_DIR = join(homedir(), ".yyagent", "screenshots")

/** PowerShell 单引号字符串转义：' → '' */
function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

const GUI_PS = `# YyAgent 桌面操控脚本 —— 由 src/agent/computer.ts 自动生成，请勿手改
# ${GUI_PS_VERSION}
param(
  [Parameter(Mandatory=$true)][string]$Action,
  [int]$X = -1, [int]$Y = -1, [int]$X2 = -1, [int]$Y2 = -1,
  [string]$Button = "left", [int]$Count = 1, [int]$Amount = 0,
  [string]$Text = "", [string]$Keys = "", [string]$Title = "",
  [string]$Path = "", [int]$SettleMs = 80
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not ("YyWin32" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class YyWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
}
'@
}
$DOWN = @{ left = 0x0002; right = 0x0008; middle = 0x0020 }
$UP   = @{ left = 0x0004; right = 0x0010; middle = 0x0040 }
function Move-To([int]$mx, [int]$my) { [void][YyWin32]::SetCursorPos($mx, $my) }
function Cursor-Pos {
  $p = New-Object YyWin32+PT
  [void][YyWin32]::GetCursorPos([ref]$p)
  return "$($p.X),$($p.Y)"
}
function Active-Title {
  $h = [YyWin32]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][YyWin32]::GetWindowText($h, $sb, 512)
  return $sb.ToString()
}
$VK = @{
  ctrl = 0x11; control = 0x11; alt = 0x12; shift = 0x10; win = 0x5B; meta = 0x5B
  enter = 0x0D; return = 0x0D; tab = 0x09; esc = 0x1B; escape = 0x1B; space = 0x20
  backspace = 0x08; delete = 0x2E; del = 0x2E; insert = 0x2D
  up = 0x26; down = 0x28; left = 0x25; right = 0x27
  home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22
  f1 = 0x70; f2 = 0x71; f3 = 0x72; f4 = 0x73; f5 = 0x74; f6 = 0x75
  f7 = 0x76; f8 = 0x77; f9 = 0x78; f10 = 0x79; f11 = 0x7A; f12 = 0x7B
}
switch ($Action) {
  "info" {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    Write-Output "screen=$($vs.Width)x$($vs.Height) origin=$($vs.Left),$($vs.Top)"
    Write-Output "cursor=$(Cursor-Pos)"
    Write-Output "activeWindow=$(Active-Title)"
  }
  "windows" {
    Get-Process |
      Where-Object { $_.MainWindowTitle -ne "" } |
      Sort-Object -Property ProcessName |
      ForEach-Object { Write-Output ($_.Id.ToString() + " | " + $_.ProcessName + " | " + $_.MainWindowTitle) }
  }
  "focus" {
    if (-not $Title) { Write-Output "ERROR: focus 需要 title"; break }
    $p = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -like "*$Title*" } | Select-Object -First 1
    if (-not $p) { Write-Output "NOTFOUND: 没有标题包含「$Title」的窗口" }
    else {
      [void][YyWin32]::ShowWindow($p.MainWindowHandle, 9)
      [void][YyWin32]::SetForegroundWindow($p.MainWindowHandle)
      Start-Sleep -Milliseconds 260
      Write-Output "focused=$($p.MainWindowTitle)"
    }
  }
  "move" {
    Move-To $X $Y
    Start-Sleep -Milliseconds 40
    Write-Output "cursor=$(Cursor-Pos)"
  }
  "click" {
    if ($X -ge 0 -and $Y -ge 0) { Move-To $X $Y; Start-Sleep -Milliseconds $SettleMs }
    $d = $DOWN[$Button]; $u = $UP[$Button]
    if ($null -eq $d) { Write-Output "ERROR: button 只能是 left/right/middle"; break }
    for ($i = 0; $i -lt [Math]::Max(1, $Count); $i++) {
      [YyWin32]::mouse_event($d, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 35
      [YyWin32]::mouse_event($u, 0, 0, 0, [UIntPtr]::Zero)
      if ($i -lt $Count - 1) { Start-Sleep -Milliseconds 70 }
    }
    Write-Output "clicked=$Button x$([Math]::Max(1,$Count)) at $(Cursor-Pos)"
  }
  "drag" {
    Move-To $X $Y; Start-Sleep -Milliseconds 90
    [YyWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 90
    $steps = 24
    for ($i = 1; $i -le $steps; $i++) {
      Move-To ([int]($X + ($X2 - $X) * $i / $steps)) ([int]($Y + ($Y2 - $Y) * $i / $steps))
      Start-Sleep -Milliseconds 14
    }
    Start-Sleep -Milliseconds 80
    [YyWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Write-Output "dragged=$X,$Y -> $X2,$Y2"
  }
  "scroll" {
    if ($X -ge 0 -and $Y -ge 0) { Move-To $X $Y; Start-Sleep -Milliseconds 60 }
    if ($Amount -eq 0) { Write-Output "ERROR: scroll 需要 amount"; break }
    [YyWin32]::mouse_event(0x0800, 0, 0, (120 * $Amount), [UIntPtr]::Zero)
    Write-Output "scrolled=$Amount at $(Cursor-Pos)"
  }
  "type" {
    if (-not $Text) { Write-Output "ERROR: type 需要 text"; break }
    Set-Clipboard -Value $Text
    Start-Sleep -Milliseconds 90
    [YyWin32]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
    [YyWin32]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [YyWin32]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)
    [YyWin32]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    Write-Output "typed=$($Text.Length) 字符（经剪贴板粘贴）"
  }
  "key" {
    if (-not $Keys) { Write-Output "ERROR: key 需要 keys"; break }
    $codes = @()
    foreach ($part in ($Keys.ToLower() -split '\\+')) {
      $p = $part.Trim()
      if (-not $p) { continue }
      if ($VK.ContainsKey($p)) { $codes += $VK[$p]; continue }
      if ($p.Length -eq 1) {
        $c = [int][char]$p
        if ($c -ge 97 -and $c -le 122) { $codes += ($c - 32); continue }
        if (($c -ge 48 -and $c -le 57) -or ($c -ge 65 -and $c -le 90)) { $codes += $c; continue }
      }
      Write-Output "ERROR: 不认识的按键「$p」（可用：ctrl/alt/shift/win/enter/tab/esc/space/backspace/delete/方向键/f1-f12/单字符）"
      exit 1
    }
    if ($codes.Count -eq 0) { Write-Output "ERROR: keys 解析为空"; break }
    foreach ($c in $codes) { [YyWin32]::keybd_event([byte]$c, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }
    for ($i = $codes.Count - 1; $i -ge 0; $i--) { [YyWin32]::keybd_event([byte]$codes[$i], 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }
    Write-Output "pressed=$Keys"
  }
  "screen" {
    if (-not $Path) { Write-Output "ERROR: screen 需要 path"; break }
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
    $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "saved=$Path size=$($vs.Width)x$($vs.Height)"
  }
  default { Write-Output "ERROR: 未知 action「$Action」" }
}
`

/** 首次调用或版本变更时把脚本落盘（用 Node 写文件，绕开 shell 多层引号转义） */
function ensureGuiScript(): string {
  mkdirSync(GUI_DIR, { recursive: true })
  let need = true
  try {
    need = !existsSync(GUI_SCRIPT) || !readFileSync(GUI_SCRIPT, "utf8").includes(GUI_PS_VERSION)
  } catch {
    need = true
  }
  if (need) writeFileSync(GUI_SCRIPT, GUI_PS, "utf8")
  return GUI_SCRIPT
}

/** 调一次 gui.ps1，返回其 stdout（失败信息也以文本形式回来，不抛异常） */
async function callGui(args: string[], timeoutMs = 20_000): Promise<string> {
  const script = ensureGuiScript()
  const cmd = `& ${psq(script)} ${args.join(" ")}`
  const out = await runPowerShell(cmd, timeoutMs, homedir())
  const fail = /^(ERROR|NOTFOUND|.*\[启动失败)/m.exec(out)
  return fail ? `[失败] ${out}` : out
}

export interface ComputerDeps {
  /** 取当前会话生效的权限档位（会话覆盖 > 全局配置） */
  permission: () => PermissionMode
  /** 当前会话的问答 broker（交互模式下用来弹确认） */
  broker: () => QuestionBroker | undefined
}

const MUTATING = new Set(["click", "drag", "type", "key"])

export function makeComputerTool(deps: ComputerDeps): Tool {
  return tool({
    description:
      "直接操控本机桌面（真实鼠标键盘，不是模拟 DOM）：点击/双击/右键、拖拽、滚动、输入文字、按组合键、切换前台窗口、截全屏并识图。用于操作没有可用 API 的本地程序（浏览器、桌面客户端）。" +
      "坐标以屏幕左上角为原点、单位像素；拿不准坐标时先用 action=screen 截图，再按截图描述定位。点击/输入/按键会按权限档位请求确认。",
    inputSchema: z.object({
      action: z
        .enum(["info", "screen", "windows", "focus", "move", "click", "drag", "scroll", "type", "key"])
        .describe("要执行的动作"),
      x: z.number().int().optional().describe("屏幕 X 坐标（像素，左上角为 0）"),
      y: z.number().int().optional().describe("屏幕 Y 坐标（像素，左上角为 0）"),
      x2: z.number().int().optional().describe("drag 的终点 X"),
      y2: z.number().int().optional().describe("drag 的终点 Y"),
      button: z.enum(["left", "right", "middle"]).optional().describe("鼠标键，默认 left"),
      count: z.number().int().min(1).max(3).optional().describe("点击次数，2 = 双击；默认 1"),
      amount: z.number().int().optional().describe("scroll 的档数：正数向上滚、负数向下滚（1 档≈3 行）"),
      text: z.string().optional().describe("type 要输入的文字（经剪贴板粘贴，会覆盖系统剪贴板；支持中文）"),
      keys: z.string().optional().describe("key 的组合键，如 'ctrl+c'、'alt+tab'、'enter'、'ctrl+shift+s'"),
      title: z.string().optional().describe("focus 要匹配的窗口标题片段（不区分大小写，子串匹配）"),
      describe: z.boolean().optional().describe("screen 是否顺带用识图模型描述截图内容（默认 true；false 只存图不看）"),
    }),
    async execute(a) {
      const pos = a.x != null && a.y != null ? ` at ${a.x},${a.y}` : ""
      if (MUTATING.has(a.action)) {
        const denied = await gate({
          tool: "computer",
          summary: `${a.action} ${a.action === "type" ? JSON.stringify((a.text ?? "").slice(0, 60)) : a.action === "key" ? a.keys : `${a.button ?? "left"} ${pos}${a.action === "drag" ? ` -> ${a.x2},${a.y2}` : ""}`}`,
          danger: false,
          mode: deps.permission(),
          broker: deps.broker(),
        })
        if (denied) return denied
      }

      switch (a.action) {
        case "info":
          return await callGui(["-Action info"])
        case "windows": {
          const out = await callGui(["-Action windows"])
          const lines = out.split("\n").filter(Boolean)
          return `共 ${lines.length} 个可见窗口（pid | 进程 | 标题）：\n${lines.slice(0, 60).join("\n")}${lines.length > 60 ? `\n…另有 ${lines.length - 60} 个未列出` : ""}`
        }
        case "focus":
          if (!a.title) return "[失败] focus 需要 title"
          return await callGui(["-Action focus", "-Title", psq(a.title)])
        case "move":
          if (a.x == null || a.y == null) return "[失败] move 需要 x,y"
          return await callGui(["-Action move", "-X", String(a.x), "-Y", String(a.y)])
        case "click":
          return await callGui([
            "-Action click",
            ...(a.x != null && a.y != null ? ["-X", String(a.x), "-Y", String(a.y)] : []),
            "-Button", a.button ?? "left",
            "-Count", String(a.count ?? 1),
          ])
        case "drag":
          if (a.x == null || a.y == null || a.x2 == null || a.y2 == null) return "[失败] drag 需要 x,y,x2,y2"
          return await callGui(["-Action drag", "-X", String(a.x), "-Y", String(a.y), "-X2", String(a.x2), "-Y2", String(a.y2)])
        case "scroll":
          if (!a.amount) return "[失败] scroll 需要 amount（正数向上、负数向下）"
          return await callGui([
            "-Action scroll",
            ...(a.x != null && a.y != null ? ["-X", String(a.x), "-Y", String(a.y)] : []),
            "-Amount", String(a.amount),
          ])
        case "type":
          if (!a.text) return "[失败] type 需要 text"
          return await callGui(["-Action type", "-Text", psq(a.text)])
        case "key":
          if (!a.keys) return "[失败] key 需要 keys"
          return await callGui(["-Action key", "-Keys", psq(a.keys)])
        case "screen": {
          mkdirSync(SHOT_DIR, { recursive: true })
          const shot = join(SHOT_DIR, `shot-${Date.now()}.png`)
          const out = await callGui(["-Action screen", "-Path", psq(shot)], 45_000)
          if (out.startsWith("[失败]")) return out
          if (a.describe === false) return `${out}\n（已跳过识图，需要解读时再调一次 screen）`
          try {
            const { describeImage } = await import("./vision.js")
            const desc = await describeImage(shot)
            return `截图已保存：${shot}\n\n【识图模型看到的画面】\n${desc}`
          } catch (e) {
            return `截图已保存：${shot}\n[识图失败] ${(e as Error).message}\n可在设置页配置「默认识图模型」后重试。`
          }
        }
        default:
          return `[失败] 未知 action：${a.action}`
      }
    },
  }) as unknown as Tool
}
