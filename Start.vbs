' Starts NorthLight Tower without opening a console window (the desktop shortcut runs this file).
Set sh = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
sh.Run "cmd /c """ & here & "\Start.bat""", 0, False
