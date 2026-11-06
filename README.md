# swatcher 🛰️
> **Enterprise Burp Suite Traffic Governance, Audit Trail & Pentester Proof-of-Work Platform**

`swatcher` provides automated AppSec operational visibility across a team of 50+ pentesters executing 100+ pentests monthly:
1. **Audit & Incident Protection:** Complete timestamped audit log of every HTTP request sent during an engagement to prove what was tested.
2. **Effort & Progress Tracking:** Real-time progress bars showing active testing hours completed vs budgeted effort (e.g., 28 / 40 hrs).
3. **True Proof-of-Work:** Intelligently separates deep **Manual Testing** (Repeater/Proxy) from **Automated Scans** (Scanner/Intruder).
4. **Append-Only Multi-Tester Collaboration:** Multiple pentesters can work on the same `RITM` simultaneously without overwriting data.
5. **Zero-Friction Project Persistence:** Details saved directly into the Burp `.burp` project file. Open an existing project and it **auto-resumes recording silently**!
6. **Enterprise Token Security:** Ingestion requests authenticate with cryptographically random API tokens (`Bearer sw_live_...`). Pentester identity is derived server-side to prevent header spoofing.

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
  |                swatcher Central Server (:9090)              |
  |                                                             |
  |  [ Ingestion API ] ──► [ Token Validation & Ingestion DB ]  |
  |                                                             |
  |              [ Leadership Operations Dashboard ]            |
  |    - Effort Progress Bars (% Completed vs Allocated Hours)  |
  |    - Pentester Profile & Key Management (Generate & Copy)   |
  |    - Multi-Tester Collaboration on Shared RITMs             |
  |    - Traffic Log Explorer & Full Payload Inspection         |
  +-------------------------------------------------------------+
```

---

## Key Enterprise Capabilities

### 1. Project Persistence (.burp File Scope)
* **Global Preferences (`preferences()`):** Server URL (`http://localhost:9090`) and Pentester API Token are stored globally on the tester's machine. They only enter their token **once**.
* **Project Scope (`extensionData()`):** The `RITM`, `Application ID`, `Allocated Effort`, and `Recording State` are stored directly inside the active `.burp` project file on disk.
* **Auto-Resume:** Opening an existing saved `.burp` file automatically continues traffic recording with zero prompts.

### 2. Multi-Tester Collaboration & RITM Rules
* **Application Multi-Tenancy:** One `Application ID` (e.g. `APP-PAYMENTS-V2`) can host multiple `RITM`s over time (e.g., Q3 assessment, Q4 re-test).
* **Append-Only Merging:** When Pentester B starts testing `RITM0049281` (already started by Pentester A), the server appends Pentester B's traffic to the same engagement without resetting hours or overwriting metadata.

### 3. API Token Authentication (Anti-Spoofing)
* No client username headers are trusted.
* Each pentester is issued a unique token (`sw_live_...`) created in the Leadership Dashboard.
* The server authenticates the token and binds the traffic to that pentester's profile.

---

## Quick Start

### 1. Central Server & Leadership Dashboard
```bash
cd swatcher-server
npm install
# Seed realistic demonstration team & traffic
npm run seed
# Start server on port 9090 (leaving 8080 free for Burp Proxy!)
npm start
```
Dashboard available at: **`http://localhost:9090`**

### 2. Burp Extension Build & Install
```bash
cd swatcher-extension
./gradlew jar
# The fat JAR is generated at:
# build/libs/swatcher-1.0.0.jar
```
Load into Burp Suite via **Extensions** -> **Installed** -> **Add** (Java).
