# ==============================================================================
# swatcher - Enterprise Runner for Windows PowerShell (PostgreSQL 16)
# ==============================================================================

param (
    [string]$Option = ""
)

Write-Host ""
Write-Host "  ===================================================================" -ForegroundColor Cyan
Write-Host "    swatcher - Enterprise Traffic Governance & Audit Platform" -ForegroundColor Cyan
Write-Host "    Database Engine: PostgreSQL 16" -ForegroundColor Cyan
Write-Host "  ===================================================================" -ForegroundColor Cyan
Write-Host ""

switch ($Option) {
    "--stop" {
        docker compose down
        Write-Host "[OK] Stopped swatcher PostgreSQL and application containers." -ForegroundColor Green
        exit 0
    }
    "--status" {
        docker compose ps
        exit 0
    }
    "--restart" {
        docker compose restart
        Write-Host "[OK] Restarted swatcher containers." -ForegroundColor Green
        exit 0
    }
    "--logs" {
        docker compose logs -f
        exit 0
    }
    "--help" {
        Write-Host "Usage: .\run.ps1 [-Option <option>]"
        Write-Host "  (no args)  Build and launch swatcher with PostgreSQL 16"
        Write-Host "  --status   Check status of PostgreSQL and app containers"
        Write-Host "  --logs     Stream live container logs"
        Write-Host "  --restart  Restart all containers"
        Write-Host "  --stop     Stop all containers safely (data persists in postgres volume)"
        exit 0
    }
}

# Verify Docker Desktop
$dockerRunning = $false
try {
    $null = docker info 2>&1
    if ($LASTEXITCODE -eq 0) { $dockerRunning = $true }
} catch {
    $dockerRunning = $false
}

if (-not $dockerRunning) {
    Write-Host "[ERROR] Docker Desktop is not running or not installed!" -ForegroundColor Red
    Write-Host "        swatcher requires PostgreSQL 16 running via Docker." -ForegroundColor Yellow
    Write-Host "        Please launch Docker Desktop, ensure the engine is started, and run .\run.ps1 again." -ForegroundColor Yellow
    exit 1
}

Write-Host "[OK] Docker Desktop is running." -ForegroundColor Green
Write-Host "[*] Launching PostgreSQL 16 database and swatcher server..." -ForegroundColor Cyan

if (-not (Test-Path "$PSScriptRoot\.env")) {
    Write-Host "[*] Initializing production .env configuration..." -ForegroundColor Gray
    $randomPass = [System.Guid]::NewGuid().ToString("N")
    $randomSecret = [System.Guid]::NewGuid().ToString("N") + [System.Guid]::NewGuid().ToString("N")
    @"
DB_USER=swatcher
DB_PASSWORD=$randomPass
DB_NAME=swatcher_db
PORT=9090
SESSION_SECRET=$randomSecret
DB_POOL_MAX=30
DB_SSL=false
"@ | Out-File -FilePath "$PSScriptRoot\.env" -Encoding ASCII
}

docker compose up -d --build
if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "===================================================================" -ForegroundColor Green
    Write-Host "  swatcher IS LIVE WITH ENTERPRISE POSTGRESQL 16!" -ForegroundColor Green
    Write-Host "  Dashboard: http://localhost:9090/" -ForegroundColor Cyan
    Write-Host "  Ingestion: http://localhost:9090/api/v1/ingest/batch" -ForegroundColor Cyan
    Write-Host "===================================================================" -ForegroundColor Green
    Start-Process "http://localhost:9090/"
    exit 0
} else {
    Write-Host "[ERROR] Docker Compose failed to launch services." -ForegroundColor Red
    exit 1
}
