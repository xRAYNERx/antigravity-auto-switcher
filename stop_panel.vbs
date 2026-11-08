' Antigravity Switcher — stop the background daemon
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
pidFile = base & "\panel.pid"
If fso.FileExists(pidFile) Then
  txt = Trim(fso.OpenTextFile(pidFile, 1).ReadAll)
  If IsNumeric(txt) Then sh.Run "taskkill /F /PID " & txt, 0, False
End If
