@echo off
setlocal enabledelayedexpansion
echo ================================
echo  LINUX DO Auto-Read - Init
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

:: Check git
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Git not found
    echo Install from https://git-scm.com
    pause
    exit /b 1
)
echo [OK] Git found

:: Clone or update repo
set REPO_URL=https://github.com/Willywang8216/auto-read-liunxdo-my.git
set TARGET_DIR=%USERPROFILE%\auto-read-liunxdo-my

if exist "%TARGET_DIR%\.git" (
    echo [INFO] Repo exists, pulling latest...
    cd /d "%TARGET_DIR%"
    git pull
) else (
    echo.
    echo [INFO] Cloning repo...
    git clone %REPO_URL% "%TARGET_DIR%"
    if !errorlevel! neq 0 (
        echo [ERROR] Clone failed
        pause
        exit /b 1
    )
    cd /d "%TARGET_DIR%"
    echo [OK] Clone done
)

:: Install dependencies
echo.
echo [INFO] Installing dependencies...
call npm install
if !errorlevel! neq 0 (
    echo [ERROR] npm install failed
    pause
    exit /b 1
)
echo [OK] Dependencies installed

:: Copy .env from OneDrive backup if missing
if not exist ".env" (
    set "ENVBACKUP=%USERPROFILE%\OneDrive\Documents\OneDrive\Scripts-ssh-ssl-keys\LINUX自動閱讀\.env"
    if exist "!ENVBACKUP!" (
        copy "!ENVBACKUP!" ".env" >nul
        echo [OK] .env copied from OneDrive backup
    ) else (
        if exist ".env.template" (
            copy ".env.template" ".env" >nul
            echo [WARN] .env created from template - edit with your credentials
        ) else (
            echo [WARN] No .env or .env.template found
        )
    )
) else (
    echo [OK] .env exists
)

echo.
echo ================================
echo  Done! Run start.bat to begin.
echo ================================
echo.
pause
