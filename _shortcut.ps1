# Creates a "NorthLight Tower" desktop shortcut (icon: the NorthLight eye). Double-clicking it opens the server + the app window.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$desk = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $desk 'NorthLight Tower.lnk'))
$lnk.TargetPath = (Join-Path $env:WINDIR 'System32\wscript.exe')
$lnk.Arguments = '"' + (Join-Path $here 'Start.vbs') + '"'
$lnk.WorkingDirectory = $here
$lnk.IconLocation = (Join-Path $here 'assets\office.ico') + ',0'
$lnk.Description = 'NorthLight Tower - watch your Claude workers live'
$lnk.Save()
Write-Host ('Shortcut created: ' + (Join-Path $desk 'NorthLight Tower.lnk'))
