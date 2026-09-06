Option Explicit
Dim objShell, objFSO, projectRoot, nodeExe, scriptPath, args
Dim exitCode, outFile, waitResult

Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

projectRoot = objFSO.GetParentFolderName(objFSO.GetParentFolderName(WScript.ScriptFullName))
nodeExe = "C:\Program Files\nodejs\node.exe"
scriptPath = projectRoot & "\scripts\do-all-tasks.js"
outFile = projectRoot & "\build\vbs-launcher.log"

On Error Resume Next
If Not objFSO.FolderExists(projectRoot & "\build") Then
    objFSO.CreateFolder projectRoot & "\build"
End If
On Error GoTo 0

Dim logStream
Set logStream = objFSO.CreateTextFile(outFile, True)
logStream.WriteLine "VBS Launcher start: " & Now
logStream.WriteLine "Project root: " & projectRoot
logStream.WriteLine "Node exe: " & nodeExe
logStream.WriteLine "Script: " & scriptPath

args = """" & nodeExe & """ """ & scriptPath & """"
logStream.WriteLine "Executing: " & args
logStream.WriteLine ""
logStream.Close

' Execute and capture exit code
exitCode = objShell.Run(args, 0, True)

Set logStream = objFSO.OpenTextFile(outFile, 8)
logStream.WriteLine ""
logStream.WriteLine "VBS Launcher done. Node exit code: " & exitCode
logStream.WriteLine "VBS Launcher end: " & Now
logStream.Close

WScript.Quit exitCode
