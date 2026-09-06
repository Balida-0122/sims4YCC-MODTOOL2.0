@echo off
setlocal
chcp 65001 >nul
title Sims4YCC MODtool - Build Windows (NSIS x64)

REM ====== 配置 ======
set "PROJDIR=%~dp0"
cd /d "%PROJDIR%"

REM 自动定位 node.exe（优先用系统 Program Files\nodejs，失败则 where）
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
) else if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
  set "NODEEXE=%ProgramFiles(x86)%\nodejs\node.exe"
) else (
  for /f "delims=" %%i in ('where node.exe 2^>nul') do set "NODEEXE=%%i"
)

if not defined NODEEXE (
  echo [ERROR] 未找到 node.exe，请先安装 Node.js 并加入 PATH。
  echo 下载: https://nodejs.org/
  pause
  exit /b 1
)

echo [INFO] 使用 Node: %NODEEXE%
for /f "delims=" %%v in ('"%NODEEXE%" -v') do echo [INFO] Node 版本: %%v
echo.

REM 如果 build/icon.ico 不存在，先跑图标生成脚本
if not exist "%PROJDIR%build\icon.ico" (
  echo [WARN] 未找到 build\icon.ico，先生成图标...
  call :RUN_NODE "%PROJDIR%scripts\build-icons.js"
  if errorlevel 1 (
    echo [ERROR] 图标生成失败，请检查 build\build-icons.log。
    pause
    exit /b 1
  )
  echo [OK]   图标生成完成。
  echo.
)

REM 执行 npm.cmd run build:win  —— 用 node.exe 直接调 npm-cli.js，绕过 .ps1
echo [INFO] 开始打包 Windows (NSIS x64)...
echo        打包产物默认输出到 dist\
echo.

if exist "%ProgramFiles%\nodejs\node_modules\npm\bin\npm-cli.js" (
  set "NPMCLI=%ProgramFiles%\nodejs\node_modules\npm\bin\npm-cli.js"
) else (
  REM 用 npm.cmd 的同目录方式推断
  for /f "delims=" %%i in ('where npm.cmd 2^>nul') do (
    set "NPMDIR=%%~dpi"
  )
  if defined NPMDIR if exist "!NPMDIR!node_modules\npm\bin\npm-cli.js" (
    set "NPMCLI=!NPMDIR!node_modules\npm\bin\npm-cli.js"
  )
)

if exist "%NPMCLI%" (
  "%NODEEXE%" "%NPMCLI%" run build:win
  set "EC=%ERRORLEVEL%"
) else (
  REM 兜底：直接调用 electron-builder
  if exist "node_modules\.bin\electron-builder.cmd" (
    call node_modules\.bin\electron-builder.cmd --win --x64
    set "EC=%ERRORLEVEL%"
  ) else (
    echo [ERROR] 未找到 npm-cli.js 或 electron-builder.cmd，请先确保 npm install 成功。
    pause
    exit /b 1
  )
)

echo.
if %EC% EQU 0 (
  echo [SUCCESS] Windows 打包完成！产物位于: %PROJDIR%dist\
) else (
  echo [FAILED]  打包失败，退出码: %EC%
)
echo.
pause
exit /b %EC%

:RUN_NODE
"%NODEEXE%" %1
exit /b %ERRORLEVEL%
