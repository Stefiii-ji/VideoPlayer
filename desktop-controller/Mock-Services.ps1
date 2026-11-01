param(
    [Parameter(Mandatory = $true)]
    [int]$BackendPort,
    [Parameter(Mandatory = $true)]
    [int]$ClientPort
)

$ErrorActionPreference = 'Stop'
$listeners = New-Object System.Collections.Generic.List[System.Net.HttpListener]
$pending = New-Object System.Collections.Generic.List[object]

try {
    foreach ($port in @($BackendPort, $ClientPort)) {
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add("http://127.0.0.1:$port/")
        $listener.Start()
        $listeners.Add($listener)
        $pending.Add(@{ Listener = $listener; Result = $listener.BeginGetContext($null, $null) })
        [Console]::WriteLine("Mock endpoint listening on 127.0.0.1:$port")
    }

    while ($true) {
        for ($index = 0; $index -lt $pending.Count; $index++) {
            $entry = $pending[$index]
            if (-not $entry.Result.AsyncWaitHandle.WaitOne(0)) { continue }
            $context = $entry.Listener.EndGetContext($entry.Result)
            $entry.Result = $entry.Listener.BeginGetContext($null, $null)
            if ($context.Request.Url.AbsolutePath -eq '/api/health') {
                $body = '{"status":"ok","mock":true}'
                $context.Response.ContentType = 'application/json'
            } else {
                $body = '<!doctype html><title>MovieStream Controller mock</title><p>Harmless mock endpoint.</p>'
                $context.Response.ContentType = 'text/html'
            }
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
            $context.Response.ContentLength64 = $bytes.Length
            $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            $context.Response.Close()
        }
        Start-Sleep -Milliseconds 40
    }
} finally {
    foreach ($listener in $listeners) {
        if ($listener.IsListening) { $listener.Stop() }
        $listener.Close()
    }
}
