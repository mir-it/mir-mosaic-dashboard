$ErrorActionPreference = 'Stop'
$taskConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
$taskServerPath = (Join-Path $PSScriptRoot 'server.mjs').Replace('\', '/')
$taskConnections = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $taskConfig.port -State Listen -ErrorAction SilentlyContinue
foreach ($taskConnection in $taskConnections) {
    $taskProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $taskConnection.OwningProcess)
    $taskCommand = ([string]$taskProcess.CommandLine).Replace('\', '/')
    if ($taskProcess.Name -eq 'node.exe' -and $taskCommand.IndexOf($taskServerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Stop-Process -Id $taskConnection.OwningProcess
        Write-Output 'Mira monitoring stopped.'
    } else {
        Write-Output 'The port belongs to an unverified process. It was left running.'
    }
}
