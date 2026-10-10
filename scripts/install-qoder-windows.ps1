# install-qoder-windows.ps1 - Qoder daily checkin one-shot installer (Windows)
#
# Mirrors install-windows.ps1 conventions: hidden tasks, pythonw (no window),
# StartWhenAvailable (catch-up after boot/sleep), independent Daily triggers
# for the poll task (repetition intervals get skipped permanently when missed).
#
# Creates two scheduled tasks:
#   1) QoderAutoSignin   daily 10:10            qoder_checkin.py silent
#   2) QoderSigninPoll   daily 11/15/19/23      qoder_checkin.py silent-poll
#
# Qoder daily credits refresh at 10:00 (UTC+8). Nothing is claimable before
# that (pre-10:00 runs only ever see yesterday's CLAIMED state), so every
# trigger is placed after 10:00. The 11:00 poll absorbs any issuance delay.
#
# Prereq: run "python qoder_extract.py" once on this machine (same Windows user
# that is logged into the Qoder client) to fill qoder_config.json /
# qoder_accounts.json next to this script.
#
# Uninstall:
#   Unregister-ScheduledTask -TaskName "QoderAutoSignin" -Confirm:$false
#   Unregister-ScheduledTask -TaskName "QoderSigninPoll" -Confirm:$false

$ErrorActionPreference = "Stop"

# ====== rarely needed; set manually only if auto-detect fails ======
$ManualPythonw = ""   # e.g. C:\Python313\pythonw.exe
# ===================================================================

function Find-Pythonw {
    $c = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
    if ($c -and (Test-Path $c)) { return $c }

    $py = (Get-Command python -ErrorAction SilentlyContinue).Source
    if ($py) {
        $c = Join-Path (Split-Path $py) "pythonw.exe"
        if (Test-Path $c) { return $c }
    }

    foreach ($pat in @(
        "C:\Python3*\pythonw.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python3*\pythonw.exe",
        "C:\Program Files\Python3*\pythonw.exe"
    )) {
        $hit = Get-ChildItem $pat -ErrorAction SilentlyContinue |
               Sort-Object FullName -Descending | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

Write-Host ""
Write-Host "Qoder daily checkin - one-shot installer" -ForegroundColor Cyan
Write-Host ("-" * 46) -ForegroundColor DarkGray

# --- 1. locate pythonw.exe ---
Write-Host "[1/3] locate pythonw.exe ..." -NoNewline
$pythonw = $ManualPythonw
if (-not $pythonw -or -not (Test-Path $pythonw)) { $pythonw = Find-Pythonw }
if (-not $pythonw -or -not (Test-Path $pythonw)) {
    Write-Host " failed" -ForegroundColor Red
    Write-Host "pythonw.exe not found. Install Python 3 first, or set `$ManualPythonw." -ForegroundColor Yellow
    exit 1
}
Write-Host " $pythonw" -ForegroundColor Green

# --- 2. locate qoder_checkin.py ---
Write-Host "[2/3] locate qoder_checkin.py ..." -NoNewline
$checkin = $null
if ($PSScriptRoot) { $checkin = Join-Path $PSScriptRoot "qoder_checkin.py" }
if (-not $checkin -or -not (Test-Path $checkin)) { $checkin = Join-Path (Get-Location) "qoder_checkin.py" }
if (-not $checkin -or -not (Test-Path $checkin)) {
    Write-Host " failed" -ForegroundColor Red
    Write-Host "qoder_checkin.py not found next to this script." -ForegroundColor Yellow
    exit 1
}
$checkin = (Resolve-Path $checkin).Path
$dir = Split-Path $checkin
Write-Host " $checkin" -ForegroundColor Green

# --- 2.5 sanity: credentials present? ---
$accounts = Join-Path $dir "qoder_accounts.json"
if (-not (Test-Path $accounts)) {
    Write-Host ""
    Write-Host "WARNING: $accounts not found." -ForegroundColor Yellow
    Write-Host "Run 'python qoder_extract.py' in this directory first, or the tasks will only log login_required." -ForegroundColor Yellow
}

# --- 3. create scheduled tasks ---
Write-Host "[3/3] create scheduled tasks ..." -NoNewline
try {
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

    # Task 1: daily checkin (10:10, right after the 10:00 credit refresh)
    $act1 = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$checkin`" silent" -WorkingDirectory $dir
    $tri1 = New-ScheduledTaskTrigger -Daily -At "10:10"
    $set1 = New-ScheduledTaskSettingsSet -StartWhenAvailable -Hidden `
            -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    Register-ScheduledTask -TaskName "QoderAutoSignin" `
        -Action $act1 -Trigger $tri1 -Settings $set1 -Principal $principal `
        -Description "Qoder daily auto checkin (silent, claim idempotent)" -Force | Out-Null

    # Task 2: poll (11:00/15:00/19:00/23:00) - independent Daily triggers, not a repetition
    # interval: missed repetitions are skipped forever, missed independent
    # triggers are made up on next boot (StartWhenAvailable).
    $tri2 = @()
    foreach ($hh in @("11:00", "15:00", "19:00", "23:00")) {
        $tri2 += New-ScheduledTaskTrigger -Daily -At $hh
    }
    $act2 = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$checkin`" silent-poll" -WorkingDirectory $dir
    $set2 = New-ScheduledTaskSettingsSet -StartWhenAvailable -Hidden `
            -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName "QoderSigninPoll" `
        -Action $act2 -Trigger $tri2 -Settings $set2 -Principal $principal `
        -Description "Qoder checkin poll (campaign not issued yet -> retry)" -Force | Out-Null
} catch {
    Write-Host " failed" -ForegroundColor Red
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
Write-Host " done" -ForegroundColor Green

# --- report ---
Write-Host ""
Write-Host "Two scheduled tasks registered:" -ForegroundColor Green
foreach ($row in @(
    @{ Name = "QoderAutoSignin"; When = "daily 10:10"; What = "checkin" },
    @{ Name = "QoderSigninPoll"; When = "daily 11/15/19/23"; What = "poll catch-up" }
)) {
    $t = Get-ScheduledTask -TaskName $row.Name
    $i = Get-ScheduledTaskInfo -TaskName $row.Name
    Write-Host ("  {0,-18} {1,-8} {2,-20} {3}" -f $row.Name, $t.State, $row.When, $row.What)
    Write-Host ("  {0,-18} next run {1}" -f "", $i.NextRunTime) -ForegroundColor DarkGray
}

Write-Host ""
$logFile = Join-Path $dir "qoder_checkin.log"
Write-Host "Log: $logFile" -ForegroundColor Cyan
Write-Host "Verify:" -ForegroundColor DarkGray
Write-Host "  Get-Content '$logFile' -Tail 3" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Uninstall (both):" -ForegroundColor DarkGray
Write-Host '  Unregister-ScheduledTask -TaskName "QoderAutoSignin" -Confirm:$false' -ForegroundColor DarkGray
Write-Host '  Unregister-ScheduledTask -TaskName "QoderSigninPoll" -Confirm:$false' -ForegroundColor DarkGray
Write-Host ""
