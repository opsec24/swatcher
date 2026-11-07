#!/usr/bin/env bash
# ==============================================================================
# swatcher - Enterprise Deployment and Runner Script
# Targeted for: Kali Linux, Ubuntu, Debian, Amazon Linux, RHEL, Fedora, macOS
# Database Engine: PostgreSQL 16 (Enterprise Persistent Volume)
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
  echo -e "       Enterprise Traffic Governance & Audit Platform (PostgreSQL 16)${NC}"
  echo ""
}

# Determine sudo requirement
SUDO_CMD="sudo"
if [ "$(id -u)" -eq 0 ] || ! command -v sudo >/dev/null 2>&1; then
  SUDO_CMD=""
fi

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
    echo -e "${GREEN}[✔] Services stopped safely. Data persists in postgres volume.${NC}"
    exit 0
    ;;
  --restart)
    print_banner
    echo -e "${BLUE}--> Restarting swatcher services...${NC}"
    $COMPOSE_CMD restart
    echo -e "${GREEN}[✔] Services restarted.${NC}"
    exit 0
    ;;
  --reset)
    print_banner
    echo -e "${RED}--> Resetting swatcher: destroying containers and persistent PostgreSQL volume...${NC}"
    $COMPOSE_CMD down -v
    rm -f .env
    echo -e "${GREEN}[✔] Clean reset complete. Re-run ./run.sh to initialize fresh.${NC}"
    exit 0
    ;;
  --help|-h)
    print_banner
    echo -e "Usage: ./run.sh [option]"
    echo ""
    echo "Options:"
    echo "  (no args)    Build and launch enterprise swatcher via Docker Compose (PostgreSQL 16)"
    echo "  --logs, -l   View streaming container logs"
    echo "  --status, -s Check running status and health of containers"
    echo "  --restart    Restart application containers"
    echo "  --reset      Destroy containers and volume for a clean fresh start"
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
    echo -e "${RED}[✘] Could not automatically install Docker on $OS_ID.${NC}"
    echo -e "${YELLOW}swatcher requires PostgreSQL 16 via Docker. Please install Docker manually:${NC}"
    echo -e "  - Kali / Debian: ${CYAN}${SUDO_CMD} apt-get install -y docker.io docker-compose-plugin${NC}"
    echo -e "  - Arch:          ${CYAN}${SUDO_CMD} pacman -S docker docker-compose${NC}"
    echo -e "  - macOS:         ${CYAN}brew install --cask docker${NC}"
    exit 1
  fi
fi

# Ensure Docker daemon is actively running
if ! $DOCKER_CMD info >/dev/null 2>&1; then
  echo -e "  ${BLUE}--> Starting Docker daemon service...${NC}"
  $SUDO_CMD systemctl start docker 2>/dev/null || $SUDO_CMD service docker start 2>/dev/null || true
  sleep 2
fi

if ! $DOCKER_CMD info >/dev/null 2>&1; then
  echo -e "${RED}[✘] Docker daemon is not active.${NC}"
  echo -e "${YELLOW}Please start Docker daemon via: ${CYAN}${SUDO_CMD} systemctl start docker${NC}"
  exit 1
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
  echo -e "${RED}[✘] Docker Compose is unavailable.${NC}"
  echo -e "${YELLOW}Please install docker-compose or the docker-compose-plugin package.${NC}"
  exit 1
fi

echo -e "  ${GREEN}[✔] Docker Compose is ready:${NC} $($COMPOSE_CMD version)"

# ------------------------------------------------------------------------------
# STEP 2: Configure Environment & Cryptographic Secrets
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[2/5] Initializing PostgreSQL credentials and secrets...${NC}"

if [ ! -f .env ]; then
  echo -e "  ${YELLOW}[!] No .env file detected. Generating secure PostgreSQL secrets...${NC}"
  
  RANDOM_DB_PASS=$(openssl rand -hex 20 2>/dev/null || date +%s | sha256sum | head -c 40 || echo "swatcher_secure_db_pass_12948")
  RANDOM_SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null || date +%s | sha256sum | head -c 64 || echo "swatcher_session_secret_key_88412")

  cat <<EOF > .env
# ==============================================================================
# swatcher Production Environment Variables (PostgreSQL 16)
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
  echo -e "  ${GREEN}[✔] Created .env with secure random PostgreSQL passwords.${NC}"
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
# STEP 4: Synchronize PostgreSQL Credentials & Await Service Health
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[4/5] Synchronizing PostgreSQL credentials and verifying application health...${NC}"

CURRENT_DB_USER=$(grep -E '^DB_USER=' .env 2>/dev/null | cut -d '=' -f2 | tr -d '[:space:]' || echo "swatcher")
CURRENT_DB_PASS=$(grep -E '^DB_PASSWORD=' .env 2>/dev/null | cut -d '=' -f2 | tr -d '[:space:]' || echo "")
CURRENT_DB_NAME=$(grep -E '^DB_NAME=' .env 2>/dev/null | cut -d '=' -f2 | tr -d '[:space:]' || echo "swatcher_db")

# Wait for swatcher-db to accept local connections
for j in $(seq 1 15); do
  if $DOCKER_CMD exec -i swatcher-db pg_isready -U "$CURRENT_DB_USER" -d "$CURRENT_DB_NAME" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Synchronize PostgreSQL user password (prevents password drift if .env was regenerated while volume persisted)
if [ -n "$CURRENT_DB_PASS" ]; then
  $DOCKER_CMD exec -i swatcher-db psql -U "$CURRENT_DB_USER" -d "$CURRENT_DB_NAME" -c "ALTER USER \"$CURRENT_DB_USER\" WITH PASSWORD '$CURRENT_DB_PASS';" >/dev/null 2>&1 || true
  # Ensure swatcher-app reconnects with the synced credentials
  $COMPOSE_CMD restart swatcher-app >/dev/null 2>&1 || true
fi

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
# STEP 5: Display Ready Banner
# ------------------------------------------------------------------------------
APP_PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d '=' -f2 | tr -d '[:space:]' || echo "9090")
if [ -z "$APP_PORT" ]; then APP_PORT="9090"; fi

echo ""
echo -e "${GREEN}==============================================================================${NC}"
echo -e "${BOLD}${GREEN}               swatcher IS LIVE AND OPERATIONAL!                             ${NC}"
echo -e "${GREEN}==============================================================================${NC}"
echo ""
echo -e "  ${BOLD}Leadership Web Dashboard:${NC}  ${CYAN}http://0.0.0.0:${APP_PORT}/${NC}  (or http://localhost:${APP_PORT}/)"
echo -e "  ${BOLD}Burp Ingestion Endpoint:${NC}   ${CYAN}http://0.0.0.0:${APP_PORT}/api/v1/ingest/batch${NC}"
echo -e "  ${BOLD}Key Verification API:${NC}      ${CYAN}http://0.0.0.0:${APP_PORT}/api/v1/auth/verify-key${NC}"
echo -e "  ${BOLD}Database Engine:${NC}           PostgreSQL 16 (Enterprise Persistent Volume)"
echo ""
echo -e "${BOLD}FIRST-TIME INITIALIZATION STEPS:${NC}"
echo -e "  1. Open ${CYAN}http://0.0.0.0:${APP_PORT}/${NC} (or ${CYAN}http://localhost:${APP_PORT}/${NC}) in your browser."
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
