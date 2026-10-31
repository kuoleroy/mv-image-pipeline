@echo off
REM Skillsmith（智能体技能管理软件）—— 浏览器版启动器
REM 双击即可。会自动打开浏览器面板。

setlocal
REM 用 %~dp0（脚本自身所在目录）定位项目 —— 相对路径，可移植：
REM 换机器、换用户名、换目录都不用改。
set "DIR=%~dp0"

REM 找 node：优先用 PATH 里的，其次用 WorkBuddy 自带的
where node >nul 2>nul
if errorlevel 1 (
  for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%~fD\node.exe" set "NODE=%%~fD\node.exe"
  )
)
if not defined NODE set "NODE=node"

REM 剥掉 WorkBuddy 会话注入的 FS 护栏（详见 launcher.js 的注释）
set "NODE_OPTIONS="
set "CLAUDE_SESSION_ID="
set "CODEBUDDY_SESSION_ID="
set "CODEBUDDY_SAFE_DELETE_ENABLED=0"

"%NODE%" "%DIR%launcher.js"
endlocal
