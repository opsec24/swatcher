@echo off
setlocal enabledelayedexpansion

title swatcher - Enterprise Runner (PostgreSQL 16)

echo.
echo   ===================================================================
echo     swatcher - Enterprise Traffic Governance ^& Audit Platform
echo     Database Engine: PostgreSQL 16
echo   ===================================================================
echo.

:: Check for subcommands
if "%1"=="--stop" goto STOP_SERVICES
if "%1"=="--logs" goto VIEW_LOGS
if "%1"=="--restart" goto RESTART_SERVICES
if "%1"=="--status" goto SHOW_STATUS
if "%1"=="--help" goto SHOW_HELP

:: Check if Docker Desktop is installed and running
docker info >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [!] Docker Desktop is not running.
    echo     Attempting to verify Docker installation...
    where docker >nul 2>&1
    if %ERRORLEVEL% NEQ 0 (
        echo.
        echo [ERROR] Docker is not installed on this system!
        echo         swatcher requires PostgreSQL 16 running via Docker.
        echo         Please install Docker Desktop from: https://www.docker.com/products/docker-desktop/
        echo.
        pause
        exit /b 1
    )
    echo.
    echo [ERROR] Docker is installed but the Docker Desktop daemon is not running!
    echo         Please launch Docker Desktop, wait for it to start, and re-run run.bat.
    echo.
    pause
    exit /b 1
)

echo [OK] Docker Desktop is active and running.
echo [*] Launching PostgreSQL 16 database and swatcher server...

if not exist .env (
    echo [*] Generating secure credentials in .env...
    (
        echo DB_USER=swatcher
        echo DB_PASSWORD=swatcher_db_pass_%RANDOM%%RANDOM%
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
    echo   swatcher IS LIVE WITH ENTERPRISE POSTGRESQL 16!
    echo   Dashboard:  http://localhost:9090/
    echo   Ingestion:  http://localhost:9090/api/v1/ingest/batch
    echo ===================================================================
    start http://localhost:9090/
    goto :EOF
) else (
    echo [ERROR] Failed to start containers via Docker Compose.
    pause
    exit /b 1
)

:STOP_SERVICES
docker compose down
echo [OK] Stopped swatcher PostgreSQL and application containers.
goto :EOF

:RESTART_SERVICES
docker compose restart
echo [OK] Restarted swatcher containers.
goto :EOF

:VIEW_LOGS
docker compose logs -f
goto :EOF

:SHOW_STATUS
docker compose ps
goto :EOF

:SHOW_HELP
echo Usage: run.bat [option]
echo   (no args)  Build and launch swatcher with PostgreSQL 16
echo   --status   Check status of PostgreSQL and app containers
echo   --logs     Stream live container logs
echo   --restart  Restart all containers
echo   --stop     Stop all containers safely (data persists in postgres volume)
echo   --help     Show this help message
goto :EOF
