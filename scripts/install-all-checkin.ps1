# install-all-checkin.ps1 - unified daily checkin task installer (Qoder + WorkBuddy + Trae CN)
#
# Replaces the six per-system scheduled tasks with ONE task "AllAutoCheckin"
# that runs run_all_checkin.py (pythonw, sequential, all three idempotent).
#
# Triggers: daily 10:20 (primary, after Qoder's 10:00 credit refresh)
#           daily 15:00 / 20:30 (catch-up, independent Daily triggers)
#
# Old tasks removed by default (re-installable anytime via the per-system
# install-*.ps1 / install-windows.ps1 scripts). Use -KeepExisting to skip removal.
#
# Uninstall:
#   Unregister-ScheduledTask -TaskName "AllAutoCheckin" -Confirm:$false

param([switch]$KeepExisting)

$ErrorActionPreference = "Stop"

$ManualPythonw = ""   # e.g. C:\Python313\pythonw.exe

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
Write-Host "Unified daily checkin - one-shot installer" -ForegroundColor Cyan
Write-Host ("-" * 46) -ForegroundColor DarkGray

# --- 1. locate pythonw ---
Write-Host "[1/3] locate pythonw.exe ..." -NoNewline
$pythonw = $ManualPythonw
if (-not $pythonw -or -not (Test-Path $pythonw)) { $pythonw = Find-Pythonw }
if (-not $pythonw -or -not (Test-Path $pythonw)) {
    Write-Host " failed" -ForegroundColor Red
    Write-Host "pythonw.exe not found. Install Python 3 first, or set `$ManualPythonw." -ForegroundColor Yellow
    exit 1
}
Write-Host " $pythonw" -ForegroundColor Green

# --- 2. locate run_all_checkin.py ---
Write-Host "[2/3] locate run_all_checkin.py ..." -NoNewline
$runner = Join-Path $PSScriptRoot "run_all_checkin.py"
if (-not (Test-Path $runner)) {
    Write-Host " failed" -ForegroundColor Red
    Write-Host "run_all_checkin.py not found next to this script." -ForegroundColor Yellow
    exit 1
}
$runner = (Resolve-Path $runner).Path
Write-Host " $runner" -ForegroundColor Green

# --- 3. remove old per-system tasks (optional) ---
$oldTasks = @("WorkBuddyAutoSignin", "WorkBuddyGrowthPoll", "QoderAutoSignin", "QoderSigninPoll", "TraeAutoSignin", "TraeSigninPoll")
if (-not $KeepExisting) {
    Write-Host "[3/3] remove old per-system tasks ..." -NoNewline
    foreach ($t in $oldTasks) {
        $existing = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        if ($existing) {
            Unregister-ScheduledTask -TaskName $t -Confirm:$false
            Write-Host "" ; Write-Host "  removed $t" -ForegroundColor DarkGray
        }
    }
    Write-Host " done" -ForegroundColor Green
} else {
    Write-Host "[3/3] keep existing tasks (-KeepExisting)" -ForegroundColor Yellow
}

# --- 4. create unified task ---
Write-Host "[4/4] create AllAutoCheckin ..." -NoNewline
try {
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
    $act = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$runner`"" -WorkingDirectory $PSScriptRoot
    # Independent Daily triggers (missed repetitions are skipped forever;
    # missed independent triggers catch up on next boot via StartWhenAvailable)
    $tris = @()
    foreach ($hh in @("10:20", "15:00", "20:30")) {
        $tris += New-ScheduledTaskTrigger -Daily -At $hh
    }
    $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -Hidden `
            -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
    Register-ScheduledTask -TaskName "AllAutoCheckin" `
        -Action $act -Trigger $tris -Settings $set -Principal $principal `
        -Description "Unified daily checkin: WorkBuddy + Qoder + Trae CN (all idempotent)" -Force | Out-Null
} catch {
    Write-Host " failed" -ForegroundColor Red
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
Write-Host " done" -ForegroundColor Green

# --- report ---
Write-Host ""
Write-Host "Unified task registered:" -ForegroundColor Green
$t = Get-ScheduledTask -TaskName "AllAutoCheckin"
$i = Get-ScheduledTaskInfo -TaskName "AllAutoCheckin"
Write-Host ("  AllAutoCheckin  {0}  daily 10:20 / 15:00 / 20:30" -f $t.State)
Write-Host ("  next run {0}" -f $i.NextRunTime) -ForegroundColor DarkGray

Write-Host ""
$logFile = Join-Path $PSScriptRoot "all_checkin.log"
Write-Host "Combined log: $logFile" -ForegroundColor Cyan
Write-Host "Per-system logs: signin.log / qoder_checkin.log / trae_checkin.log (same dir)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Manual run (foreground):" -ForegroundColor DarkGray
Write-Host "  python `"$runner`"" -ForegroundColor DarkGray
Write-Host "Uninstall:" -ForegroundColor DarkGray
Write-Host '  Unregister-ScheduledTask -TaskName "AllAutoCheckin" -Confirm:$false' -ForegroundColor DarkGray
Write-Host ""
