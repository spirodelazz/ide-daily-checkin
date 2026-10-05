' trae_hidden.vbs - run trae_checkin_api.mjs with node.exe in a hidden window.
' wscript.exe has no console, so the scheduled task shows no black window flash.
' The node exit code is propagated so Task Scheduler's Last Task Result is meaningful.
' Usage: wscript.exe trae_hidden.vbs [trigger]   (trigger: schedule | poll)
Dim sh, fso, node, mjs, arg, cmd, rc
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
node = "C:\Program Files\nodejs\node.exe"
' 自定位：与 vbs 同目录下的 trae_checkin_api.mjs，仓库移动后无需改路径
mjs = fso.GetParentFolderName(WScript.ScriptFullName) & "\trae_checkin_api.mjs"
arg = ""
If WScript.Arguments.Count > 0 Then arg = " --trigger " & WScript.Arguments(0)
cmd = """" & node & """ """ & mjs & """" & arg
rc = sh.Run(cmd, 0, True)
WScript.Quit rc
