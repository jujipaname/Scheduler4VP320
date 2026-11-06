# run-tests.ps1 — Exécute les tests Scheduler4VP320 et produit un compte rendu.
#
# Sur une machine réelle reliée au player (Windows 10, Node.js installé) :
#   - Test hors-ligne (test-runner.js) : roundtrip TM2, moteur, MD5/Digest.
#   - Validation live (validate-player.js) : REST Digest + FTP vers le player.
#
# Usage (PowerShell) :
#   .\run-tests.ps1 -Host 192.168.1.100 -User admin -Pass votreMdp [-Upload] [-FtpPort 21]
#
# Sans -Host : seule la partie hors-ligne est exécutée.
#
# Sorties :
#   REPORT.md / REPORT.json  : compte rendu consolidé (à transmettre)
#   report.json              : détail hors-ligne
#   report-live.json         : détail live

param(
    [Alias("Host")][string]$PlayerHost = "",
    [string]$User = "admin",
    [string]$Pass = "",
    [switch]$Upload,
    [int]$FtpPort = 21
)

$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$report = [ordered]@{
    generatedAt = $stamp
    machine      = [string](Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Caption)
    node         = ""
    playerHost   = $PlayerHost
    offline      = @{}
    live         = $null
}

Write-Host ""
Write-Host "============================================================"
Write-Host "  Scheduler4VP320 — Tests (hors-ligne + live)"
Write-Host "============================================================"

# --- prérequis : Node.js -------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "[ERREUR] Node.js introuvable. Installez-le depuis https://nodejs.org puis relancez." -ForegroundColor Red
    Write-Host "         Recommandé : v18 ou plus (fetch natif)."
    exit 1
}
$nodeVer = (& node --version).Trim()
$report.node = $nodeVer
Write-Host "[OK] Node.js : $nodeVer"

# --- 1) tests hors-ligne -------------------------------------------------
Write-Host ""
Write-Host "--- 1) Suite hors-ligne (test-runner.js) ---"
& node test-runner.js
$offExit = $LASTEXITCODE
if (Test-Path "report.json") {
    $report.offline = (Get-Content "report.json" -Raw | ConvertFrom-Json)
} else {
    $report.offline = $null
    Write-Host "[ERREUR] report.json non produit par test-runner.js" -ForegroundColor Red
}

# --- 2) validation live (optionnel) --------------------------------------
if ($PlayerHost) {
    Write-Host ""
    Write-Host "--- 2) Validation live du player $PlayerHost ---"
    $vpArgs = @(
        "--host=$PlayerHost",
        "--user=$User",
        "--pass=$Pass",
        "--ftp-port=$FtpPort",
        "--out=report-live.json"
    )
    if ($Upload) { $vpArgs += "--upload=1" }
    & node validate-player.js $vpArgs
    $liveExit = $LASTEXITCODE
    if (Test-Path "report-live.json") {
        $report.live = (Get-Content "report-live.json" -Raw | ConvertFrom-Json)
    } else {
        Write-Host "[ERREUR] report-live.json non produit" -ForegroundColor Red
    }
} else {
    Write-Host ""
    Write-Host "--- 2) Validation live ignorée (pas de -Host) ---"
}

# --- 3) rapport consolidé ------------------------------------------------
Write-Host ""
Write-Host "--- 3) Génération de REPORT.md / REPORT.json ---"

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("# Compte rendu Scheduler4VP320")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("- Date : **$stamp**")
[void]$sb.AppendLine("- Machine : **$($report.machine)**")
[void]$sb.AppendLine("- Node.js : **$($report.node)**")
[void]$sb.AppendLine("- Player ciblé : **$($PlayerHost)**")
[void]$sb.AppendLine("")

# offline
$off = $report.offline
if ($off) {
    [void]$sb.AppendLine("## 1. Tests hors-ligne")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("| Résultat | Test | Détail |")
    [void]$sb.AppendLine("|---|---|---|")
    foreach ($r in $off.results) {
        $mark = if ($r.pass) { "PASS" } else { "**FAIL**" }
        $det = ($r.detail -replace "\|", "\|" -replace "`n", " ")
        [void]$sb.AppendLine("| $mark | $($r.name) | $det |")
    }
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("**Synthèse :** $($off.passed) succès, $($off.failed) échec(s) sur $($off.total).")
    [void]$sb.AppendLine("")
} else {
    [void]$sb.AppendLine("## 1. Tests hors-ligne : NON EXÉCUTÉS")
    [void]$sb.AppendLine("")
}

# live
$live = $report.live
if ($live) {
    [void]$sb.AppendLine("## 2. Validation live du player")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("| Résultat | Test | Détail |")
    [void]$sb.AppendLine("|---|---|---|")
    foreach ($r in $live.results) {
        $mark = if ($r.pass) { "PASS" } else { "**FAIL**" }
        $det = ($r.detail -replace "\|", "\|" -replace "`n", " ")
        [void]$sb.AppendLine("| $mark | $($r.name) | $det |")
    }
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("**Synthèse :** $($live.passed) succès, $($live.failed) échec(s) sur $($live.total).")
    [void]$sb.AppendLine("")
} else {
    [void]$sb.AppendLine("## 2. Validation live : NON EXÉCUTÉE")
    [void]$sb.AppendLine("")
}

Set-Content -Path "REPORT.md" -Value $sb.ToString() -Encoding UTF8
$report | ConvertTo-Json -Depth 10 | Set-Content -Path "REPORT.json" -Encoding UTF8

Write-Host ""
Write-Host "Compte rendu écrit : REPORT.md et REPORT.json"
Write-Host "Transmettez REPORT.md (ou REPORT.json) pour analyse."
Write-Host ""

# code retour global
$offFail = if ($off) { $off.failed } else { 1 }
$liveFail = if ($live) { $live.failed } else { 0 }
if ($offFail -gt 0 -or $liveFail -gt 0) { exit 1 } else { exit 0 }
