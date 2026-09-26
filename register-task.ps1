# ============================================================================
# register-task.ps1: задача планировщика «StandupHostKora», чтобы Кора вела стендап сама.
#
# Регистрация меняет систему надолго, поэтому только с явного OK Сергея.
#   .\register-task.ps1 -WhatIf                 показать задачу, ничего не менять
#   .\register-task.ps1                         зарегистрировать (или заменить)
#   .\register-task.ps1 -HostArgs '--shadow'    первые дни: заходит, слушает, молчит
#   .\register-task.ps1 -Unregister [-WhatIf]   удалить
#
# Задача: пн–чт в 09:55 МСК (время с +03:00, «синхронизировать между часовыми
# поясами»), от текущего пользователя, только когда он вошёл в систему (без
# сохранённого пароля, окно Chrome есть где открыть), StartWhenAvailable
# (пропущенный запуск догоняется), на батарее тоже, один экземпляр (IgnoreNew),
# приоритет Normal: по умолчанию задачи идут с Below Normal, а node и Chrome его
# наследуют, это лишний риск для звука в реальном времени. Лимит 2 ч: сторож
# run-standup.ps1 (10:45) срабатывает раньше и выходит аккуратно, а планировщик
# убил бы только pwsh.
# Действие: pwsh -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden
#           -File run-standup.ps1 -Scheduled [HostArgs]
# Позже 10:10 ничего не стартует: суточного окна запуска у планировщика нет, его
# держит run-standup.ps1 -Scheduled (-NotBefore 09:30 / -NotAfter 10:10). Перезапуск
# при сбое запуска: 2 раза через 1 мин; всё, что придётся позже 10:10, обёртка пропустит.
# ============================================================================
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Удалить задачу вместо регистрации.
    [switch]$Unregister,

    # Время запуска, МСК.
    [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')]
    [string]$At = '09:55',

    # Дописать в командную строку run-standup.ps1, например '--shadow' или '-NotAfter','10:05'.
    [string[]]$HostArgs = @(),

    [string]$TaskName = 'StandupHostKora'
)

$ErrorActionPreference = 'Stop'

$AppDir    = $PSScriptRoot
$RunScript = Join-Path $AppDir 'run-standup.ps1'
$Msk       = [TimeSpan]::FromHours(3)             # Москва: UTC+3 круглый год

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($Unregister) {
    if (-not $existing) {
        Write-Host "Задачи «$TaskName» нет, удалять нечего."
        return
    }
    if ($PSCmdlet.ShouldProcess($TaskName, 'Удалить задачу планировщика')) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Задача «$TaskName» удалена."
    }
    return
}

if (-not (Test-Path -LiteralPath $RunScript)) { throw "нет $RunScript" }
$pwsh = (Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $pwsh) { throw 'pwsh.exe (PowerShell 7) не найден, а run-standup.ps1 требует PowerShell 7' }

function ConvertTo-Arg([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '"', '\"') + '"'
}
$argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"{0}"' -f $RunScript), '-Scheduled')
$argList += @($HostArgs | ForEach-Object { ConvertTo-Arg $_ })
$argLine = $argList -join ' '
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $argLine -WorkingDirectory $AppDir

# Первый запуск: ближайшие At МСК в будущем. Граница в прошлом вместе со
# StartWhenAvailable планировщик может счесть пропущенным запуском и стартовать сразу.
$nowMsk = [DateTimeOffset]::UtcNow.ToOffset($Msk)
$hour, $minute = $At.Split(':') | ForEach-Object { [int]$_ }
$first = [DateTimeOffset]::new($nowMsk.Year, $nowMsk.Month, $nowMsk.Day, $hour, $minute, 0, $Msk)
if ($first -le $nowMsk) { $first = $first.AddDays(1) }
$trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Monday, Tuesday, Wednesday, Thursday -At $first.LocalDateTime
$trigger.StartBoundary = $first.ToString('yyyy-MM-ddTHH:mm:sszzz')   # +03:00: синхронизация между часовыми поясами

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 1) -Priority 4

$description = 'Кора, ИИ-ведущая стендапа Acme (scripts\standup_host). Пн–чт 09:55 МСК, позже 10:10 не стартует. ' +
    'Остановить: stop-standup.ps1 (-Kill). Удалить: register-task.ps1 -Unregister. Документация: docs\ops.md.'
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description

Write-Host "Задача «$TaskName»$(if ($existing) { ' (уже есть, будет заменена)' } else { '' }):"
Write-Host ("  когда      пн–чт {0} МСК, первый запуск {1} МСК; пропущенный запуск догоняется; окно старта 09:30–10:10 держит run-standup.ps1" -f $At, $first.ToString('yyyy-MM-dd HH:mm'))
Write-Host "  кто        $userId, только когда пользователь вошёл в систему; права обычные"
Write-Host "  действие   $pwsh $argLine"
Write-Host "  папка      $AppDir"
Write-Host '  настройки  один экземпляр (IgnoreNew), приоритет Normal (4), на батарее тоже, лимит 2 ч, перезапуск 2 раза через 1 мин'

if ($PSCmdlet.ShouldProcess($TaskName, 'Зарегистрировать задачу планировщика')) {
    $null = Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Зарегистрирована. Следующий запуск: $($info.NextRunTime)"
    Write-Host "Проверка без ожидания: Start-ScheduledTask -TaskName $TaskName (вне окна 09:30–10:10 run-standup.ps1 просто запишет пропуск в лог)"
}
