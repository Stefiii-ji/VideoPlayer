# MovieStream Controller

This Windows Forms controller starts the existing root command, `npm run dev`, from the MovieStream project root. It discovers that root relative to the script and reads the backend `PORT` from `server\.env` when present (default `5000`). The client and mock ports default to `5173` and `5174`. It does not change the MovieStream scripts, dependencies, or network binding. Backend and frontend readiness are checked independently using those ports.

## Launch

Run in Windows PowerShell 5.1:

```powershell
$projectRoot = "<path-to-MovieStream>"
powershell.exe -NoProfile -STA -File (Join-Path $projectRoot "desktop-controller\MovieStreamController.ps1")
```

The window uses the built-in Windows application icon. It requires the existing Node.js/npm installation and the project dependencies to be installed.

## Process ownership

`ProcessJob.cs` creates a Windows Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. It creates the launcher suspended, restricts inherited handles to the redirected output pipes and a null input handle, closes the parent's copies of the pipe write handles, assigns the launcher to the job, and resumes it only after assignment succeeds. Descendant processes inherit job membership. If assignment fails, the suspended launcher is explicitly terminated using its process handle and startup fails.

Stop and Restart dispose only this controller's Job Object handle. No process-name search or global Node.js termination is used. Closing the controller also closes its owned job. Stdout/stderr are redirected to anonymous pipes, and log buffering is bounded to 500 native lines and 250 displayed lines.

## Safe mock checks

To check the UI and endpoint readiness without launching MovieStream:

```powershell
$projectRoot = "<path-to-MovieStream>"
powershell.exe -NoProfile -STA -File (Join-Path $projectRoot "desktop-controller\MovieStreamController.ps1") -Mock
```

Then press Start, verify both mock endpoint cards become Ready, and press Stop. Mock mode launches only `Mock-Services.ps1`, which binds test HTTP endpoints on loopback at the configured backend port and the mock client port. It does not load MovieStream or access the media directory. Ensure those ports are free first.

To test process ownership and output capture without binding network ports:

```powershell
$projectRoot = "<path-to-MovieStream>"
powershell.exe -NoProfile -File (Join-Path $projectRoot "desktop-controller\Test-Controller.ps1")
```

The test starts a harmless PowerShell child that prints mock stdout/stderr and sleeps. It verifies capture and that disposing the owned Job Object stops that process.
The test also keeps a separately launched PowerShell process alive during job cleanup and verifies it remains untouched. `-LegacyNestedStartProcess` reruns the descendant test using the previous nested `Start-Process` launch method for diagnosis.

Run this test in Windows PowerShell 5.1 from any working directory:

```powershell
$projectRoot = "<path-to-MovieStream>"
& (Join-Path $projectRoot "desktop-controller\Test-Controller.ps1")
```

## Desktop shortcut

Shortcut creation is manual and separate from controller startup:

```powershell
$projectRoot = "<path-to-MovieStream>"
powershell.exe -NoProfile -File (Join-Path $projectRoot "desktop-controller\Install-DesktopShortcut.ps1")
```

This creates `MovieStream Controller.lnk` on the current user's desktop, targeting Windows PowerShell with `-STA` and `-WindowStyle Hidden`. Review the scripts before running the setup script.

## Limitations

- The controller is for Windows PowerShell 5.1 / Windows Forms on Windows.
- Health checks establish that the expected HTTP endpoint responds; another application that returns the same health response could satisfy a probe.
- A restrictive host Job Object policy may prevent nested assignment. In that case startup fails safely rather than launching an unmanaged process.
- The controller preserves the existing `0.0.0.0` server binds; apply appropriate Windows Firewall rules for trusted networks.
