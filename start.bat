@echo off
echo ================================
echo  LINUX DO Auto-Read - Start
echo ================================
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found
    echo Install from https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo [OK] Node.js %%v

:: Check .env
if not exist ".env" (
    echo [ERROR] .env not found!
    pause
    exit /b 1
)
echo [OK] .env loaded

:: Install deps if needed
if not exist "node_modules" (
    echo.
    echo [INFO] First run, installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed
) else (
    echo [OK] node_modules found
)

:: Run
echo.
echo [START] Running auto-read (25 min)...
echo.
node bypasscf.js
echo.
echo [DONE] Finished
pause
