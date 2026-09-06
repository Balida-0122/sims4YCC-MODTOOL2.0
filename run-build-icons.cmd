@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [launcher] Running build-icons.js...
if exist "%ProgramFiles%\nodejs\node.exe" (
    "%ProgramFiles%\nodejs\node.exe" "scripts\build-icons.js"
) else if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
    "%ProgramFiles(x86)%\nodejs\node.exe" "scripts\build-icons.js"
) else (
    where node.exe >nul 2>&1
    if %ERRORLEVEL%==0 (
        node.exe "scripts\build-icons.js"
    ) else (
        echo [ERROR] node.exe not found
        exit /b 1
    )
)
set EXITCODE=%ERRORLEVEL%
echo.
echo [launcher] Done. Exit code=%EXITCODE%
echo [launcher] Log file: build\build-icons.log
echo [launcher] Press any key to exit...
pause >nul
exit /b %EXITCODE%
