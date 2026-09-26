#Requires -Version 7.0
# ============================================================================
# run-standup.ps1: запуск Коры (ИИ-ведущая стендапа) с логом, сторожем и алертами.
#
# Вручную (видимое окно pwsh; Ctrl+C = kill switch):
#   cd C:\Users\aleks\template\scripts\standup_host
#   .\run-standup.ps1 --verbose                        # по требованию: без расписания, начнёт по «Кора, начинай»
#   .\run-standup.ps1 --start 10:00 --verbose          # с расписанием: старт в 10:00, дедлайны сдвигаются
#   .\run-standup.ps1 --url <ссылка на тест-комнату> --at 09:58 --day mon --verbose
# Из планировщика (задача StandupHostKora, см. register-task.ps1):
#   pwsh -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File run-standup.ps1 -Scheduled
#
# Все аргументы, кроме ключей обёртки, уходят в node src\main.js как есть
# (--at, --day, --start, --shadow, --url, --verbose, --no-brain, --check).
# Без --start у хоста нет часов: таймеров 10:00/10:02/10:28/10:30/10:35 нет, старт — по
# просьбе по имени. Окна «только пн–чт 09:30–10:40» у хоста больше нет: --live разрешает
# бой в любое время (решение Сергея 21.09).
# Ключи обёртки (один дефис, регистр не важен):
#   -Scheduled         запуск планировщиком: хост стартует только пн–чт с -NotBefore по -NotAfter МСК
#   -NotBefore HH:MM   нижняя граница окна планового запуска (09:30)
#   -NotAfter HH:MM    позже этого ни запуск, ни перезапуск планировщика не стартуют (10:10)
#   -MaxMinutes N      сторож: хост работает дольше N минут и уже наступило -HardStop ->
#   -HardStop HH:MM    state\STOP, 20 с на выход, затем kill дерева процессов (50 и 10:45; 0 = без сторожа)
#   -NoAlert           не слать алерты в Telegram (тестовые прогоны)
# Без param(): pwsh привязал бы «--at» к первому позиционному параметру, а
# [CmdletBinding()] съел бы «-v» как -Verbose. Поэтому ключи разбираем сами.
#
# По шагам:
#   1. (-Scheduled) проверка дня и окна запуска; вне окна выход 0 (после -NotAfter в пн–чт ещё и DM)
#   2. один экземпляр: mutex + поиск уже запущенного хоста; второй не стартует
#   3. снимает state\STOP от прошлого запуска (иначе Кора замолчала бы сразу)
#   4. запускает node src\main.js; вывод идёт в консоль и в
#      %USERPROFILE%\sync\logs\standup_YYYY-MM-DD.txt (UTF-8, строки хоста с временем МСК)
#   5. при сбое шлёт DM через node src\ops\telegram.js (ключ читает только Node);
#      в DM только код выхода, строка fatal: и путь к логу, транскрипт никогда
#
# Коды выхода:
#   0    хост завершился штатно, или плановый запуск пропущен (не пн–чт / вне окна)
#   N    иначе код хоста как есть: 1 ошибка или не готов, 64 неверные флаги
#   20   хост не запустить (нет node.exe или src\main.js, ошибка старта) или сбой самой обёртки
#   21   сторож: хост работал слишком долго и был остановлен
#   22   Кора уже запущена, второй экземпляр не стартует
#   64   неверные ключи обёртки
#   130  хост вышел по Ctrl+C
#   Ctrl+C получают и pwsh, и node: обёртка ждёт выхода хоста до 10 с (дочитывая
#   его вывод), потом завершает дерево процессов. Код выхода тогда ставит сам pwsh.
# ============================================================================

$ErrorActionPreference = 'Stop'

$AppDir    = $PSScriptRoot
$MainJs    = Join-Path $AppDir 'src\main.js'
$AlertJs   = Join-Path $AppDir 'src\ops\telegram.js'
$StopFile  = Join-Path $AppDir 'state\STOP'            # = STOP_FILE в src\config.js
$LogDir    = Join-Path $env:USERPROFILE 'sync\logs'
$Utf8      = [System.Text.UTF8Encoding]::new($false)
$MskOffset = [TimeSpan]::FromHours(3)                  # Москва: UTC+3 круглый год (как src\clock.js)
$HHMM      = '^([01]\d|2[0-3]):[0-5]\d$'

$script:LogWriter = $null
$script:LogPath   = $null
$script:NodeExe   = $null
$script:NoAlert   = $false
$script:LastFatal = $null
$script:ExitCode  = 0
$script:Finished  = $false
$script:Pending   = @{}                                # поток хоста (out/err) -> ожидающий ReadLineAsync
$script:Readers   = @{}

function Get-MskNow { [DateTimeOffset]::UtcNow.ToOffset($MskOffset) }

function Get-MskToday([string]$HhMm) {
    $now = Get-MskNow
    $h, $m = $HhMm.Split(':')
    [DateTimeOffset]::new($now.Year, $now.Month, $now.Day, [int]$h, [int]$m, 0, $MskOffset)
}

# Строка самой обёртки: консоль + файл.
function Write-Run([string]$Message) {
    $line = '{0} [run-standup] {1}' -f (Get-MskNow).ToString('HH:mm:ss'), $Message
    Write-Host $line
    if ($script:LogWriter) { try { $script:LogWriter.WriteLine($line) } catch { } }
}

# Строка хоста: в консоль как есть, в файл с временем МСК.
function Write-HostOutput([string]$Line) {
    Write-Host $Line
    if ($Line -match '^fatal:') { $script:LastFatal = $Line.Substring(0, [Math]::Min($Line.Length, 200)) }
    if ($script:LogWriter) { try { $script:LogWriter.WriteLine(('{0} {1}' -f (Get-MskNow).ToString('HH:mm:ss'), $Line)) } catch { } }
}

# Выход с кодом; блок finally ниже всё равно отработает.
function Exit-Run([int]$Code, [string]$Message) {
    if ($Message) { Write-Run $Message }
    $script:ExitCode = $Code
    $script:Finished = $true
    exit $Code
}

function Send-Alert([string]$Level, [string]$Text) {
    if ($script:NoAlert) { Write-Run "алерт не отправлен (-NoAlert): [$Level] $Text"; return }
    if (-not $script:NodeExe -or -not (Test-Path -LiteralPath $AlertJs)) {
        Write-Run 'алерт не отправлен: нет node.exe или src\ops\telegram.js'
        return
    }
    $ErrorActionPreference = 'Continue'
    try {
        foreach ($line in @(& $script:NodeExe $AlertJs --level $Level $Text 2>&1)) { Write-Run "$line" }
    } catch {
        Write-Run "алерт не отправлен: $($_.Exception.Message)"
    }
}

# Хост, запущенный этой обёрткой: в командной строке node полный путь к src\main.js.
function Get-HostProcess {
    @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($MainJs, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}

function Stop-HostTree([System.Diagnostics.Process]$Process) {
    try { $Process.Kill($true) } catch { Write-Run "не удалось завершить хост: $($_.Exception.Message)" }
}

# Забирает готовые строки хоста, ждёт не дольше WaitMs. Открытых потоков нет: просто пауза.
function Receive-HostOutput([int]$WaitMs) {
    if ($script:Pending.Count -eq 0) { Start-Sleep -Milliseconds $WaitMs; return }
    $null = [System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]@($script:Pending.Values), $WaitMs)
    foreach ($key in @($script:Pending.Keys)) {
        $task = $script:Pending[$key]
        if (-not $task.IsCompleted) { continue }
        $line = $null
        try { $line = $task.Result } catch { }
        if ($null -eq $line) {
            $script:Pending.Remove($key)
        } else {
            Write-HostOutput $line
            $script:Pending[$key] = $script:Readers[$key].ReadLineAsync()
        }
    }
}

function Format-Age([TimeSpan]$Age) {
    if ($Age.TotalHours -ge 1) { return ('{0:0.#} ч' -f $Age.TotalHours) }
    return ('{0:0} мин' -f $Age.TotalMinutes)
}

# --- ключи обёртки ------------------------------------------------------------
$script:Scheduled = $false
$NotBefore  = '09:30'
$NotAfter   = '10:10'
$HardStop   = '10:45'
$MaxMinutes = 50.0
$NodeArgs   = [System.Collections.Generic.List[string]]::new()
$usageError = $null
$raw = @($args)
for ($i = 0; $i -lt $raw.Count; $i++) {
    $arg = [string]$raw[$i]
    switch ($arg) {
        '-Scheduled'  { $script:Scheduled = $true }
        '-NoAlert'    { $script:NoAlert = $true }
        '-NotBefore'  { $i++; $NotBefore = [string]$raw[$i] }
        '-NotAfter'   { $i++; $NotAfter = [string]$raw[$i] }
        '-HardStop'   { $i++; $HardStop = [string]$raw[$i] }
        '-MaxMinutes' {
            $i++
            $value = 0.0
            if ([double]::TryParse([string]$raw[$i], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$value) -and $value -ge 0) {
                $MaxMinutes = $value
            } else {
                $usageError = "-MaxMinutes: нужно число минут >= 0, получено '$($raw[$i])'"
            }
        }
        default { $NodeArgs.Add($arg) }
    }
}
foreach ($pair in @(@('-NotBefore', $NotBefore), @('-NotAfter', $NotAfter), @('-HardStop', $HardStop))) {
    if ($pair[1] -notmatch $HHMM) { $usageError = "$($pair[0]): нужно HH:MM, получено '$($pair[1])'" }
}
# Диагностика (--check/--help) падением не считается: алерт не шлём.
$diagnostic = @($NodeArgs | Where-Object { $_ -in '--check', '--help', '-h' }).Count -gt 0

# --- запуск ---------------------------------------------------------------------
$mutex     = $null
$ownsMutex = $false
$proc      = $null
$oldTitle  = $null
try {
    try {
        $null = New-Item -ItemType Directory -Force -Path $LogDir
        $script:LogPath = Join-Path $LogDir ('standup_{0}.txt' -f (Get-MskNow).ToString('yyyy-MM-dd'))
        $stream = [System.IO.FileStream]::new($script:LogPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        $script:LogWriter = [System.IO.StreamWriter]::new($stream, $Utf8)
        $script:LogWriter.AutoFlush = $true
    } catch {
        $script:LogPath = $null
        Write-Host "run-standup: лог-файл недоступен ($($_.Exception.Message)), пишу только в консоль"
    }
    try {
        $oldTitle = $Host.UI.RawUI.WindowTitle
        $Host.UI.RawUI.WindowTitle = 'Кора: стендап (Ctrl+C = стоп)'
    } catch { }

    $hostArgsText = if ($NodeArgs.Count) { $NodeArgs -join ' ' } else { '(нет)' }
    Write-Run ('=== старт {0} МСК, {1}, аргументы хоста: {2}' -f (Get-MskNow).ToString('yyyy-MM-dd HH:mm:ss'), $(if ($script:Scheduled) { 'по расписанию' } else { 'вручную' }), $hostArgsText)
    if ($usageError) { Exit-Run 64 "ОШИБКА: $usageError" }

    $script:NodeExe = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $script:NodeExe) {
        $candidate = Join-Path $env:ProgramFiles 'nodejs\node.exe'
        if (Test-Path -LiteralPath $candidate) { $script:NodeExe = $candidate }
    }

    # 1. окно планового запуска
    if ($script:Scheduled) {
        $now = Get-MskNow
        $hm = $now.ToString('HH:mm')
        $weekday = [int]$now.DayOfWeek                 # 0 = воскресенье
        if ($weekday -lt 1 -or $weekday -gt 4) {
            Exit-Run 0 ('плановый запуск пропущен: сегодня {0}, стендап только пн–чт' -f $now.ToString('dddd', [Globalization.CultureInfo]::GetCultureInfo('ru-RU')))
        }
        if ($hm -lt $NotBefore -or $hm -gt $NotAfter) {
            Write-Run "плановый запуск пропущен: $hm МСК вне окна $NotBefore–$NotAfter"
            if ($hm -gt $NotAfter) {
                Send-Alert 'warn' "не вышла на стендап: плановый запуск пришёл только в $hm МСК, позже $NotAfter (компьютер спал или был выключен?)."
            }
            Exit-Run 0
        }
    }

    # 2. один экземпляр
    $mutex = [System.Threading.Mutex]::new($false, 'Local\StandupHostKora')
    try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { Exit-Run 22 'Кора уже запущена другим run-standup.ps1, второй экземпляр не стартует' }
    $running = @(Get-HostProcess)
    if ($running.Count) {
        Exit-Run 22 ('хост уже работает (PID {0}), второй экземпляр не стартует. Остановить: .\stop-standup.ps1 -Kill' -f ($running.ProcessId -join ', '))
    }

    # 3. флаг от прошлого запуска
    if (Test-Path -LiteralPath $StopFile) {
        try {
            $age = (Get-Date) - (Get-Item -LiteralPath $StopFile).LastWriteTime
            Remove-Item -LiteralPath $StopFile -Force
            Write-Run ('снят флаг state\STOP от прошлого запуска (ему {0})' -f (Format-Age $age))
        } catch {
            Write-Run "ВНИМАНИЕ: не удалось снять state\STOP ($($_.Exception.Message)), Кора может сразу замолчать"
        }
    }

    # 4. хост
    if (-not $script:NodeExe) { Exit-Run 20 'ОШИБКА: node.exe не найден (PATH, Program Files\nodejs)' }
    if (-not (Test-Path -LiteralPath $MainJs)) { Exit-Run 20 "ОШИБКА: нет $MainJs" }
    $psi = [System.Diagnostics.ProcessStartInfo]::new($script:NodeExe)
    $psi.ArgumentList.Add($MainJs)
    foreach ($arg in $NodeArgs) { $psi.ArgumentList.Add($arg) }
    $psi.WorkingDirectory = $AppDir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $Utf8
    $psi.StandardErrorEncoding = $Utf8
    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
    } catch {
        $reason = $_.Exception.Message
        Write-Run "ОШИБКА запуска node: $reason"
        if (-not $diagnostic) { Send-Alert 'error' "не запустилась: ошибка старта node ($reason). Лог: $($script:LogPath)" }
        Exit-Run 20
    }
    $started = Get-Date
    $startedMsk = Get-MskNow
    $script:Readers = @{ out = $proc.StandardOutput; err = $proc.StandardError }
    foreach ($key in @($script:Readers.Keys)) { $script:Pending[$key] = $script:Readers[$key].ReadLineAsync() }
    Write-Run "хост запущен: PID $($proc.Id), события пишутся в logs\standup_$($startedMsk.ToString('yyyy-MM-dd')).jsonl"

    # 5. вывод хоста + сторож
    $deadline = [datetime]::MaxValue
    if ($MaxMinutes -gt 0) {
        $deadline = $started.AddMinutes($MaxMinutes)
        $hardStopLocal = (Get-MskToday $HardStop).LocalDateTime
        if ($hardStopLocal -gt $deadline) { $deadline = $hardStopLocal }
    }
    $watchdog = $false
    $killAt = [datetime]::MaxValue
    $exitedAt = $null
    while ($true) {
        Receive-HostOutput 200
        $now = Get-Date
        if ($proc.HasExited) {
            if ($script:Pending.Count -eq 0) { break }
            if ($null -eq $exitedAt) { $exitedAt = $now }
            elseif (($now - $exitedAt).TotalSeconds -ge 3) { break }   # поток держит внук: не ждём вечно
            continue
        }
        if (-not $watchdog -and $now -ge $deadline) {
            $watchdog = $true
            $killAt = $now.AddSeconds(20)
            Write-Run ('сторож: хост работает с {0} МСК, это дольше лимита. Ставлю state\STOP и жду выхода 20 с' -f $startedMsk.ToString('HH:mm'))
            try {
                $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StopFile)
                Set-Content -LiteralPath $StopFile -Value ('{0} run-standup.ps1 watchdog' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding utf8
            } catch {
                Write-Run "сторож: не удалось создать state\STOP ($($_.Exception.Message))"
            }
        } elseif ($watchdog -and $now -ge $killAt) {
            $killAt = [datetime]::MaxValue
            Write-Run 'сторож: хост не вышел, завершаю дерево процессов'
            Stop-HostTree $proc
        }
    }
    $proc.WaitForExit()

    # 6. итог
    $hostCode = $proc.ExitCode
    $elapsed = (Get-Date) - $started
    $ran = '{0}:{1:00}' -f [int][Math]::Floor($elapsed.TotalMinutes), $elapsed.Seconds
    Write-Run "хост завершился: код $hostCode, работал $ran"
    if ($watchdog) { $script:ExitCode = 21 }
    elseif ($hostCode -eq 130 -or $hostCode -eq -1073741510) { $script:ExitCode = 130 }   # SIGINT / STATUS_CONTROL_C_EXIT
    else { $script:ExitCode = $hostCode }
    if ($script:ExitCode -notin 0, 64, 130 -and -not $diagnostic) {
        $what = if ($script:ExitCode -eq 21) { 'сторож остановил хост, он работал дольше лимита' } else { "хост завершился с кодом $hostCode" }
        $fatal = if ($script:LastFatal) { " $($script:LastFatal)." } else { '' }
        $logText = if ($script:LogPath) { $script:LogPath } else { 'только консоль' }
        Send-Alert 'error' ('сбой: {0} (старт {1} МСК, работала {2}).{3} Лог: {4}' -f $what, $startedMsk.ToString('HH:mm'), $ran, $fatal, $logText)
    }
    Write-Run "=== конец, код выхода $($script:ExitCode)"
    $script:Finished = $true
} catch {
    $script:ExitCode = 20
    $script:Finished = $true
    Write-Run "ОШИБКА обёртки: $($_.Exception.Message)"
    if (-not $diagnostic) { Send-Alert 'error' "сбой обёртки run-standup.ps1: $($_.Exception.Message). Лог: $($script:LogPath)" }
} finally {
    if ($proc) {
        if (-not $proc.HasExited) {
            Write-Run 'прерывание: жду выхода хоста до 10 с'
            $until = (Get-Date).AddSeconds(10)
            while (-not $proc.HasExited -and (Get-Date) -lt $until) { Receive-HostOutput 200 }
            if (-not $proc.HasExited) {
                Write-Run 'хост не вышел за 10 с, завершаю дерево процессов'
                Stop-HostTree $proc
            }
        }
        $until = (Get-Date).AddSeconds(2)
        while ($script:Pending.Count -and (Get-Date) -lt $until) { Receive-HostOutput 100 }
        $proc.Dispose()
    }
    if (-not $script:Finished) { Write-Run '=== прервано (Ctrl+C)' }
    if ($mutex) {
        if ($ownsMutex) { try { $mutex.ReleaseMutex() } catch { } }
        $mutex.Dispose()
    }
    if ($null -ne $oldTitle) { try { $Host.UI.RawUI.WindowTitle = $oldTitle } catch { } }
    if ($script:LogWriter) { try { $script:LogWriter.Dispose() } catch { } }
}
exit $script:ExitCode
