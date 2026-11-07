# swatcher 🛰️
> **Enterprise Burp Suite Traffic Governance, Audit Trail & Pentester Proof-of-Work Platform**

`swatcher` provides automated AppSec operational visibility across a team of 50+ pentesters executing 100+ pentests monthly:
1. **Audit & Incident Protection:** Complete timestamped audit log of every HTTP request sent during an engagement to prove what was tested.
2. **Effort & Progress Tracking:** Real-time progress bars showing active testing hours completed vs budgeted effort (e.g., 28 / 40 hrs).
3. **True Proof-of-Work:** Intelligently separates deep **Manual Testing** (Repeater/Proxy) from **Automated Scans** (Scanner/Intruder).
4. **Append-Only Multi-Tester Collaboration:** Multiple pentesters can work on the same `RITM` simultaneously without overwriting data.
5. **Enterprise CA & Proxy Integration:** Built-in compatibility with corporate inspection proxies (McAfee Web Gateway, Skyhigh, Zscaler, BlueCoat) and internal enterprise PKIs with forward proxy routing.
6. **Immunity & Scaffolding Exclusion:** Automatically exempts self-traffic, Burp Collaborator/OAST domains (`*.burpcollaborator.net`, `*.oastify.com`, `*.interactsh.com`), and loopback addresses to eliminate feedback loops.
7. **Offline Queue & Replay:** Buffers traffic locally to an encrypted/safe disk queue when central server is unreachable, automatically draining when connection resumes.
8. **Air-Gapped Ready:** Central leadership dashboard is 100% self-contained with offline vendor assets (Chart.js, Tailwind, FontAwesome) and strict defensive CSP.
9. **Zero-Friction Project Persistence:** Details saved directly into the Burp `.burp` project file. Open an existing project and it **auto-resumes recording silently**!
10. **Enterprise Token Security:** Ingestion requests authenticate with cryptographically random API tokens (`Bearer sw_live_...`). Pentester identity is derived server-side to prevent header spoofing.
11. **Production Grade:** Built on **PostgreSQL 16** with enterprise connection pooling, persistent storage volumes, and high-throughput indexes.

---

## Architecture & Data Flow

```
  +-------------------------------------------------------------+
  |              Pentester Workstation (Burp Suite)             |
  |                                                             |
  |  [Proxy] [Repeater] [Scanner] [Intruder] [Extensions]       |
  |                            │                                |
  |                            ▼                                |
  |            swatcher Burp Extension (Montoya API)            |
  |              - In-scope traffic detection                   |
  |              - Auto-resumes from .burp project file         |
  |              - Prompt on new project for RITM & Effort      |
  |              - Bearer API Token Authentication              |
  +----------------------------│--------------------------------+
                               │ HTTPS / JSON Batch (Bearer Token)
                               ▼
  +-------------------------------------------------------------+
  |              AWS EC2 Instance (Amazon Linux 2023)           |
  |                                                             |
  |  [Docker Compose]                                           |
  |   ├── swatcher-app (:9090 Node 22 API & Leadership UI)      |
  |   └── swatcher-db  (:5432 PostgreSQL 16 on EBS Volume)      |
  |                                                             |
  |              [ Leadership Operations Dashboard ]            |
  |    - 4 Core KPI Cards (Pentesters, In-Progress, Hours MTD)  |
  |    - Progress Bars (% Completed vs Allocated Hours)         |
  |    - Pentester Profile & Key Management (Generate & Copy)   |
  |    - First-Time Admin Setup Wizard (Password Complexity)    |
  |    - Full Audit Trail (Login Sessions, Activity Tracking)   |
  +-------------------------------------------------------------+
```

---

## 🚀 1-Click Production Deployment on AWS EC2 (Amazon Linux 2023 / AL2)

### Target Host Recommendation
* **Instance Type:** `t3.xlarge` (4 vCPU, 16 GiB RAM)
* **OS:** **Amazon Linux 2023 (AL2023)** (or Amazon Linux 2 / RHEL / Ubuntu)
* **Storage:** 100 GB `gp3` EBS volume (for long-term traffic log retention)
* **Inbound Security Group Rules:**
  - Inbound TCP `9090` (or `443` if terminating SSL via Nginx / ALB) from internal leadership and pentester subnets.
  - Inbound TCP `22` (SSH) restricted to admin bastion.

---

### Step 1: Deploy with `./run.sh`

SSH into your Amazon Linux EC2 instance, copy or clone this repository, and execute:

```bash
chmod +x run.sh
./run.sh
```

**What the automated runner script does:**
1. Detects Amazon Linux (`dnf` on AL2023 / `yum` on AL2) and installs Docker and the Docker Compose v2 plugin if not already installed.
2. Enables and starts the `docker` systemd service and adds the current user to the `docker` group.
3. Automatically generates cryptographically secure passwords for PostgreSQL and the application session secret in `.env` (with `chmod 600` permissions).
4. Launches the container stack (`postgres:16-alpine` + `swatcher-server` Node.js container) with optimized PostgreSQL memory buffers for `t3.xlarge` (2GB shared buffers, 6GB effective cache).
5. Waits for health checks to pass and outputs your public endpoints!

---

### Step 2: Management Commands

```bash
# View live streaming application logs
./run.sh --logs

# Check container health and status
./run.sh --status

# Restart all services
./run.sh --restart

# Stop all containers safely (data persists in postgres volume)
./run.sh --stop
```

---

## First-Time Leadership Dashboard Setup

1. Open your browser and navigate to:
   ```
   http://<EC2-PUBLIC-IP>:9090
   ```
2. Because the database is brand new, the **First-Time Setup Wizard** will prompt you to create the initial Leadership Admin account.
3. Enter your details and set a strong master password (enforces min 10 characters, 1 uppercase, 1 lowercase, 1 number, and 1 special character).
4. Once logged in, visit the **Pentesters Profile** tab to register your security team members.
5. Click **Generate API Key** for each pentester and copy the token (`sw_live_...`) to securely distribute to them.

---

## Pentester Burp Extension Setup

### 1. Build Fat JAR
```bash
cd swatcher-extension
./gradlew jar
# Produces: release/swatcher-1.2.2.jar (or swatcher-extension/build/libs/swatcher-1.2.2.jar)
```

### 2. Install in Burp Suite
1. In Burp Suite Pro, navigate to **Extensions** -> **Installed** -> **Add**.
2. Select **Extension type: Java** and choose `release/swatcher-1.2.2.jar`.
3. On first launch:
   - Enter Central Server URL: `http://<EC2-PUBLIC-IP>:9090` (or `https://...`).
   - Enter your assigned API Key: `sw_live_...`.
   - (Optional) Configure **Corporate Proxy** (e.g. `proxy.corp.internal:8080`) if your organization routes traffic through McAfee, Skyhigh, or Zscaler.
   - (Optional) Ensure **Trust Enterprise CAs** is checked if your enterprise uses custom internal TLS decryption.
   - Click **Verify & Save Token**. The extension displays:
     ```
     [swatcher] Welcome back, <Pentester Name>! Connection established.
     ```
4. The API key and enterprise settings are stored **once** globally on the workstation in Burp preferences.

### 3. Engagement Workflow
* **New Project:** When opening a new Burp project file, the extension prompts for:
  - **RITM Number** (e.g. `RITM0049281`)
  - **Application ID** (e.g. `APP-PAYMENTS-V2`)
  - **Allocated Hours** (e.g. `40`)
* **Saved Project:** When opening an existing `.burp` file, swatcher **automatically restores all parameters and resumes recording silently**!

---

## Production Nginx Reverse Proxy (SSL / HTTPS)

To serve the dashboard and API over HTTPS on standard port 443 with an SSL certificate:

1. Copy the provided Nginx configuration:
   ```bash
   sudo cp nginx/swatcher.conf /etc/nginx/conf.d/swatcher.conf
   ```
2. Edit `/etc/nginx/conf.d/swatcher.conf` with your corporate domain or run Certbot:
   ```bash
   sudo certbot --nginx -d swatcher.yourcompany.internal
   ```
3. Reload Nginx:
   ```bash
   sudo systemctl reload nginx
   ```
*(The Nginx configuration already includes `client_max_body_size 50M;` to support large Burp batch traffic uploads).*

---

## 💻 Cross-Platform Quick Start (Windows, Kali Linux, macOS)

`swatcher` is powered by **PostgreSQL 16** and deploys seamlessly via Docker Compose across all platforms:

### Windows (PowerShell or CMD)
```cmd
# Double-click or run in Command Prompt:
run.bat

# Or run in PowerShell:
.\run.ps1
```

### Kali Linux, Debian, Ubuntu & macOS
```bash
chmod +x run.sh
./run.sh
```

### Local Development (with Local PostgreSQL)
If you already run a local PostgreSQL service on your machine:
```bash
# 1. Provide your local PostgreSQL credentials (or in .env)
export DATABASE_URL="postgres://swatcher:swatcher_password@localhost:5432/swatcher_db"

# 2. Install dependencies
npm run install:server

# 3. Seed realistic demo data (optional)
npm run seed

# 4. Start swatcher on port 9090
npm start
```
