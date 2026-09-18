' ASTI hidden autostart launcher.
' Invoked by a shortcut in the Startup folder (wscript.exe <this file>).
' Runs asti-run.cmd with a hidden window so no console appears at logon.
Option Explicit
Dim fso, sh, scriptDir, repoDir, runner
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoDir = fso.GetParentFolderName(scriptDir)
runner = repoDir & "\scripts\asti-run.cmd"
' 0 = hidden window, False = do not wait
sh.Run """" & runner & """", 0, False
