# run-tests.ps1 - Run the Scheduler4VP320 test suite and build a consolidated report.
#
# On a machine connected to the player (Windows 10, Node.js installed):
#   - offline suite  (test-runner.js)   : TM2 roundtrip, engine, MD5/Digest.
#   - live validation (validate-player.js): REST Digest + FTP to the player.
#
# Usage (PowerShell):
#   .\run-tests.ps1 -Host 192.168.1.100 -User admin -Pass yourPassword [-Upload] [-HttpPort 80] [-FtpPort 21]
#
# Without -Host: only the offline part is executed.
#
# Outputs:
#   REPORT.md / REPORT.json  : consolidated report (to be sent back)
#   report.json              : offline details
#   report-live.json         : live details
#
# ENCODING - IMPORTANT:
#   This file is deliberately pure ASCII and starts with a UTF-8 BOM.
#   Windows PowerShell 5.1 reads a BOM-less file as ANSI (cp1252), so UTF-8
#   bytes (accents, em dash) corrupt string literals and break the parser.
#   Do not add non-ASCII characters here.

param(
    [Alias("Host")][string]$PlayerHost = "",
    [string]$User = "admin",
    [string]$Pass = "",
    [switch]$Upload,
    [int]$HttpPort = 80,
    [int]$FtpPort = 21
)

$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

# Print Node.js output (UTF-8) correctly in the console.
try { [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch { }

function Section([string]$title) {
    Write-Host ""
    Write-Host "--- $title ---"
}

function Save-Utf8([string]$name, [string]$content) {
    $full = Join-Path $here $name
    [System.IO.File]::WriteAllText($full, $content, (New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false))
}

function Get-CleanDetail([string]$text) {
    if (-not $text) { return "" }
    $t = $text -replace '\|', '\|'
    $t = $t -replace "\r?\n", " "
    return $t
}

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

$machine = [string]$env:COMPUTERNAME
try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    if ($os -and $os.Caption) { $machine = [string]$os.Caption }
} catch { }
if (-not $machine) { $machine = "(inconnue)" }

$hostLabel = $PlayerHost
if (-not $hostLabel) { $hostLabel = "(non specifie)" }

Write-Host ""
Write-Host "============================================================"
Write-Host "  Scheduler4VP320 - Tests (offline + live)"
Write-Host "============================================================"

# --- prerequisite: Node.js -----------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "[ERREUR] Node.js introuvable. Installez-le depuis https://nodejs.org puis relancez." -ForegroundColor Red
    Write-Host "         Recommande : v18 ou plus (fetch natif)."
    exit 1
}

$nodeVer = ""
try { $nodeVer = [string](& node --version 2>$null) } catch { }
$nodeVer = $nodeVer.Trim()
Write-Host "[OK] Node.js : $nodeVer"

# --- 1) offline tests -----------------------------------------------------
Section "1) Suite hors-ligne (test-runner.js)"

$offlineJson = Join-Path $here "report.json"
Remove-Item -Path $offlineJson -ErrorAction SilentlyContinue

& node test-runner.js
$offExit = $LASTEXITCODE

$offline = $null
if (Test-Path $offlineJson) {
    try {
        $offline = Get-Content $offlineJson -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Write-Host "[ERREUR] report.json illisible : $($_.Exception.Message)" -ForegroundColor Red
        $offline = $null
    }
} else {
    Write-Host "[ERREUR] report.json non produit par test-runner.js" -ForegroundColor Red
}

# --- 2) live validation (optional) ---------------------------------------
$live = $null
if ($PlayerHost) {
    Section "2) Validation live du player $PlayerHost"

    $liveJson = Join-Path $here "report-live.json"
    Remove-Item -Path $liveJson -ErrorAction SilentlyContinue

    $vpArgs = @(
        "--host=$PlayerHost",
        "--user=$User",
        "--pass=$Pass",
        "--http-port=$HttpPort",
        "--ftp-port=$FtpPort",
        "--out=report-live.json"
    )
    if ($Upload) { $vpArgs += "--upload=1" }

    & node validate-player.js $vpArgs
    $liveExit = $LASTEXITCODE

    if (Test-Path $liveJson) {
        try {
            $live = Get-Content $liveJson -Raw -Encoding UTF8 | ConvertFrom-Json
        } catch {
            Write-Host "[ERREUR] report-live.json illisible : $($_.Exception.Message)" -ForegroundColor Red
            $live = $null
        }
    } else {
        Write-Host "[ERREUR] report-live.json non produit" -ForegroundColor Red
    }
} else {
    Section "2) Validation live ignoree (pas de -Host)"
}

# --- 3) consolidated report ----------------------------------------------
Section "3) Generation de REPORT.md / REPORT.json"

$sb = New-Object System.Text.StringBuilder

[void]$sb.AppendLine("# Compte rendu Scheduler4VP320")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("- Date : **$stamp**")
[void]$sb.AppendLine("- Machine : **$machine**")
[void]$sb.AppendLine("- Node.js : **$nodeVer**")
[void]$sb.AppendLine("- Player cible : **$hostLabel**")
[void]$sb.AppendLine("")

# offline
if ($offline) {
    [void]$sb.AppendLine("## 1. Tests hors-ligne")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("| Resultat | Test | Detail |")
    [void]$sb.AppendLine("|---|---|---|")
    foreach ($r in $offline.results) {
        $mark = if ($r.pass) { "PASS" } else { "**FAIL**" }
        $det = Get-CleanDetail ([string]$r.detail)
        [void]$sb.AppendLine("| $mark | $($r.name) | $det |")
    }
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("**Synthese :** $($offline.passed) succes, $($offline.failed) echec(s) sur $($offline.total).")
    [void]$sb.AppendLine("")
} else {
    [void]$sb.AppendLine("## 1. Tests hors-ligne : NON EXECUTES")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("test-runner.js n'a pas produit de rapport exploitable (voir la console).")
    [void]$sb.AppendLine("")
}

# live
if ($live) {
    [void]$sb.AppendLine("## 2. Validation live du player")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("| Resultat | Test | Detail |")
    [void]$sb.AppendLine("|---|---|---|")
    foreach ($r in $live.results) {
        $mark = if ($r.pass) { "PASS" } else { "**FAIL**" }
        $det = Get-CleanDetail ([string]$r.detail)
        [void]$sb.AppendLine("| $mark | $($r.name) | $det |")
    }
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("**Synthese :** $($live.passed) succes, $($live.failed) echec(s) sur $($live.total).")
    [void]$sb.AppendLine("")
    if (Test-Path (Join-Path $here "player-state.json")) {
        [void]$sb.AppendLine("Snapshot complet de l'etat du player (firmware, NTP, stockages) : ``player-state.json``.")
        [void]$sb.AppendLine("")
    }
} else {
    [void]$sb.AppendLine("## 2. Validation live : NON EXECUTEE")
    [void]$sb.AppendLine("")
}

$report = [ordered]@{
    generatedAt = $stamp
    machine     = $machine
    node        = $nodeVer
    playerHost  = $PlayerHost
    offline     = $offline
    live        = $live
}

Save-Utf8 "REPORT.md" $sb.ToString()
Save-Utf8 "REPORT.json" ($report | ConvertTo-Json -Depth 10)

# --- console summary -----------------------------------------------------
Write-Host ""
Write-Host "============================================================"
if ($offline) {
    $col = if ($offline.failed -gt 0) { "Red" } else { "Green" }
    Write-Host "  Hors-ligne : $($offline.passed)/$($offline.total) OK, $($offline.failed) echec(s)" -ForegroundColor $col
} else {
    Write-Host "  Hors-ligne : NON EXECUTE" -ForegroundColor Red
}
if ($live) {
    $col = if ($live.failed -gt 0) { "Red" } else { "Green" }
    Write-Host "  Live       : $($live.passed)/$($live.total) OK, $($live.failed) echec(s)" -ForegroundColor $col
} elseif ($PlayerHost) {
    Write-Host "  Live       : NON EXECUTE" -ForegroundColor Red
} else {
    Write-Host "  Live       : ignore (pas de -Host)"
}
Write-Host "============================================================"

if ($offline -and $offline.failed -gt 0) {
    Write-Host ""
    Write-Host "Details des echecs hors-ligne :" -ForegroundColor Yellow
    foreach ($r in $offline.results) {
        if (-not $r.pass) { Write-Host "  [FAIL] $($r.name) : $($r.detail)" -ForegroundColor Red }
    }
}
if ($live -and $live.failed -gt 0) {
    Write-Host ""
    Write-Host "Details des echecs live :" -ForegroundColor Yellow
    foreach ($r in $live.results) {
        if (-not $r.pass) { Write-Host "  [FAIL] $($r.name) : $($r.detail)" -ForegroundColor Red }
    }
}

Write-Host ""
Write-Host "Compte rendu ecrit : REPORT.md et REPORT.json"
Write-Host "Transmettez REPORT.md (ou REPORT.json) pour analyse."
if (Test-Path (Join-Path $here "player-state.json")) {
    Write-Host "Transmettez aussi player-state.json (etat complet du player)."
}
Write-Host ""

# --- global exit code ----------------------------------------------------
$failCount = 0
if ($offline) { $failCount += [int]$offline.failed } else { $failCount += 1 }
if ($live) { $failCount += [int]$live.failed }

if ($failCount -gt 0) { exit 1 } else { exit 0 }
