# ==============================================================================
# swatcher - Enterprise Runner for Windows PowerShell
# ==============================================================================

param (
    [string]$Option = ""
)

Write-Host ""
Write-Host "  ===================================================================" -ForegroundColor Cyan
Write-Host "    swatcher - Enterprise Traffic Governance & Audit Platform" -ForegroundColor Cyan
Write-Host "  ===================================================================" -ForegroundColor Cyan
Write-Host ""

function Run-Local {
    Write-Host "[*] Launching in Standalone Local Mode (Node.js + Embedded SQLite)..." -ForegroundColor Yellow
    
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host ""
        Write-Host "[ERROR] Node.js is not found on your system!" -ForegroundColor Red
        Write-Host "        Please download and install Node.js (v18, v20, or v22) from https://nodejs.org/" -ForegroundColor Yellow
        exit 1
    }

    Set-Location -Path "$PSScriptRoot\swatcher-server"
    if (-not (Test-Path "node_modules")) {
        Write-Host "[*] Installing dependencies in swatcher-server (first-time setup)..." -ForegroundColor Cyan
        npm install
    }

    Write-Host ""
    Write-Host "===================================================================" -ForegroundColor Green
    Write-Host "  swatcher Server Starting on http://localhost:9090/" -ForegroundColor Green
    Write-Host "  Press Ctrl+C to stop the server" -ForegroundColor Gray
    Write-Host "===================================================================" -ForegroundColor Green
    Write-Host ""

    Start-Process "http://localhost:9090/"
    npm start
    exit 0
}

switch ($Option) {
    "--local" { Run-Local }
    "-l"      { Run-Local }
    "--stop"  {
        docker compose down
        Write-Host "[OK] Stopped swatcher containers." -ForegroundColor Green
        exit 0
    }
    "--logs"  {
        docker compose logs -f
        exit 0
    }
    "--help"  {
        Write-Host "Usage: .\run.ps1 [-Option <option>]"
        Write-Host "  (no args)  Run via Docker Compose (or fall back to Node.js local mode)"
        Write-Host "  --local    Force run in Standalone Local Mode (Node.js + SQLite)"
        Write-Host "  --stop     Stop Docker containers"
        Write-Host "  --logs     View live container logs"
        exit 0
    }
}

# Check if Docker Desktop is available and running
$dockerRunning = $false
try {
    $null = docker info 2>&1
    if ($LASTEXITCODE -eq 0) { $dockerRunning = $true }
} catch {
    $dockerRunning = $false
}

if ($dockerRunning) {
    Write-Host "[OK] Docker Desktop is running." -ForegroundColor Green
    Write-Host "[*] Starting swatcher containers via Docker Compose..." -ForegroundColor Cyan

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
        Write-Host "  swatcher is LIVE via Docker!" -ForegroundColor Green
        Write-Host "  Dashboard: http://localhost:9090/" -ForegroundColor Cyan
        Write-Host "===================================================================" -ForegroundColor Green
        Start-Process "http://localhost:9090/"
        exit 0
    } else {
        Write-Host "[!] Docker Compose failed. Falling back to local Node.js mode..." -ForegroundColor Yellow
        Run-Local
    }
} else {
    Write-Host "[!] Docker is not running or not installed. Switching to Standalone Local Mode..." -ForegroundColor Yellow
    Run-Local
}
