' Antigravity Switcher — create Desktop + Startup shortcuts for this folder
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
vbs = base & "\start_panel.vbs"
icon = base & "\assets\icon.ico"

MakeLink sh.SpecialFolders("Desktop") & "\Antigravity Panel.lnk"
MakeLink sh.SpecialFolders("Startup") & "\Antigravity Panel.lnk"

Sub MakeLink(target)
  Set lnk = sh.CreateShortcut(target)
  lnk.TargetPath = sh.ExpandEnvironmentStrings("%WINDIR%") & "\System32\wscript.exe"
  lnk.Arguments = """" & vbs & """"
  lnk.WorkingDirectory = base
  lnk.IconLocation = icon & ",0"
  lnk.Description = "Antigravity account switcher panel"
  lnk.Save
End Sub
