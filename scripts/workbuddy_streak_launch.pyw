"""无控制台启动器：由 pythonw.exe 运行，转调 workbuddy_streak_launch.ps1。

为什么需要它：任务计划程序直接起 powershell.exe 时，PowerShell 是控制台程序，
`-WindowStyle Hidden` 只能隐藏已经创建出来的窗口，创建瞬间仍会闪一下黑框。
pythonw.exe 是 GUI 子系统，自身没有控制台；再由它用 CREATE_NO_WINDOW 起
PowerShell，子进程连控制台窗口都不会分配，全程无黑框。

用法（任务计划程序里）：pythonw.exe "scripts\\workbuddy_streak_launch.pyw" [-DryRun] [-MechanicsTest]
退出码沿用 PowerShell 守卫的返回值，任务计划程序可直接看到失败。
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PS1 = os.path.join(HERE, "workbuddy_streak_launch.ps1")
CREATE_NO_WINDOW = 0x08000000


def main():
    if not os.path.isfile(PS1):
        return 1
    cmd = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-File", PS1,
    ] + sys.argv[1:]
    try:
        return subprocess.run(cmd, creationflags=CREATE_NO_WINDOW).returncode
    except OSError:
        return 1


if __name__ == "__main__":
    sys.exit(main())
