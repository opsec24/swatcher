# swatcher 🛰️

Centralized traffic logging and engagement tracking for Burp Suite. Captures in-scope HTTP traffic from testers, tracks active testing hours against allocated budgets, and provides a central dashboard for team visibility.

---

## Architecture

- **Central Server**: Node.js & PostgreSQL backend providing the ingestion API and web dashboard.
- **Burp Extension**: Java extension (Montoya API) that logs in-scope traffic, buffers data locally if offline, and streams records to the central server.

---

## 1. Central Server Setup

The server runs on Docker with PostgreSQL 16.

### Start the Server

```bash
chmod +x run.sh
./run.sh
```

*(On Windows, run `run.bat` or `.\run.ps1`)*

The script checks for Docker, creates a `.env` configuration file with random secrets if one doesn't exist, and starts both the database and application containers on port `9090`.

Dashboard URL: `http://<SERVER-IP>:9090`

### Server Management Commands

```bash
./run.sh --logs       # View live streaming server logs
./run.sh --status     # Check container health and status
./run.sh --update     # Pull latest release from git and rebuild container without cache
./run.sh --restart    # Restart containers
./run.sh --stop       # Stop containers safely (data persists in postgres volume)
./run.sh --reset      # Wipe containers and database volume for a clean start
```

### Initial Dashboard Setup

1. Open `http://<SERVER-IP>:9090` in your browser.
2. Complete the initial setup wizard to create the admin account.
3. In the dashboard, navigate to **Pentesters Profile** to add testers and generate their API keys (`sw_live_...`).

---

## 2. Burp Suite Extension Setup

### Install the Extension

1. Download `swatcher-1.2.2.jar` from the [Releases](https://github.com/opsec24/swatcher/releases) page or use `release/swatcher-1.2.2.jar` (or build locally: `cd swatcher-extension && ./gradlew jar`).
2. In Burp Suite Pro, go to **Extensions** > **Installed** > **Add**.
3. Set **Extension type** to `Java` and select `swatcher-1.2.2.jar`.

### Configure Connection

In the **swatcher** tab inside Burp Suite:
1. **Central Server URL**: `http://<SERVER-IP>:9090` (or `https://...`).
2. **API Key**: Enter the key generated from the dashboard.
3. *(Optional)* **Corporate Proxy**: If your workstation routes traffic through an enterprise forward proxy (e.g. McAfee, Zscaler), enter `host:port`.
4. *(Optional)* **Trust Enterprise CAs**: Check this if your organization uses custom internal certificates.
5. Click **Verify & Save Token**. The status will display your tester name and confirm the connection.

### Daily Workflow

- **New Engagement**: Open a Burp project. The extension prompts for:
  - **RITM / Ticket Number** (e.g. `RITM0012345`)
  - **Application ID** (e.g. `APP-PAYMENTS`)
  - **Allocated Hours** (e.g. `40`)
- **Existing Project**: Reopening a saved `.burp` file automatically restores engagement details and resumes recording.
- **Offline Failover**: If the central server is unreachable, traffic is safely queued to disk locally and automatically drained once reconnected.

---

## 3. Help & Troubleshooting

### Verify Server Health
Check the server health endpoint from any machine:
```bash
curl -s http://<SERVER-IP>:9090/health
```
Expected output:
```json
{"status":"UP","service":"swatcher-server","db_type":"postgresql","version":"1.2.2", ...}
```

### Updating the Server
To pull the latest fixes and rebuild on any host:
```bash
./run.sh --update
```

### Ingestion Errors (HTTP 500)
If the Burp extension activity log displays an ingestion upload error:
1. Check container logs on the server:
   ```bash
   ./run.sh --logs
   ```
2. Make sure the server is running v1.2.2+ where null bytes (`0x00`) and binary payloads are automatically sanitized for PostgreSQL.

### HTTPS & Reverse Proxy
To serve the dashboard and API over HTTPS on standard port 443, a sample Nginx reverse proxy configuration is provided in `nginx/swatcher.conf` (pre-configured with `client_max_body_size 50M;` for batch uploads).
