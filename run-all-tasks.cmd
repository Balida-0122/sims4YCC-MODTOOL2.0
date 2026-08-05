@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ========================================================
echo   SimsYCC - Build Icons + Task Runner (All-in-One)
echo ========================================================
echo.

where node.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] node.exe not found in PATH
    exit /b 1
)

if not exist "node_modules\sharp" (
    echo [PREP] node_modules not found. Running npm install...
    call npm install --no-audit --no-fund --loglevel=warn
    if errorlevel 1 (
        echo [ERROR] npm install failed
        exit /b 2
    )
    echo [PREP] npm install done.
) else (
    echo [PREP] node_modules already installed.
)
echo.

echo [LAUNCH] Running scripts\do-all-tasks.js via Node.js child_process...
node.exe "scripts\do-all-tasks.js"
set EXITCODE=%ERRORLEVEL%
echo.
echo ========================================================
echo   All tasks done. Exit code = %EXITCODE%
echo ========================================================
echo.
echo Result file: build\all-tasks-result.json
echo Icon build log: build\build-icons.log
echo.
if exist "build\icon.ico" (
    echo [OK] icon.ico EXISTS - Win electron-builder packaging can proceed
) else (
    echo [FAIL] icon.ico MISSING - Win electron-builder packaging cannot start
)
echo.
pause
exit /b %EXITCODE%
