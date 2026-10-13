$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskConfig = Get-Content -LiteralPath (Join-Path $taskRoot 'config.json') -Raw | ConvertFrom-Json
$taskUrl = 'http://127.0.0.1:' + $taskConfig.port
try {
    $taskExisting = Invoke-RestMethod -Uri ($taskUrl + '/api/snapshot') -TimeoutSec 2
    if ($taskExisting.company -eq $taskConfig.company) { Start-Process $taskUrl; exit }
} catch {}
$taskNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $taskNode) { $taskNode = 'C:\Users\IT MIR\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $taskNode)) { throw 'Node.js is required to start the separate dashboard.' }
Start-Process -FilePath $taskNode -ArgumentList ('"' + (Join-Path $taskRoot 'server.mjs') + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden
for ($taskAttempt = 0; $taskAttempt -lt 20; $taskAttempt++) {
    Start-Sleep -Milliseconds 750
    try {
        $taskReady = Invoke-RestMethod -Uri ($taskUrl + '/api/snapshot') -TimeoutSec 2
        if ($taskReady.company -eq $taskConfig.company) { Start-Process $taskUrl; exit }
    } catch {}
}
throw 'Dashboard did not become ready. Run node server.mjs in this folder to see the error.'
