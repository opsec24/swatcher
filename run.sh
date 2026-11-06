#!/usr/bin/env bash
# ==============================================================================
# swatcher - Enterprise Deployment and Runner Script
# Targeted for: Amazon Linux 2023 / Amazon Linux 2 / RHEL / Ubuntu EC2 instances
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

# ------------------------------------------------------------------------------
# Subcommand Handlers: --logs, --status, --stop, --restart
# ------------------------------------------------------------------------------
DOCKER_CMD="docker"
if ! docker info >/dev/null 2>&1; then
  if sudo docker info >/dev/null 2>&1; then
    DOCKER_CMD="sudo docker"
  fi
fi

COMPOSE_CMD="$DOCKER_CMD compose"
if ! $COMPOSE_CMD version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
  elif command -v sudo >/dev/null 2>&1 && sudo docker-compose version >/dev/null 2>&1; then
    COMPOSE_CMD="sudo docker-compose"
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
  --help|-h)
    print_banner
    echo -e "Usage: ./run.sh [option]"
    echo ""
    echo "Options:"
    echo "  (no args)    Install dependencies (if missing), build and launch swatcher"
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
# STEP 1: Verify & Install Host Prerequisites (Amazon Linux / RHEL / Ubuntu)
# ------------------------------------------------------------------------------
echo -e "${BOLD}[1/5] Checking host environment and Docker runtime...${NC}"

if command -v docker >/dev/null 2>&1; then
  echo -e "  ${GREEN}[✔] Docker is installed:${NC} $(docker --version)"
else
  echo -e "  ${YELLOW}[!] Docker not found. Detecting OS and installing...${NC}"

  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="$ID"
    OS_VER="$VERSION_ID"
  else
    OS_ID="unknown"
  fi

  if [[ "$OS_ID" == "amzn" ]]; then
    echo -e "  ${BLUE}--> Detected Amazon Linux ($OS_VER). Installing Docker via package manager...${NC}"
    if command -v dnf >/dev/null 2>&1; then
      sudo dnf update -y
      sudo dnf install -y docker
    else
      sudo yum update -y
      sudo amazon-linux-extras install -y docker || sudo yum install -y docker
    fi
  elif [[ "$OS_ID" == "rhel" || "$OS_ID" == "centos" || "$OS_ID" == "fedora" ]]; then
    echo -e "  ${BLUE}--> Detected RedHat/Fedora family. Installing Docker...${NC}"
    sudo dnf install -y docker || sudo yum install -y docker
  elif [[ "$OS_ID" == "ubuntu" || "$OS_ID" == "debian" ]]; then
    echo -e "  ${BLUE}--> Detected Debian/Ubuntu family. Installing Docker...${NC}"
    sudo apt-get update -y
    sudo apt-get install -y docker.io docker-compose-plugin
  else
    echo -e "${RED}[✘] Unsupported OS for automatic Docker installation. Please install Docker manually.${NC}"
    exit 1
  fi

  echo -e "  ${BLUE}--> Enabling and starting docker systemd service...${NC}"
  sudo systemctl enable --now docker
  echo -e "  ${BLUE}--> Adding current user ($USER) to docker group...${NC}"
  sudo usermod -aG docker "$USER" || true
  DOCKER_CMD="sudo docker"
fi

# Ensure Docker daemon is actively running
if ! $DOCKER_CMD info >/dev/null 2>&1; then
  echo -e "  ${BLUE}--> Starting Docker service...${NC}"
  sudo systemctl start docker || sudo service docker start || true
  sleep 2
fi

# Check Docker Compose (v2 plugin or standalone)
if ! $DOCKER_CMD compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
  else
    echo -e "  ${YELLOW}[!] Docker Compose plugin not found. Installing official Compose v2 plugin...${NC}"
    DOCKER_CONFIG_DIR="/usr/local/lib/docker/cli-plugins"
    sudo mkdir -p "$DOCKER_CONFIG_DIR"
    ARCH=$(uname -m)
    case "$ARCH" in
      x86_64) COMPOSE_ARCH="x86_64" ;;
      aarch64|arm64) COMPOSE_ARCH="aarch64" ;;
      *) COMPOSE_ARCH="x86_64" ;;
    esac
    COMPOSE_VERSION="v2.29.7"
    echo -e "  ${BLUE}--> Downloading Docker Compose ${COMPOSE_VERSION} (${COMPOSE_ARCH})...${NC}"
    sudo curl -SL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}" -o "${DOCKER_CONFIG_DIR}/docker-compose"
    sudo chmod +x "${DOCKER_CONFIG_DIR}/docker-compose"
    COMPOSE_CMD="$DOCKER_CMD compose"
  fi
fi

echo -e "  ${GREEN}[✔] Docker Compose is ready:${NC} $($COMPOSE_CMD version)"

# ------------------------------------------------------------------------------
# STEP 2: Configure Environment & Cryptographic Secrets
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[2/5] Initializing application secrets and configuration...${NC}"

if [ ! -f .env ]; then
  echo -e "  ${YELLOW}[!] No .env file detected. Generating production secrets...${NC}"
  
  # Generate cryptographically secure random credentials
  RANDOM_DB_PASS=$(openssl rand -hex 20 2>/dev/null || date +%s | sha256sum | head -c 40)
  RANDOM_SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null || date +%s | sha256sum | head -c 64)

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

  chmod 600 .env
  echo -e "  ${GREEN}[✔] Created .env with secure random passwords (chmod 600).${NC}"
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
  # Test health endpoint locally on port 9090
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

# Detect Public IP using AWS IMDSv2 -> IMDSv1 -> External fallback
PUBLIC_IP=""
IMDS_TOKEN=$(curl -s -f -m 2 -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || true)
if [ -n "$IMDS_TOKEN" ]; then
  PUBLIC_IP=$(curl -s -f -m 2 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
fi

if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP=$(curl -s -f -m 2 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
fi

if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP=$(curl -s -f -m 2 https://checkip.amazonaws.com 2>/dev/null || curl -s -f -m 2 https://ifconfig.me 2>/dev/null || echo "127.0.0.1")
  # Strip trailing newline if any
  PUBLIC_IP=$(echo "$PUBLIC_IP" | tr -d '[:space:]')
fi

# Read PORT from .env or default to 9090
APP_PORT=$(grep -E '^PORT=' .env | cut -d '=' -f2 | tr -d '[:space:]' || echo "9090")
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
echo -e "${BOLD}AWS SECURITY GROUP REMINDER:${NC}"
echo -e "  Ensure your EC2 Security Group permits inbound TCP traffic on port ${BOLD}${APP_PORT}${NC}"
echo -e "  from leadership workstations and pentester IP addresses."
echo ""
echo -e "${BOLD}USEFUL MANAGEMENT COMMANDS:${NC}"
echo -e "  View Live Logs:    ${CYAN}./run.sh --logs${NC}"
echo -e "  Check Status:      ${CYAN}./run.sh --status${NC}"
echo -e "  Restart Services:  ${CYAN}./run.sh --restart${NC}"
echo -e "  Stop Services:     ${CYAN}./run.sh --stop${NC}"
echo -e "${GREEN}==============================================================================${NC}"
echo ""
