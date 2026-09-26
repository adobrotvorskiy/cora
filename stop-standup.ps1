# ============================================================================
# stop-standup.ps1: kill switch Коры через файл state\STOP.
#
#   .\stop-standup.ps1          создать флаг: Кора замолкает (silent mode) за 1 с, дальше ведёт человек
#   .\stop-standup.ps1 -Kill    флаг, и если хост не вышел за -GraceSeconds (10 с), завершить
#                               его процессы (node + Chrome). Для скрытого запуска из планировщика,
#                               где нет окна для Ctrl+C.
#
# Флаг действует на текущий запуск: следующий run-standup.ps1 снимет его сам.
# Работает и в pwsh 7, и в Windows PowerShell 5.1.
# Коды выхода: 0 флаг создан (и хост остановлен, если просили), 1 флаг создать не удалось.
# ============================================================================
param(
    [switch]$Kill,
    [int]$GraceSeconds = 10
)

$ErrorActionPreference = 'Continue'

$AppDir   = $PSScriptRoot
$StateDir = Join-Path $AppDir 'state'
$StopFile = Join-Path $StateDir 'STOP'        # = STOP_FILE в src\config.js
$MainJs   = Join-Path $AppDir 'src\main.js'

# Хост, запущенный через run-standup.ps1: в командной строке node полный путь к src\main.js.
function Get-HostProcess {
    @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($MainJs, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
try {
    $null = New-Item -ItemType Directory -Force -Path $StateDir -ErrorAction Stop
    Set-Content -LiteralPath $StopFile -Value "$stamp stop-standup.ps1 ($env:USERNAME)" -Encoding UTF8 -ErrorAction Stop
} catch {
    Write-Host "ОШИБКА: флаг не создан: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Остановить иначе: Ctrl+C в окне run-standup.ps1 или голосом «Кора, стоп».'
    exit 1
}
Write-Host "Флаг создан: $StopFile ($stamp)"

$hosts = @(Get-HostProcess)
if ($hosts.Count -eq 0) {
    Write-Host 'Хост сейчас не запущен. Флаг полежит, следующий run-standup.ps1 его снимет.'
    exit 0
}
Write-Host ('Хост работает (PID {0}): Кора замолчит в течение 1 с.' -f (($hosts | ForEach-Object { $_.ProcessId }) -join ', '))
if (-not $Kill) {
    Write-Host 'Процесс не трогаю. Завершить совсем: .\stop-standup.ps1 -Kill (или Ctrl+C в окне run-standup.ps1).'
    exit 0
}

Write-Host "Жду выхода хоста до $GraceSeconds с..."
$deadline = (Get-Date).AddSeconds($GraceSeconds)
while ((Get-Date) -lt $deadline -and @(Get-HostProcess).Count -gt 0) { Start-Sleep -Milliseconds 250 }

# Заново по командной строке: PID мог освободиться и достаться чужому процессу.
$left = @(Get-HostProcess)
if ($left.Count -eq 0) {
    Write-Host 'Хост вышел сам.'
    exit 0
}
foreach ($p in $left) {
    $out = & taskkill.exe /PID $p.ProcessId /T /F 2>&1
    Write-Host "Завершён PID $($p.ProcessId) вместе с дочерними процессами (Chrome): $(($out | Out-String).Trim())"
}
exit 0
