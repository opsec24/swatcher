@echo off
setlocal enabledelayedexpansion

title swatcher - Enterprise Runner

echo.
echo   ===================================================================
echo     swatcher - Enterprise Traffic Governance ^& Audit Platform
echo   ===================================================================
echo.

:: Check for subcommand: --local, --logs, --stop
if "%1"=="--local" goto RUN_LOCAL
if "%1"=="-l" goto RUN_LOCAL
if "%1"=="--stop" goto STOP_SERVICES
if "%1"=="--logs" goto VIEW_LOGS
if "%1"=="--help" goto SHOW_HELP

:: Step 1: Check if Docker Desktop is installed and running
docker info >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [OK] Docker Desktop is active and running.
    echo [*] Starting swatcher via Docker Compose...
    
    if not exist .env (
        echo [*] Initializing production .env file...
        (
            echo DB_USER=swatcher
            echo DB_PASSWORD=swatcher_secure_pass_%RANDOM%%RANDOM%
            echo DB_NAME=swatcher_db
            echo PORT=9090
            echo SESSION_SECRET=sec_%RANDOM%%RANDOM%%RANDOM%%RANDOM%
            echo DB_POOL_MAX=30
            echo DB_SSL=false
        ) > .env
    )
    
    docker compose up -d --build
    if %ERRORLEVEL% EQU 0 (
        echo.
        echo ===================================================================
        echo   swatcher is LIVE via Docker!
        echo   Dashboard: http://localhost:9090/
        echo ===================================================================
        start http://localhost:9090/
        goto :EOF
    ) else (
        echo [!] Docker compose encountered an error. Falling back to local Node.js mode...
        goto RUN_LOCAL
    )
)

:RUN_LOCAL
echo [*] Launching in Standalone Local Mode (Node.js + Embedded SQLite)...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Node.js is not found on your system!
    echo         Please download and install Node.js from https://nodejs.org/
    echo         and re-run run.bat.
    pause
    exit /b 1
)

cd swatcher-server
if not exist node_modules (
    echo [*] Installing dependencies in swatcher-server (first-time run)...
    call npm install
)

echo.
echo ===================================================================
echo   swatcher Server Starting on http://localhost:9090/
echo   Press Ctrl+C to stop the server
echo ===================================================================
echo.

start "" http://localhost:9090/
call npm start
goto :EOF

:STOP_SERVICES
docker compose down
echo [OK] Stopped swatcher containers.
goto :EOF

:VIEW_LOGS
docker compose logs -f
goto :EOF

:SHOW_HELP
echo Usage: run.bat [option]
echo   (no args)  Run via Docker Compose (or fall back to Node.js local mode)
echo   --local    Force run in Standalone Local Mode (Node.js + SQLite)
echo   --stop     Stop Docker containers
echo   --logs     View live container logs
echo   --help     Show this help message
goto :EOF
