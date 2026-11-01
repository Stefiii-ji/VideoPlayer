$ErrorActionPreference = 'Stop'
$controller = Join-Path $PSScriptRoot 'MovieStreamController.ps1'
if (-not (Test-Path -LiteralPath $controller -PathType Leaf)) {
    throw "Controller script was not found: $controller"
}

$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
$shortcutPath = Join-Path $desktop 'MovieStream Controller.lnk'
$powershell = Join-Path $PSHOME 'powershell.exe'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powershell
$shortcut.Arguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $controller + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = 'Start and control the local MovieStream services.'
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,137"
$shortcut.Save()

Write-Host "Created desktop shortcut: $shortcutPath"
