# install-trae-windows.ps1 - Trae CN daily checkin (pure API) task installer
#
# Mirrors the WorkBuddy/Qoder installer conventions: hidden tasks, catch-up on
# boot (StartWhenAvailable), independent Daily triggers for the poll task.
# Runs node via a wscript wrapper so no console window flashes.
#
# Creates two scheduled tasks:
#   1) TraeAutoSignin   daily 00:20      trae_checkin_api.mjs (trigger=schedule)
#   2) TraeSigninPoll   daily 12:00/20:00 (trigger=poll)
#
# No Trae client launch involved: credentials are decrypted from Trae's local
# storage on every run, so a Trae client update that rotates the token is
# picked up automatically.
#
# Uninstall:
#   Unregister-ScheduledTask -TaskName "TraeAutoSignin","TraeSigninPoll" -Confirm:$false

$ErrorActionPreference = "Stop"

# ====== rarely needed; set manually only if auto-detect fails ======
$ManualNode = ""   # e.g. C:\Program Files\nodejs\node.exe
# ===================================================================

function Find-Node {
    $c = (Get-Command node -ErrorAction SilentlyContinue).Source
    if ($c -and (Test-Path $c)) { return $c }
    foreach ($pat in @(
        "C:\Program Files\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs*\node.exe",
        "C:\Program Files (x86)\nodejs\node.exe"
    )) {
        $hit = Get-Item $pat -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

Write-Host ""
Write-Host "Trae CN daily checkin (pure API) - one-shot installer" -ForegroundColor Cyan
Write-Host ("-" * 46) -ForegroundColor DarkGray

# --- 1. locate node.exe ---
Write-Host "[1/3] locate node.exe ..." -NoNewline
$node = $ManualNode
if (-not $node -or -not (Test-Path $node)) { $node = Find-Node }
if (-not $node -or -not (Test-Path $node)) {
    Write-Host " failed" -ForegroundColor Red
    Write-Host "node.exe not found. Install Node.js >= 22 first, or set `$ManualNode." -ForegroundColor Yellow
    exit 1
}
Write-Host " $node" -ForegroundColor Green

# --- 2. locate script + vbs wrapper ---
Write-Host "[2/3] locate trae_checkin_api.mjs ..." -NoNewline
$mjs = Join-Path $PSScriptRoot "trae_checkin_api.mjs"
$vbs = Join-Path $PSScriptRoot "trae_hidden.vbs"
if (-not (Test-Path $mjs) -or -not (Test-Path $vbs)) {
    Write-Host " failed" -ForegroundColor Red
    Write-Host "trae_checkin_api.mjs / trae_hidden.vbs not found next to this script." -ForegroundColor Yellow
    exit 1
}
$mjs = (Resolve-Path $mjs).Path
$vbs = (Resolve-Path $vbs).Path
Write-Host " $mjs" -ForegroundColor Green

# --- 2.5 sanity: Trae credential storage present? ---
$sj = Join-Path $env:APPDATA "Trae CN\User\globalStorage\storage.json"
if (-not (Test-Path $sj)) {
    Write-Host ""
    Write-Host "WARNING: $sj not found." -ForegroundColor Yellow
    Write-Host "Install and log into Trae CN first; the script needs its local credential storage." -ForegroundColor Yellow
}

# --- 3. create scheduled tasks ---
Write-Host "[3/3] create scheduled tasks ..." -NoNewline
try {
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

    # Task 1: daily checkin (00:20)
    $act1 = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`" schedule" -WorkingDirectory $PSScriptRoot
    $tri1 = New-ScheduledTaskTrigger -Daily -At "00:20"
    $set1 = New-ScheduledTaskSettingsSet -StartWhenAvailable -Hidden `
            -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName "TraeAutoSignin" `
        -Action $act1 -Trigger $tri1 -Settings $set1 -Principal $principal `
        -Description "Trae CN daily auto checkin (pure API, no client launch)" -Force | Out-Null

    # Task 2: poll (12:00 / 20:00) - independent Daily triggers
    $tri2 = @()
    foreach ($hh in @("12:00", "20:00")) {
        $tri2 += New-ScheduledTaskTrigger -Daily -At $hh
    }
    $act2 = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`" poll" -WorkingDirectory $PSScriptRoot
    $set2 = New-ScheduledTaskSettingsSet -StartWhenAvailable -Hidden `
            -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName "TraeSigninPoll" `
        -Action $act2 -Trigger $tri2 -Settings $set2 -Principal $principal `
        -Description "Trae CN checkin poll (catch-up)" -Force | Out-Null
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
    @{ Name = "TraeAutoSignin"; When = "daily 00:20"; What = "checkin" },
    @{ Name = "TraeSigninPoll"; When = "daily 12:00/20:00"; What = "poll catch-up" }
)) {
    $t = Get-ScheduledTask -TaskName $row.Name
    $i = Get-ScheduledTaskInfo -TaskName $row.Name
    Write-Host ("  {0,-18} {1,-8} {2,-20} {3}" -f $row.Name, $t.State, $row.When, $row.What)
    Write-Host ("  {0,-18} next run {1}" -f "", $i.NextRunTime) -ForegroundColor DarkGray
}

Write-Host ""
$logFile = Join-Path $PSScriptRoot "trae_checkin.log"
Write-Host "Log: $logFile" -ForegroundColor Cyan
Write-Host "Verify:" -ForegroundColor DarkGray
Write-Host "  Get-Content '$logFile' -Tail 3" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Uninstall (both):" -ForegroundColor DarkGray
Write-Host '  Unregister-ScheduledTask -TaskName "TraeAutoSignin" -Confirm:$false' -ForegroundColor DarkGray
Write-Host '  Unregister-ScheduledTask -TaskName "TraeSigninPoll" -Confirm:$false' -ForegroundColor DarkGray
Write-Host ""
