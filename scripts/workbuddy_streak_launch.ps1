# WorkBuddyStreakLaunch - 每日静默启动守卫
# 目的：成长中心"连签"只认桌面客户端当天的登录行为（脚本调 API 无效），
#       由计划任务每天调用本脚本，客户端未运行时静默拉起一次以记录当天登录。
# 静默方式：启动后等主窗口出现，再隐藏到后台（App 自带 closeToTray 支持，
#       托盘图标可恢复；再次双击 WorkBuddy.exe 也会唤回窗口）。
# 任务名：WorkBuddyStreakLaunch（每天 10:00，错过开机补跑）

$exe = 'D:\WorkBuddy\WorkBuddy.exe'
if (-not (Test-Path $exe)) { exit 1 }
if (Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue) { exit 0 }

Start-Process -FilePath $exe

# 最多等 20 秒，拿到主窗口句柄后隐藏（SW_HIDE = 0）
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $p = Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowHandle -ne 0 } |
         Select-Object -First 1
    if ($p) { $hwnd = $p.MainWindowHandle; break }
}
if ($hwnd -ne [IntPtr]::Zero) {
    if (-not ('Native.Win' -as [type])) {
        Add-Type -Namespace Native -Name Win -MemberDefinition '
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);'
    }
    [Native.Win]::ShowWindowAsync($hwnd, 0) | Out-Null
}
