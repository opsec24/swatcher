#!/usr/bin/env bash
# ==============================================================================
# swatcher - Enterprise Deployment and Runner Script
# Targeted for: Kali Linux, Ubuntu, Debian, Amazon Linux, RHEL, Fedora, macOS
# ==============================================================================

set -e

# ANSI Color Codes
BOLD="\033[1m"
GREEN="\033[0;32m"
BLUE="\033[0;34m"
CYAN="\033[0;36m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
NC="\033[0m" # No Color

# Determine script and project directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

print_banner() {
  echo -e "${CYAN}"
  echo "  ███████╗██╗    ██╗ █████╗ ████████╗ ██████╗██╗  ██╗███████╗██████╗ "
  echo "  ██╔════╝██║    ██║██╔══██╗╚══██╔══╝██╔════╝██║  ██║██╔════╝██╔══██╗"
  echo "  ███████╗██║ █╗ ██║███████║   ██║   ██║     ███████║█████╗  ██████╔╝"
  echo "  ╚════██║██║███╗██║██╔══██║   ██║   ██║     ██╔══██║██╔══╝  ██╔══██╗"
  echo "  ███████║╚███╔███╔╝██║  ██║   ██║   ╚██████╗██║  ██║███████╗██║  ██║"
  echo "  ╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝"
  echo -e "         Enterprise Traffic Governance & Audit Platform${NC}"
  echo ""
}

# Determine sudo requirement
SUDO_CMD="sudo"
if [ "$(id -u)" -eq 0 ] || ! command -v sudo >/dev/null 2>&1; then
  SUDO_CMD=""
fi

# Standalone Local Mode (Node.js + Embedded SQLite)
run_local() {
  print_banner
  echo -e "${GREEN}--> Launching in Standalone Local Mode (Node.js + Embedded SQLite)...${NC}"
  
  if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}[✘] Node.js is not installed!${NC}"
    echo -e "${YELLOW}Please install Node.js (v18, v20, or v22) to run locally:${NC}"
    echo -e "  - Kali / Debian / Ubuntu: ${CYAN}${SUDO_CMD} apt-get update && ${SUDO_CMD} apt-get install -y nodejs npm${NC}"
    echo -e "  - macOS:                  ${CYAN}brew install node${NC}"
    echo -e "  - Windows:                Download from https://nodejs.org"
    exit 1
  fi

  echo -e "  ${GREEN}[✔] Node.js found:${NC} $(node --version)"
  if command -v npm >/dev/null 2>&1; then
    echo -e "  ${GREEN}[✔] npm found:${NC}     $(npm --version)"
  fi

  echo -e "\n${BLUE}--> Verifying dependencies in swatcher-server...${NC}"
  cd "$SCRIPT_DIR/swatcher-server"
  if [ ! -d "node_modules" ]; then
    echo -e "  ${YELLOW}[*] Installing server packages (first-time setup)...${NC}"
    npm install
  fi

  echo ""
  echo -e "${GREEN}==============================================================================${NC}"
  echo -e "${BOLD}${GREEN}               swatcher IS LIVE (STANDALONE LOCAL MODE)                      ${NC}"
  echo -e "${GREEN}==============================================================================${NC}"
  echo ""
  echo -e "  ${BOLD}Leadership Web Dashboard:${NC}  ${CYAN}http://localhost:9090/${NC}"
  echo -e "  ${BOLD}Burp Ingestion Endpoint:${NC}   ${CYAN}http://localhost:9090/api/v1/ingest/batch${NC}"
  echo -e "  ${BOLD}Database Engine:${NC}           Embedded SQLite (${SCRIPT_DIR}/swatcher-server/data/swatcher.db)"
  echo ""
  echo -e "${BOLD}USEFUL HINT:${NC}"
  echo -e "  To run with enterprise PostgreSQL in Docker later, run: ${CYAN}./run.sh${NC}"
  echo -e "${GREEN}==============================================================================${NC}\n"

  exec npm start
}

# ------------------------------------------------------------------------------
# Subcommand Handlers
# ------------------------------------------------------------------------------
DOCKER_CMD="docker"
if ! docker info >/dev/null 2>&1; then
  if [ -n "$SUDO_CMD" ] && $SUDO_CMD docker info >/dev/null 2>&1; then
    DOCKER_CMD="$SUDO_CMD docker"
  fi
fi

COMPOSE_CMD="$DOCKER_CMD compose"
if ! $COMPOSE_CMD version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
  elif [ -n "$SUDO_CMD" ] && $SUDO_CMD docker-compose version >/dev/null 2>&1; then
    COMPOSE_CMD="$SUDO_CMD docker-compose"
  fi
fi

case "$1" in
  --local|-local)
    run_local
    ;;
  --logs|-l)
    print_banner
    echo -e "${BLUE}--> Streaming live logs for swatcher containers... (Ctrl+C to exit)${NC}"
    $COMPOSE_CMD logs -f
    exit 0
    ;;
  --status|-s)
    print_banner
    echo -e "${BLUE}--> Inspecting container status:${NC}"
    $COMPOSE_CMD ps
    exit 0
    ;;
  --stop)
    print_banner
    echo -e "${YELLOW}--> Stopping all swatcher services...${NC}"
    $COMPOSE_CMD down
    echo -e "${GREEN}[✔] Services stopped safely.${NC}"
    exit 0
    ;;
  --restart)
    print_banner
    echo -e "${BLUE}--> Restarting swatcher services...${NC}"
    $COMPOSE_CMD restart
    echo -e "${GREEN}[✔] Services restarted.${NC}"
    exit 0
    ;;
  --help|-h)
    print_banner
    echo -e "Usage: ./run.sh [option]"
    echo ""
    echo "Options:"
    echo "  (no args)    Build and launch enterprise swatcher via Docker Compose (PostgreSQL 16)"
    echo "  --local      Launch standalone local mode via Node.js + Embedded SQLite (no Docker needed)"
    echo "  --logs, -l   View streaming container logs"
    echo "  --status, -s Check running status and health of containers"
    echo "  --restart    Restart application containers"
    echo "  --stop       Gracefully stop all containers"
    echo "  --help, -h   Show this help message"
    exit 0
    ;;
esac

print_banner

# ------------------------------------------------------------------------------
# STEP 1: Verify & Install Host Prerequisites (Kali / Ubuntu / Debian / RHEL / Amazon Linux)
# ------------------------------------------------------------------------------
echo -e "${BOLD}[1/5] Checking host environment and Docker runtime...${NC}"

if command -v docker >/dev/null 2>&1; then
  echo -e "  ${GREEN}[✔] Docker is installed:${NC} $(docker --version)"
else
  echo -e "  ${YELLOW}[!] Docker not found. Detecting operating system...${NC}"

  OS_ID="unknown"
  OS_LIKE=""
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="$ID"
    OS_LIKE="${ID_LIKE:-}"
  fi

  DOCKER_INSTALLED=false

  if [[ "$OS_ID" == "amzn" ]]; then
    echo -e "  ${BLUE}--> Detected Amazon Linux ($VERSION_ID). Installing Docker...${NC}"
    if command -v dnf >/dev/null 2>&1; then
      $SUDO_CMD dnf update -y && $SUDO_CMD dnf install -y docker && DOCKER_INSTALLED=true
    else
      $SUDO_CMD yum update -y && ($SUDO_CMD amazon-linux-extras install -y docker || $SUDO_CMD yum install -y docker) && DOCKER_INSTALLED=true
    fi
  elif [[ "$OS_ID" == "rhel" || "$OS_ID" == "centos" || "$OS_ID" == "fedora" ]]; then
    echo -e "  ${BLUE}--> Detected RedHat/Fedora family. Installing Docker...${NC}"
    ($SUDO_CMD dnf install -y docker || $SUDO_CMD yum install -y docker) && DOCKER_INSTALLED=true
  elif [[ "$OS_ID" == "ubuntu" || "$OS_ID" == "debian" || "$OS_ID" == "kali" || "$OS_LIKE" =~ "debian" ]]; then
    echo -e "  ${BLUE}--> Detected Debian/Ubuntu/Kali family ($OS_ID). Installing Docker packages...${NC}"
    $SUDO_CMD apt-get update -y
    ($SUDO_CMD apt-get install -y docker.io docker-compose-plugin docker-compose || $SUDO_CMD apt-get install -y docker.io) && DOCKER_INSTALLED=true
  fi

  if [ "$DOCKER_INSTALLED" = true ]; then
    echo -e "  ${BLUE}--> Enabling and starting docker service...${NC}"
    $SUDO_CMD systemctl enable --now docker 2>/dev/null || $SUDO_CMD service docker start 2>/dev/null || true
    if [ -n "$USER" ] && [ "$USER" != "root" ]; then
      $SUDO_CMD usermod -aG docker "$USER" 2>/dev/null || true
    fi
    DOCKER_CMD="$SUDO_CMD docker"
  else
    echo -e "  ${YELLOW}[!] Automatic Docker installation not applicable for $OS_ID.${NC}"
    echo -e "  ${BLUE}--> Seamlessly falling back to Standalone Local Mode (Node.js + SQLite)...${NC}"
    run_local
  fi
fi

# Ensure Docker daemon is actively running
if ! $DOCKER_CMD info >/dev/null 2>&1; then
  echo -e "  ${BLUE}--> Starting Docker daemon service...${NC}"
  $SUDO_CMD systemctl start docker 2>/dev/null || $SUDO_CMD service docker start 2>/dev/null || true
  sleep 2
fi

if ! $DOCKER_CMD info >/dev/null 2>&1; then
  echo -e "  ${YELLOW}[!] Docker daemon could not be reached.${NC}"
  echo -e "  ${BLUE}--> Seamlessly switching to Standalone Local Mode (Node.js + Embedded SQLite)...${NC}\n"
  run_local
fi

# Check Docker Compose (v2 plugin or standalone)
if ! $DOCKER_CMD compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
  elif [ -n "$SUDO_CMD" ] && $SUDO_CMD docker-compose version >/dev/null 2>&1; then
    COMPOSE_CMD="$SUDO_CMD docker-compose"
  else
    echo -e "  ${YELLOW}[!] Docker Compose plugin not found. Installing official Compose v2 plugin...${NC}"
    DOCKER_CONFIG_DIR="/usr/local/lib/docker/cli-plugins"
    $SUDO_CMD mkdir -p "$DOCKER_CONFIG_DIR"
    ARCH=$(uname -m)
    case "$ARCH" in
      x86_64) COMPOSE_ARCH="x86_64" ;;
      aarch64|arm64) COMPOSE_ARCH="aarch64" ;;
      *) COMPOSE_ARCH="x86_64" ;;
    esac
    COMPOSE_VERSION="v2.29.7"
    echo -e "  ${BLUE}--> Downloading Docker Compose ${COMPOSE_VERSION} (${COMPOSE_ARCH})...${NC}"
    $SUDO_CMD curl -SL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}" -o "${DOCKER_CONFIG_DIR}/docker-compose" || true
    $SUDO_CMD chmod +x "${DOCKER_CONFIG_DIR}/docker-compose" 2>/dev/null || true
    COMPOSE_CMD="$DOCKER_CMD compose"
  fi
fi

if ! $COMPOSE_CMD version >/dev/null 2>&1; then
  echo -e "  ${YELLOW}[!] Docker Compose is unavailable.${NC}"
  echo -e "  ${BLUE}--> Switching to Standalone Local Mode (Node.js + Embedded SQLite)...${NC}\n"
  run_local
fi

echo -e "  ${GREEN}[✔] Docker Compose is ready:${NC} $($COMPOSE_CMD version)"

# ------------------------------------------------------------------------------
# STEP 2: Configure Environment & Cryptographic Secrets
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[2/5] Initializing application secrets and configuration...${NC}"

if [ ! -f .env ]; then
  echo -e "  ${YELLOW}[!] No .env file detected. Generating production secrets...${NC}"
  
  RANDOM_DB_PASS=$(openssl rand -hex 20 2>/dev/null || date +%s | sha256sum | head -c 40 || echo "swatcher_secure_db_pass_12948")
  RANDOM_SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null || date +%s | sha256sum | head -c 64 || echo "swatcher_session_secret_key_88412")

  cat <<EOF > .env
# ==============================================================================
# swatcher Production Environment Variables (Auto-generated)
# Generated: $(date -u +"%Y-%m-%d %H:%M:%SZ")
# ==============================================================================

# PostgreSQL Database Configuration
DB_USER=swatcher
DB_PASSWORD=${RANDOM_DB_PASS}
DB_NAME=swatcher_db

# Application Configuration
PORT=9090
SESSION_SECRET=${RANDOM_SESSION_SECRET}
DB_POOL_MAX=30
DB_SSL=false
EOF

  chmod 600 .env 2>/dev/null || true
  echo -e "  ${GREEN}[✔] Created .env with secure random passwords.${NC}"
else
  echo -e "  ${GREEN}[✔] Existing .env file found. Preserving current secrets.${NC}"
fi

# ------------------------------------------------------------------------------
# STEP 3: Build and Deploy PostgreSQL + swatcher Containers
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[3/5] Building and launching containers via Docker Compose...${NC}"
echo -e "  ${CYAN}Containers: swatcher-db (PostgreSQL 16) + swatcher-app (Node 22)${NC}"

$COMPOSE_CMD up -d --build

# ------------------------------------------------------------------------------
# STEP 4: Await Service Health
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[4/5] Waiting for database initialization and application healthcheck...${NC}"

RETRIES=30
HEALTHY=false

for i in $(seq 1 $RETRIES); do
  STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9090/health 2>/dev/null || echo "000")
  if [ "$STATUS_CODE" -eq 200 ]; then
    HEALTHY=true
    break
  fi
  echo -n "."
  sleep 2
done
echo ""

if [ "$HEALTHY" = true ]; then
  echo -e "  ${GREEN}[✔] swatcher backend & PostgreSQL are UP and healthy!${NC}"
else
  echo -e "  ${RED}[✘] Healthcheck did not pass after 60 seconds.${NC}"
  echo -e "  ${YELLOW}Inspecting application logs:${NC}"
  $COMPOSE_CMD logs --tail=25 swatcher-app
  exit 1
fi

# ------------------------------------------------------------------------------
# STEP 5: Detect Host IP and Display Ready Banner
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[5/5] Resolving network endpoints...${NC}"

PUBLIC_IP=""
IMDS_TOKEN=$(curl -s -f -m 2 -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || true)
if [ -n "$IMDS_TOKEN" ]; then
  PUBLIC_IP=$(curl -s -f -m 2 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
fi

if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP=$(curl -s -f -m 2 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
fi

if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP=$(curl -s -f -m 2 https://checkip.amazonaws.com 2>/dev/null || curl -s -f -m 2 https://ifconfig.me 2>/dev/null || echo "localhost")
  PUBLIC_IP=$(echo "$PUBLIC_IP" | tr -d '[:space:]')
fi

APP_PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d '=' -f2 | tr -d '[:space:]' || echo "9090")
if [ -z "$APP_PORT" ]; then APP_PORT="9090"; fi

echo ""
echo -e "${GREEN}==============================================================================${NC}"
echo -e "${BOLD}${GREEN}               swatcher IS LIVE AND OPERATIONAL!                             ${NC}"
echo -e "${GREEN}==============================================================================${NC}"
echo ""
echo -e "  ${BOLD}Leadership Web Dashboard:${NC}  ${CYAN}http://${PUBLIC_IP}:${APP_PORT}/${NC}"
echo -e "  ${BOLD}Burp Ingestion Endpoint:${NC}   ${CYAN}http://${PUBLIC_IP}:${APP_PORT}/api/v1/ingest/batch${NC}"
echo -e "  ${BOLD}Key Verification API:${NC}      ${CYAN}http://${PUBLIC_IP}:${APP_PORT}/api/v1/auth/verify-key${NC}"
echo -e "  ${BOLD}Database Engine:${NC}           PostgreSQL 16 (Enterprise Persistent Volume)"
echo ""
echo -e "${BOLD}FIRST-TIME INITIALIZATION STEPS:${NC}"
echo -e "  1. Open ${CYAN}http://${PUBLIC_IP}:${APP_PORT}/${NC} in your browser."
echo -e "  2. You will be greeted by the ${BOLD}First-Time Setup Wizard${NC}."
echo -e "  3. Create your initial Leadership Admin account (enforces password complexity: min 10 chars,"
echo -e "     1 uppercase, 1 lowercase, 1 number, 1 special character)."
echo -e "  4. Navigate to the ${BOLD}Pentesters Profile${NC} tab to register testers and generate API keys."
echo -e "  5. Share the generated keys (${BOLD}sw_live_...${NC}) with pentesters for their Burp extensions."
echo ""
echo -e "${BOLD}USEFUL MANAGEMENT COMMANDS:${NC}"
echo -e "  View Live Logs:    ${CYAN}./run.sh --logs${NC}"
echo -e "  Check Status:      ${CYAN}./run.sh --status${NC}"
echo -e "  Restart Services:  ${CYAN}./run.sh --restart${NC}"
echo -e "  Stop Services:     ${CYAN}./run.sh --stop${NC}"
echo -e "${GREEN}==============================================================================${NC}"
echo ""
