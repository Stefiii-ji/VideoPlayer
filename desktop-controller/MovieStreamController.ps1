param(
    [switch]$Mock
)

$ErrorActionPreference = 'Stop'
$projectRoot = 'D:\My Code\MovieStream'
$serverPort = 5000
$clientPort = 5173
$mockClientPort = 5174
$startupTimeoutSeconds = 90

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'package.json') -PathType Leaf)) {
    [System.Windows.Forms.MessageBox]::Show(
        "MovieStream project was not found at:`r`n$projectRoot",
        'MovieStream Controller',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}

Add-Type -Path (Join-Path $PSScriptRoot 'ProcessJob.cs')
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:session = $null
$script:state = 'Stopped'
$script:probeBusy = $false
$script:probeBackend = $false
$script:probeFrontend = $false
$script:startedAt = $null
$script:failureMessage = ''
$script:shutdownFailed = $false
$script:closing = $false

$form = New-Object System.Windows.Forms.Form
$form.Text = 'MovieStream Controller'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(760, 610)
$form.MinimumSize = New-Object System.Drawing.Size(680, 520)
$form.BackColor = [System.Drawing.Color]::FromArgb(20, 25, 34)
$form.ForeColor = [System.Drawing.Color]::FromArgb(235, 239, 245)
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$form.Icon = [System.Drawing.SystemIcons]::Application

$rootLayout = New-Object System.Windows.Forms.TableLayoutPanel
$rootLayout.Dock = 'Fill'
$rootLayout.Padding = New-Object System.Windows.Forms.Padding(22, 18, 22, 18)
$rootLayout.ColumnCount = 1
$rootLayout.RowCount = 5
[void]$rootLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 82)))
[void]$rootLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 84)))
[void]$rootLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 58)))
[void]$rootLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 48)))
[void]$rootLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
$form.Controls.Add($rootLayout)

$header = New-Object System.Windows.Forms.Panel
$header.Dock = 'Fill'
$rootLayout.Controls.Add($header, 0, 0)

$icon = New-Object System.Windows.Forms.PictureBox
$icon.Image = [System.Drawing.SystemIcons]::Application.ToBitmap()
$icon.SizeMode = 'StretchImage'
$icon.Location = New-Object System.Drawing.Point(0, 10)
$icon.Size = New-Object System.Drawing.Size(46, 46)
$header.Controls.Add($icon)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'MovieStream Controller'
$title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 19, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(60, 6)
$header.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = 'Local media server · network access enabled'
$subtitle.ForeColor = [System.Drawing.Color]::FromArgb(153, 165, 181)
$subtitle.AutoSize = $true
$subtitle.Location = New-Object System.Drawing.Point(63, 43)
$header.Controls.Add($subtitle)

$statusLayout = New-Object System.Windows.Forms.TableLayoutPanel
$statusLayout.Dock = 'Fill'
$statusLayout.ColumnCount = 3
$statusLayout.RowCount = 1
[void]$statusLayout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 33.333)))
[void]$statusLayout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 33.333)))
[void]$statusLayout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 33.334)))
$statusLayout.BackColor = [System.Drawing.Color]::FromArgb(30, 37, 49)
$rootLayout.Controls.Add($statusLayout, 0, 1)

function New-StatusCard([string]$heading, [string]$port) {
    $panel = New-Object System.Windows.Forms.Panel
    $panel.Dock = 'Fill'
    $panel.Padding = New-Object System.Windows.Forms.Padding(14, 11, 8, 8)
    $label = New-Object System.Windows.Forms.Label
    $label.Text = "$heading  ·  $port"
    $label.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 10, [System.Drawing.FontStyle]::Bold)
    $label.AutoSize = $true
    $label.Location = New-Object System.Drawing.Point(12, 9)
    $panel.Controls.Add($label)
    $value = New-Object System.Windows.Forms.Label
    $value.Text = 'Stopped'
    $value.AutoSize = $true
    $value.ForeColor = [System.Drawing.Color]::FromArgb(153, 165, 181)
    $value.Location = New-Object System.Drawing.Point(13, 35)
    $panel.Controls.Add($value)
    return @{ Panel = $panel; Value = $value }
}

$backendCard = New-StatusCard 'Backend' '5000'
$frontendCard = New-StatusCard 'Frontend' $(if ($Mock) { "$mockClientPort" } else { "$clientPort" })
$overallPanel = New-Object System.Windows.Forms.Panel
$overallPanel.Dock = 'Fill'
$overallPanel.Padding = New-Object System.Windows.Forms.Padding(14, 11, 8, 8)
$overallTitle = New-Object System.Windows.Forms.Label
$overallTitle.Text = 'Controller'
$overallTitle.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 10, [System.Drawing.FontStyle]::Bold)
$overallTitle.AutoSize = $true
$overallTitle.Location = New-Object System.Drawing.Point(12, 9)
$overallPanel.Controls.Add($overallTitle)
$script:overallValue = New-Object System.Windows.Forms.Label
$script:overallValue.Text = 'Stopped'
$script:overallValue.AutoSize = $true
$script:overallValue.ForeColor = [System.Drawing.Color]::FromArgb(153, 165, 181)
$script:overallValue.Location = New-Object System.Drawing.Point(13, 35)
$overallPanel.Controls.Add($script:overallValue)
$statusLayout.Controls.Add($backendCard.Panel, 0, 0)
$statusLayout.Controls.Add($frontendCard.Panel, 1, 0)
$statusLayout.Controls.Add($overallPanel, 2, 0)

$buttonPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$buttonPanel.Dock = 'Fill'
$buttonPanel.FlowDirection = 'LeftToRight'
$buttonPanel.WrapContents = $false
$buttonPanel.Padding = New-Object System.Windows.Forms.Padding(0, 10, 0, 0)
$rootLayout.Controls.Add($buttonPanel, 0, 2)

function New-ActionButton([string]$text, [int]$width, [bool]$primary = $false) {
    $button = New-Object System.Windows.Forms.Button
    $button.Text = $text
    $button.Width = $width
    $button.Height = 36
    $button.Margin = New-Object System.Windows.Forms.Padding(0, 0, 9, 0)
    $button.FlatStyle = 'Flat'
    $button.FlatAppearance.BorderSize = 0
    $button.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 9, [System.Drawing.FontStyle]::Bold)
    if ($primary) {
        $button.BackColor = [System.Drawing.Color]::FromArgb(55, 124, 245)
        $button.ForeColor = [System.Drawing.Color]::White
    } else {
        $button.BackColor = [System.Drawing.Color]::FromArgb(43, 52, 67)
        $button.ForeColor = [System.Drawing.Color]::FromArgb(235, 239, 245)
    }
    return $button
}

$startButton = New-ActionButton 'START' 92 $true
$stopButton = New-ActionButton 'STOP' 82
$restartButton = New-ActionButton 'RESTART' 100
$openButton = New-ActionButton 'OPEN MOVIESTREAM' 168
$buttonPanel.Controls.AddRange(@($startButton, $stopButton, $restartButton, $openButton))

$logHeader = New-Object System.Windows.Forms.Panel
$logHeader.Dock = 'Fill'
$rootLayout.Controls.Add($logHeader, 0, 3)
$logTitle = New-Object System.Windows.Forms.Label
$logTitle.Text = 'ACTIVITY LOG'
$logTitle.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 9, [System.Drawing.FontStyle]::Bold)
$logTitle.ForeColor = [System.Drawing.Color]::FromArgb(170, 183, 201)
$logTitle.AutoSize = $true
$logTitle.Location = New-Object System.Drawing.Point(0, 12)
$logHeader.Controls.Add($logTitle)
$logHint = New-Object System.Windows.Forms.Label
$logHint.Text = 'Latest 250 lines'
$logHint.ForeColor = [System.Drawing.Color]::FromArgb(115, 128, 147)
$logHint.AutoSize = $true
$logHint.Anchor = 'Top,Right'
$logHint.Location = New-Object System.Drawing.Point(620, 12)
$logHeader.Controls.Add($logHint)
$logHeader.Add_Resize({
    $logHint.Left = [Math]::Max(0, $logHeader.ClientSize.Width - $logHint.Width)
})

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Dock = 'Fill'
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = 'Vertical'
$logBox.WordWrap = $false
$logBox.BackColor = [System.Drawing.Color]::FromArgb(12, 16, 23)
$logBox.ForeColor = [System.Drawing.Color]::FromArgb(195, 207, 222)
$logBox.BorderStyle = 'FixedSingle'
$logBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$logBox.MaxLength = 120000
$rootLayout.Controls.Add($logBox, 0, 4)

function Add-UiLog([string]$message) {
    $lines = @($logBox.Lines)
    $lines += $message
    if ($lines.Count -gt 250) {
        $lines = $lines[($lines.Count - 250)..($lines.Count - 1)]
    }
    $logBox.Lines = $lines
    $logBox.SelectionStart = $logBox.TextLength
    $logBox.ScrollToCaret()
}

function Set-OverallState([string]$value, [string]$detail = '') {
    $script:state = $value
    if ($detail) { $script:overallValue.Text = "$value — $detail" }
    else { $script:overallValue.Text = $value }
    switch ($value) {
        'Running' { $script:overallValue.ForeColor = [System.Drawing.Color]::FromArgb(102, 213, 147) }
        'Starting' { $script:overallValue.ForeColor = [System.Drawing.Color]::FromArgb(255, 202, 97) }
        'Stopping' { $script:overallValue.ForeColor = [System.Drawing.Color]::FromArgb(255, 202, 97) }
        'Error' { $script:overallValue.ForeColor = [System.Drawing.Color]::FromArgb(255, 112, 112) }
        default { $script:overallValue.ForeColor = [System.Drawing.Color]::FromArgb(153, 165, 181) }
    }
}

function Set-PortState([System.Windows.Forms.Label]$label, [string]$value) {
    $label.Text = $value
    switch ($value) {
        'Ready' { $label.ForeColor = [System.Drawing.Color]::FromArgb(102, 213, 147) }
        'Checking…' { $label.ForeColor = [System.Drawing.Color]::FromArgb(255, 202, 97) }
        'Waiting' { $label.ForeColor = [System.Drawing.Color]::FromArgb(255, 202, 97) }
        'Unavailable' { $label.ForeColor = [System.Drawing.Color]::FromArgb(255, 112, 112) }
        default { $label.ForeColor = [System.Drawing.Color]::FromArgb(153, 165, 181) }
    }
}

function Test-HttpEndpoint([string]$url, [switch]$Health) {
    $request = [System.Net.HttpWebRequest]::Create($url)
    $request.Method = 'GET'
    $request.Timeout = 400
    $request.ReadWriteTimeout = 400
    $request.Proxy = $null
    try {
        $response = $request.GetResponse()
        try {
            if ($Health) {
                $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
                try {
                    $buffer = [System.Array]::CreateInstance([char], 2048)
                    $count = $reader.Read($buffer, 0, $buffer.Length)
                    $body = if ($count -gt 0) { -join $buffer[0..($count - 1)] } else { '' }
                    return ($response.StatusCode -eq [System.Net.HttpStatusCode]::OK -and $body -match '"status"\s*:\s*"ok"')
                } finally { $reader.Dispose() }
            }
            return ($response.StatusCode -eq [System.Net.HttpStatusCode]::OK)
        } finally { $response.Dispose() }
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) { $_.Exception.Response.Dispose() }
        return $false
    } catch {
        return $false
    }
}

function Update-Buttons {
    $active = $null -ne $script:session
    $startButton.Enabled = -not $active -and -not $script:shutdownFailed
    $stopButton.Enabled = $active
    $restartButton.Enabled = -not $script:shutdownFailed
    $openButton.Enabled = $true
}

function Start-ControllerServer {
    if ($null -ne $script:session -or $script:shutdownFailed) { return }
    $script:failureMessage = ''
    Set-OverallState 'Starting'
    Set-PortState $backendCard.Value 'Checking…'
    Set-PortState $frontendCard.Value 'Checking…'
    Update-Buttons
    Add-UiLog $(if ($Mock) { 'Starting harmless local mock endpoints (no MovieStream process).' } else { 'Starting existing command: npm run dev' })
    try {
        if ($Mock) {
            $powershell = Join-Path $PSHOME 'powershell.exe'
            $mockScript = Join-Path $PSScriptRoot 'Mock-Services.ps1'
            $arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $mockScript + '"'
            $script:session = [MovieStream.Controller.ProcessJob]::Launch($powershell, $arguments, $PSScriptRoot)
        } else {
            $command = Join-Path $env:SystemRoot 'System32\cmd.exe'
            $script:session = [MovieStream.Controller.ProcessJob]::Launch($command, '/d /s /c "npm run dev"', $projectRoot)
        }
        $script:startedAt = [DateTime]::UtcNow
        Set-OverallState 'Starting' 'waiting for health checks'
        Add-UiLog 'Launcher assigned to a kill-on-close Windows Job Object before it was resumed.'
    } catch {
        $script:session = $null
        $script:failureMessage = $_.Exception.Message
        Set-PortState $backendCard.Value 'Unavailable'
        Set-PortState $frontendCard.Value 'Unavailable'
        Set-OverallState 'Error' $_.Exception.Message
        Add-UiLog "Startup failed: $($_.Exception.Message)"
    }
    Update-Buttons
}

function Stop-ControllerServer([switch]$ForRestart) {
    if ($null -eq $script:session) {
        if (-not $ForRestart) {
            Set-PortState $backendCard.Value 'Stopped'
            Set-PortState $frontendCard.Value 'Stopped'
            if ($script:state -ne 'Error') { Set-OverallState 'Stopped' }
        }
        Update-Buttons
        return
    }
    Set-OverallState 'Stopping' 'closing owned Job Object'
    Add-UiLog 'Stopping only processes owned by this controller…'
    $ownedSession = $script:session
    $script:session = $null
    $script:shutdownFailed = $false
    try {
        $ownedSession.Dispose()
        Add-UiLog 'Owned process job closed; child processes were terminated by Windows.'
    } catch {
        $script:shutdownFailed = $true
        $script:failureMessage = $_.Exception.Message
        Add-UiLog "Shutdown error: $($_.Exception.Message)"
    }
    if ($script:shutdownFailed) {
        Set-PortState $backendCard.Value 'Unavailable'
        Set-PortState $frontendCard.Value 'Unavailable'
        Set-OverallState 'Error' 'owned process shutdown could not be confirmed'
    } else {
        Set-PortState $backendCard.Value 'Stopped'
        Set-PortState $frontendCard.Value 'Stopped'
        if (-not $ForRestart) { Set-OverallState 'Stopped' }
    }
    Update-Buttons
}

$startButton.Add_Click({ Start-ControllerServer })
$stopButton.Add_Click({ Stop-ControllerServer })
$restartButton.Add_Click({
    Stop-ControllerServer -ForRestart
    if ($script:shutdownFailed) { return }
    Start-ControllerServer
})
$openButton.Add_Click({
    try {
        $movieStreamUrl = if ($Mock) {
            "http://127.0.0.1:$mockClientPort"
        } else {
            "http://localhost:$clientPort"
        }
        Start-Process $movieStreamUrl
        Add-UiLog 'Opened MovieStream in the default browser.'
    } catch {
        Add-UiLog "Could not open browser: $($_.Exception.Message)"
    }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 700
$timer.Add_Tick({
    if ($null -eq $script:session) { return }
    foreach ($line in $script:session.DrainLogs()) { Add-UiLog $line }

    if ($script:session.IsExited) {
        $disposeError = $null
        $exitCode = 'unknown'
        try {
            $exitCode = $script:session.ExitCode
        } catch {
            $disposeError = "Could not read the owned launcher exit code: $($_.Exception.Message)"
        }
        try {
            $script:session.Dispose()
        } catch {
            if ($disposeError) { $disposeError += " Cleanup also failed: $($_.Exception.Message)" }
            else { $disposeError = $_.Exception.Message }
        }
        $script:session = $null
        if ($disposeError) {
            $script:shutdownFailed = $true
            Set-PortState $backendCard.Value 'Unavailable'
            Set-PortState $frontendCard.Value 'Unavailable'
            Set-OverallState 'Error' 'owned process cleanup could not be confirmed'
            Add-UiLog "Owned process cleanup error: $disposeError"
        } else {
            Set-PortState $backendCard.Value 'Unavailable'
            Set-PortState $frontendCard.Value 'Unavailable'
            $detail = "launcher exited ($exitCode)"
            if ($script:state -eq 'Stopping') { Set-OverallState 'Stopped' }
            else {
                Set-OverallState 'Error' $detail
                Add-UiLog "Unexpected launcher exit: code $exitCode. Remaining owned children were cleaned up."
            }
        }
        Update-Buttons
        return
    }

    $backendReady = Test-HttpEndpoint "http://127.0.0.1:$serverPort/api/health" -Health
    $frontendPort = if ($Mock) { $mockClientPort } else { $clientPort }
    $frontendReady = Test-HttpEndpoint "http://127.0.0.1:$frontendPort/"
    $script:probeBackend = $backendReady
    $script:probeFrontend = $frontendReady
    Set-PortState $backendCard.Value $(if ($backendReady) { 'Ready' } elseif ($script:state -eq 'Starting') { 'Waiting' } else { 'Unavailable' })
    Set-PortState $frontendCard.Value $(if ($frontendReady) { 'Ready' } elseif ($script:state -eq 'Starting') { 'Waiting' } else { 'Unavailable' })

    if ($backendReady -and $frontendReady) {
        if ($script:state -ne 'Running') {
            Set-OverallState 'Running' 'both health checks passed'
            Add-UiLog 'Backend health endpoint and frontend HTTP endpoint are responding.'
        }
        return
    }
    if ($script:state -eq 'Starting') {
        $elapsed = ([DateTime]::UtcNow - $script:startedAt).TotalSeconds
        if ($elapsed -ge $startupTimeoutSeconds) {
            $failedChecks = @()
            if (-not $backendReady) { $failedChecks += "backend (port $serverPort)" }
            if (-not $frontendReady) { $failedChecks += "frontend (port $frontendPort)" }
            $script:failureMessage = "Startup timed out after $startupTimeoutSeconds seconds. Not responding: $($failedChecks -join ', ')."
            Add-UiLog $script:failureMessage
            Stop-ControllerServer -ForRestart
            if ($script:shutdownFailed) {
                Set-OverallState 'Error' 'startup timed out; shutdown unconfirmed'
            } else {
                Set-OverallState 'Error' 'startup timeout'
            }
        } else {
            Set-OverallState 'Starting' ('health checks {0}/{1}' -f [int][Math]::Floor($elapsed), $startupTimeoutSeconds)
        }
    } elseif ($script:state -eq 'Running') {
        $failedChecks = @()
        if (-not $backendReady) { $failedChecks += "backend (port $serverPort)" }
        if (-not $frontendReady) { $failedChecks += "frontend (port $frontendPort)" }
        $failureSummary = $failedChecks -join ', '
        Set-OverallState 'Error' "$failureSummary not responding"
        Add-UiLog "Health check failed for $failureSummary. The owned launcher is still tracked; use Stop or Restart."
    }
})
$timer.Start()

$form.Add_FormClosing({
    $script:closing = $true
    $timer.Stop()
    Stop-ControllerServer
})

Add-UiLog $(if ($Mock) { 'Mock mode is enabled. It starts only local HTTP test endpoints.' } else { "Project: $projectRoot" })
Add-UiLog "No console window is opened. Stop closes only this controller's Job Object."
Update-Buttons
[void]$form.ShowDialog()
