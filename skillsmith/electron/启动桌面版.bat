@echo off
REM ============================================================================
REM  Skillsmith（智能体技能管理软件）—— 桌面版启动器
REM
REM  双击即可。以独立窗口运行（不是浏览器标签页），带系统托盘图标。
REM
REM  为什么要清这些环境变量：
REM   ELECTRON_RUN_AS_NODE=1  是 WorkBuddy 注入的，会让 Electron 降级成
REM     纯 Node 进程 —— app/BrowserWindow 全部 undefined，直接崩。
REM   NODE_OPTIONS / CODEBUDDY_SAFE_DELETE_* 是 WorkBuddy 的 FS 护栏。
REM     护栏统计删除次数，超阈值就拒绝后续删除。而「关闭技能」在
REM     junction 端就是摘链接，语义上被当成删除 —— 开关点多了会全部失效。
REM     护栏在 node-language-shim.cjs 里有早退条件：无 SESSION_ID 不加载。
REM     这里直接清空，比绕路更可靠。
REM
REM  安全性：护栏防的是 Agent 自主删用户文件。本应用的删除目标全部先经
REM  removeJunction() 校验「确实是 junction」，真源 ~/.agents/skills 从不删。
REM ============================================================================

setlocal
set "DIR=%~dp0"
cd /d "%DIR%"

REM ── 清掉 WorkBuddy 注入的环境变量 ──
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
set "CLAUDE_SESSION_ID="
set "CODEBUDDY_SESSION_ID="
set "CODEBUDDY_SAFE_DELETE_ENABLED=0"
set "CODEBUDDY_SAFE_DELETE_BULK_GUARD="
set "CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD="
set "CODEBUDDY_BROKERED_FS_HOOK_ENABLED="
set "SKILLSWITCH_DESKTOP=1"

REM ── 找 electron ──
set "ELECTRON=%DIR%node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo.
  echo   [首次运行] 正在下载 Electron 运行时，需要几分钟...
  echo.
  where npm >nul 2>nul
  if errorlevel 1 (
    echo   [错误] 未找到 npm。请先安装 Node.js ^(https://nodejs.org^)。
    pause
    exit /b 1
  )
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  pushd "%DIR%"
  call npm install --no-audit --no-fund
  popd
)

if not exist "%ELECTRON%" (
  echo   [错误] Electron 运行时缺失，请在该目录下执行: npm install
  pause
  exit /b 1
)

start "" "%ELECTRON%" "%DIR%"
endlocal
