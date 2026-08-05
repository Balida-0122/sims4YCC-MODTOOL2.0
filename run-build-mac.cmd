@echo off
setlocal
chcp 65001 >nul
title Sims4YCC MODtool - Build macOS (DMG) - WARNING: runs on Windows

REM ====== 配置 ======
set "PROJDIR=%~dp0"
cd /d "%PROJDIR%"

if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
) else if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
  set "NODEEXE=%ProgramFiles(x86)%\nodejs\node.exe"
) else (
  for /f "delims=" %%i in ('where node.exe 2^>nul') do set "NODEEXE=%%i"
)

if not defined NODEEXE (
  echo [ERROR] 未找到 node.exe，请先安装 Node.js。
  pause
  exit /b 1
)

echo ============================================================
echo   WARNING - You are building macOS DMG on Windows.
echo   electron-builder on Windows CANNOT create a standard macOS
echo   .dmg image (hdiutil is macOS-only). It MAY succeed with a
echo   partial target like "zip"/"dir", but DMG WILL LIKELY FAIL.
echo   For a proper signed+notarized DMG, run `npm run build:mac`
echo   on an actual macOS machine (Apple Silicon or Intel).
echo ============================================================
echo.
echo 按任意键继续尝试打包（可能失败），或关闭窗口取消...
pause >nul

REM 先确保图标存在
if not exist "%PROJDIR%build\icon.icns" (
  if exist "%PROJDIR%build\icon.iconset\icon_512x512@2x.png" (
    echo [WARN] icon.icns 不存在，但 icon.iconset/ 完整，可在 mac 上生成：
    echo        iconutil -c icns build/icon.iconset -o build/icon.icns
  ) else (
    echo [WARN] 未找到 build\icon.icns，先生成图标...
    "%NODEEXE%" "%PROJDIR%scripts\build-icons.js"
  )
)

echo.
echo [INFO] 尝试构建 macOS（DMG，x64+arm64）...
echo        输出目录: dist\
echo.

if exist "%ProgramFiles%\nodejs\node_modules\npm\bin\npm-cli.js" (
  set "NPMCLI=%ProgramFiles%\nodejs\node_modules\npm\bin\npm-cli.js"
)
if exist "%NPMCLI%" (
  "%NODEEXE%" "%NPMCLI%" run build:mac
  set "EC=%ERRORLEVEL%"
) else (
  if exist "node_modules\.bin\electron-builder.cmd" (
    call node_modules\.bin\electron-builder.cmd --mac
    set "EC=%ERRORLEVEL%"
  ) else (
    echo [ERROR] 未找到 npm-cli.js 或 electron-builder.cmd。
    pause
    exit /b 1
  )
)

echo.
if %EC% EQU 0 (
  echo [SUCCESS] macOS 打包完成！请检查 dist\ 目录。
  echo           注意：若 DMG 未生成但 .zip 生成了，可在 mac 上执行：
  echo           npm run build:mac
) else (
  echo [FAILED] macOS 打包失败（常见原因：Windows 无法调用 hdiutil 生成 DMG）。
  echo          请在 macOS 机器执行：
  echo              cd /path/to/project
  echo              npm install
  echo              npm run build:mac
)
echo.
pause
exit /b %EC%
