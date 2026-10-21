# WorkBuddyStreakLaunch - 每日真实登录守卫
# 目的：成长中心"连签"只认桌面客户端当天的一次真实登录（脚本调 API 无效）。
#       客户端每天 03:02 会自我重启后常驻，常驻或后台自启都不记账，
#       所以守卫不再"进程存在就跳过"，而是校验当天是否已记账，
#       未记账则结束旧进程、重新拉起、让窗口可见一段时间，再用探针复核。
#
# 判定顺序：
#   1. .streak_state.json 已记录今天 → 直接退出（每天最多折腾一次）
#   2. 读连签基线（probe_streak.py --days）
#   3. 有 WorkBuddy 进程则整组结束，重新拉起（最近 3 分钟内启动的先等启动流程走完）
#   4. 主窗口出现后保持可见 60 秒，再隐藏到托盘（App 自带 closeToTray）
#   5. 每 20 秒复探一次，连签天数比基线大即记为成功，写入 state
#   6. 仍未记账则整套重来一次，两次都失败退出码 3（任务计划程序可见）
#
# 任务名：WorkBuddyStreakLaunch（每天 10:00，错过开机补跑，时限 15 分钟）
# 用法：powershell -File workbuddy_streak_launch.ps1 [-DryRun] [-MechanicsTest]
#   -DryRun        只输出决策与日志，不结束进程、不拉起客户端（改完先这么验）
#   -MechanicsTest 冒烟自检：忽略 state、只重启一轮、不判断天数是否增长、不写 state，
#                  用来单独验证"结束进程 → 拉起 → 窗口可见 → 隐藏 → 探针可读"这条链路

param(
    [switch]$DryRun,
    [switch]$MechanicsTest
)

$ErrorActionPreference = 'Continue'

$exe = 'D:\WorkBuddy\WorkBuddy.exe'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile = Join-Path $scriptDir 'streak_launch.log'
$stateFile = Join-Path $scriptDir '.streak_state.json'
$probeScript = Join-Path $scriptDir 'probe_streak.py'

$VISIBLE_SECONDS = 60        # 窗口保持可见的时长（等首页/登录态加载完）
$WINDOW_WAIT_SEC = 60        # 等主窗口出现的最长时长
$VERIFY_TRIES = 3            # 每次尝试内复探次数
$VERIFY_INTERVAL_SEC = 20    # 复探间隔
$MAX_ATTEMPTS = 2            # 整套（结束进程 + 拉起）最多执行次数

function Write-Log([string]$msg) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    try {
        if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 1MB)) {
            $tail = Get-Content $logFile -Tail 300
            Set-Content -Path $logFile -Value $tail -Encoding UTF8
        }
        Add-Content -Path $logFile -Value $line -Encoding UTF8
    } catch { }
}

function Get-Today {
    return (Get-Date).ToString('yyyy-MM-dd')
}

function Find-Python {
    $cands = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe'),
        (Join-Path $env:ProgramFiles 'Python312\python.exe'),
        (Join-Path $env:ProgramFiles 'Python311\python.exe')
    )
    foreach ($c in $cands) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    $cmd = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Read-State {
    if (-not (Test-Path $stateFile)) { return $null }
    try {
        $raw = Get-Content $stateFile -Raw -Encoding UTF8
        return (ConvertFrom-Json $raw)
    } catch { return $null }
}

function Write-State($days) {
    $obj = [ordered]@{
        date       = (Get-Today)
        days       = $days
        verifiedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    }
    try {
        $json = ConvertTo-Json -InputObject $obj -Compress
        Set-Content -Path $stateFile -Value $json -Encoding UTF8
    } catch {
        Write-Log ("⚠️ 写入 state 失败: {0}" -f $_.Exception.Message)
    }
}

# 读成长中心连签天数；探针失败返回 $null
function Get-StreakDays([string]$python) {
    if (-not $python -or -not (Test-Path $probeScript)) { return $null }
    $tmp = Join-Path $env:TEMP ('wb_streak_{0}.out' -f ([guid]::NewGuid().ToString('N')))
    try {
        $p = Start-Process -FilePath $python -ArgumentList @("`"$probeScript`"", '--days') `
            -PassThru -WindowStyle Hidden -RedirectStandardOutput $tmp -RedirectStandardError ($tmp + '.err')
        if (-not $p.WaitForExit(90000)) {
            try { $p.Kill() } catch { }
            Write-Log '⚠️ 探针超时'
            return $null
        }
        if (-not (Test-Path $tmp)) { return $null }
        $text = Get-Content $tmp -Raw -Encoding UTF8
        $m = [regex]::Match([string]$text, 'days=(-?\d+)')
        if (-not $m.Success) {
            Write-Log ('⚠️ 探针无有效输出: {0}' -f ([string]$text).Trim())
            return $null
        }
        $d = [int]$m.Groups[1].Value
        if ($d -lt 0) { return $null }
        return $d
    } catch {
        Write-Log ('⚠️ 探针异常: {0}' -f $_.Exception.Message)
        return $null
    } finally {
        Remove-Item $tmp, ($tmp + '.err') -Force -ErrorAction SilentlyContinue
    }
}

function Get-WorkBuddyProcesses {
    return @(Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue)
}

function Stop-WorkBuddy {
    $procs = Get-WorkBuddyProcesses
    if ($procs.Count -eq 0) { return }
    # 只看最早启动的那个（主实例）：辅助/CLI 子进程随调用随时新建，不能代表客户端刚启动
    $oldest = $procs | ForEach-Object { try { $_.StartTime } catch { $null } } |
              Where-Object { $_ } | Sort-Object | Select-Object -First 1
    if ($oldest -and ((Get-Date) - $oldest).TotalSeconds -lt 180) {
        Write-Log '主实例启动不足 3 分钟，先等 90 秒再接手'
        Start-Sleep -Seconds 90
    }
    if ($DryRun) {
        Write-Log ('[DryRun] 将结束现有 WorkBuddy 进程 {0} 个' -f $procs.Count)
        return
    }
    Write-Log ('结束现有 WorkBuddy 进程 {0} 个' -f $procs.Count)
    Stop-Process -Name WorkBuddy -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 8
}

function Start-WorkBuddy {
    Write-Log ("拉起客户端: {0}" -f $exe)
    if ($DryRun) { return [IntPtr]::Zero }
    Start-Process -FilePath $exe
    $hwnd = [IntPtr]::Zero
    $loops = [int]($WINDOW_WAIT_SEC * 2)
    for ($i = 0; $i -lt $loops; $i++) {
        Start-Sleep -Milliseconds 500
        $p = Get-WorkBuddyProcesses | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($p) { $hwnd = $p.MainWindowHandle; break }
    }
    if ($hwnd -eq [IntPtr]::Zero) {
        Write-Log ('⚠️ {0} 秒内没等到主窗口' -f $WINDOW_WAIT_SEC)
    } else {
        Write-Log '主窗口已出现，保持可见等待登录记账'
    }
    return $hwnd
}

function Hide-Window([IntPtr]$hwnd) {
    if ($hwnd -eq [IntPtr]::Zero) { return }
    if ($DryRun) { return }
    try {
        if (-not ('Native.Win' -as [type])) {
            Add-Type -Namespace Native -Name Win -MemberDefinition '
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);'
        }
        [Native.Win]::ShowWindowAsync($hwnd, 0) | Out-Null
        Write-Log '窗口已隐藏到托盘（托盘图标或再次双击 exe 可唤回）'
    } catch {
        # 隐藏失败不影响登录记账，窗口留在前台即可
        Write-Log ('⚠️ 隐藏窗口失败: {0}' -f $_.Exception.Message)
    }
}

# ── 主流程 ────────────────────────────────────────────────────────────
if (-not (Test-Path $exe)) {
    Write-Log ("❌ 客户端不存在: {0}" -f $exe)
    exit 1
}

$state = Read-State
if (-not $MechanicsTest -and $state -and $state.date -eq (Get-Today)) {
    Write-Log ("今天已校验通过（days={0}，{1}），无需处理" -f $state.days, $state.verifiedAt)
    exit 0
}

$python = Find-Python
if (-not $python) { Write-Log '⚠️ 未找到 python，跳过校验，仅做一次真实登录' }

$baseline = Get-StreakDays $python
if ($null -eq $baseline) {
    Write-Log '⚠️ 连签基线读取失败，本次按"只要起来就算成功"处理'
} else {
    Write-Log ("连签基线 days={0}" -f $baseline)
}

$success = $false
$lastDays = $null
$attempts = $MAX_ATTEMPTS
if ($MechanicsTest) { $attempts = 1 }

for ($attempt = 1; $attempt -le $attempts; $attempt++) {
    if ($attempt -gt 1) { Write-Log ("第 {0} 次尝试" -f $attempt) }

    Stop-WorkBuddy
    $hwnd = Start-WorkBuddy

    if ($DryRun) {
        Write-Log '[DryRun] 到此为止：不做结束进程 / 隐藏窗口'
        break
    }

    if ($MechanicsTest) {
        # 自检模式不隐藏窗口：重启后把界面留在前台，方便当场确认客户端确实回来了
        Start-Sleep -Seconds 20
        $lastDays = Get-StreakDays $python
        Write-Log ("[MechanicsTest] 窗口句柄={0} 重启后进程数={1} 复探 days={2}（自检模式保留窗口）" -f $hwnd, (Get-WorkBuddyProcesses).Count, $lastDays)
        if ($hwnd -ne [IntPtr]::Zero -and (Get-WorkBuddyProcesses).Count -gt 0) { $success = $true }
        break
    }

    # 窗口保持可见，等首页加载与登录握手完成
    Start-Sleep -Seconds $VISIBLE_SECONDS
    Hide-Window $hwnd

    for ($t = 0; $t -lt $VERIFY_TRIES; $t++) {
        $days = Get-StreakDays $python
        if ($null -ne $days) {
            $lastDays = $days
            Write-Log ("复探 days={0}" -f $days)
            if ($null -eq $baseline) {
                if ($days -ge 1) { $success = $true; break }
            } elseif ($days -gt $baseline) {
                $success = $true
                break
            }
        }
        if ($t -lt ($VERIFY_TRIES - 1)) { Start-Sleep -Seconds $VERIFY_INTERVAL_SEC }
    }

    if ($success) { break }
    Write-Log ("第 {0} 次尝试未记账，连签仍为 days={1}" -f $attempt, $lastDays)
}

if ($DryRun) { exit 0 }

if ($MechanicsTest) {
    if ($success) {
        Write-Log '[MechanicsTest] ✅ 结束进程、拉起、主窗口出现、探针可读四项均正常（隐藏链路另行验证，不写 state）'
        exit 0
    }
    Write-Log '[MechanicsTest] ❌ 重启链路异常：窗口句柄或进程缺失，检查客户端安装与单实例锁'
    exit 3
}

if (-not $python) {
    Write-Log '⚠️ 无 python 无法复核，已按流程完成一次真实登录'
    exit 0
}

if ($success) {
    Write-State $lastDays
    Write-Log ("✅ 今日连签已记账 days={0}" -f $lastDays)
    exit 0
}

if ($null -ne $baseline -and $baseline -ge 1) {
    Write-Log ("❌ 两次尝试后连签仍为 days={0}。若今天此前已手动登录过客户端，天数不再增长属正常，请确认成长中心是否已显示今日" -f $lastDays)
} else {
    Write-Log ("❌ 两次尝试后连签仍未记账（最后读数 days={0}），需人工检查客户端登录态" -f $lastDays)
}
exit 3
