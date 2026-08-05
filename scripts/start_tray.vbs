Option Explicit

Dim fso, shell, folder, psPath, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

folder = fso.GetParentFolderName(WScript.ScriptFullName)
psPath = folder & "\tray_agent.ps1"

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & psPath & """"
shell.Run command, 0, False

Set shell = Nothing
Set fso = Nothing
