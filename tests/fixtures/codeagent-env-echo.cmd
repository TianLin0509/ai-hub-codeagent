@echo off
rem Stand-in for codeagent: print the terminal env the Hub hands over, then wait.
rem Keep this file ASCII: cmd.exe reads batch files in the console code page.
echo CODEAGENT-ENV WT_SESSION=[%WT_SESSION%] TERM=[%TERM%]
ping -n 120 127.0.0.1 >nul
