param(
    [switch]$LegacyNestedStartProcess
)

$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'ProcessJob.cs')

$powershell = Join-Path $PSHOME 'powershell.exe'
$unrelatedEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('Start-Sleep -Seconds 30'))
$unrelatedInfo = New-Object System.Diagnostics.ProcessStartInfo
$unrelatedInfo.FileName = $powershell
$unrelatedInfo.Arguments = "-NoProfile -EncodedCommand $unrelatedEncoded"
$unrelatedInfo.UseShellExecute = $false
$unrelatedInfo.CreateNoWindow = $true
$childEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('Start-Sleep -Seconds 30'))
if ($LegacyNestedStartProcess) {
    $mockCommand = "`$child = Start-Process -FilePath '$powershell' -ArgumentList '-NoProfile -EncodedCommand $childEncoded' -PassThru; [Console]::WriteLine('Mock stdout'); [Console]::Error.WriteLine('Mock stderr'); [Console]::WriteLine('CHILD_PID=' + `$child.Id); Start-Sleep -Seconds 30"
} else {
    $mockCommand = "`$childInfo = New-Object System.Diagnostics.ProcessStartInfo; `$childInfo.FileName = '$powershell'; `$childInfo.Arguments = '-NoProfile -EncodedCommand $childEncoded'; `$childInfo.UseShellExecute = `$false; `$childInfo.CreateNoWindow = `$true; `$child = [System.Diagnostics.Process]::Start(`$childInfo); [Console]::WriteLine('Mock stdout'); [Console]::Error.WriteLine('Mock stderr'); [Console]::WriteLine('CHILD_PID=' + `$child.Id); Start-Sleep -Seconds 30"
}
$encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($mockCommand))
$arguments = "-NoLogo -NoProfile -EncodedCommand $encodedCommand"
$session = $null
$unrelated = $null

try {
    $missingExecutable = Join-Path $env:TEMP ('moviestream-missing-' + [Guid]::NewGuid().ToString('N') + '.exe')
    try {
        [void][MovieStream.Controller.ProcessJob]::Launch($missingExecutable, '', $env:TEMP)
        throw 'A missing executable unexpectedly launched.'
    } catch [System.ComponentModel.Win32Exception] {
        if ($_.Exception.Message -notmatch 'CreateProcessW failed for the suspended launcher') { throw }
        Write-Host "PASS: CreateProcessW failure reports native error $($_.Exception.NativeErrorCode) ($($_.Exception.Message))."
    }

    $unrelated = [System.Diagnostics.Process]::Start($unrelatedInfo)
    $session = [MovieStream.Controller.ProcessJob]::Launch($powershell, $arguments, $env:TEMP)
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    $captured = New-Object System.Collections.Generic.List[string]
    $childPid = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        foreach ($line in $session.DrainLogs()) { $captured.Add($line) }
        foreach ($line in $captured) {
            if ($line -match 'CHILD_PID=(\d+)') { $childPid = [int]$matches[1] }
        }
        if (($captured -match 'Mock stdout') -and ($captured -match 'Mock stderr') -and $null -ne $childPid) {
            break
        }
        Start-Sleep -Milliseconds 50
    }
    if (-not ($captured -match 'Mock stdout')) { throw "Mock stdout was not captured. Output: $($captured -join ' | ')" }
    if (-not ($captured -match 'Mock stderr')) { throw "Mock stderr was not captured. Output: $($captured -join ' | ')" }
    if ($null -eq $childPid) { throw "The mock child process ID was not reported. Output: $($captured -join ' | ')" }
    if (-not (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) {
        throw 'The mock descendant was not running inside the test job.'
    }
    if ($session.IsExited) { throw 'Mock process exited before the job cleanup test.' }

    $session.Dispose()
    if (-not $session.IsExited) { throw 'The owned mock process survived Job Object disposal.' }
    if ($unrelated.HasExited) { throw 'The unrelated PowerShell process was terminated with the controller job.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ((Get-Process -Id $childPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 50
    }
    if (Get-Process -Id $childPid -ErrorAction SilentlyContinue) {
        throw "The owned descendant process $childPid survived Job Object disposal."
    }
    $mode = if ($LegacyNestedStartProcess) { 'legacy nested Start-Process' } else { 'direct UseShellExecute=false spawn' }
    Write-Host "PASS: $mode; stdout/stderr capture, owned parent/descendant cleanup, unrelated-process isolation."
} finally {
    if ($null -ne $session) { $session.Dispose() }
    if ($null -ne $unrelated) {
        if (-not $unrelated.HasExited) {
            $unrelated.Kill()
            $unrelated.WaitForExit(5000) | Out-Null
        }
        $unrelated.Dispose()
    }
}
