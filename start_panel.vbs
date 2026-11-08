' Antigravity Switcher — silent launcher (no console window)
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

nodeExe = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "C:\Program Files (x86)\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"

sh.Run """" & nodeExe & """ """ & base & "\agpanel.js""", 0, False
