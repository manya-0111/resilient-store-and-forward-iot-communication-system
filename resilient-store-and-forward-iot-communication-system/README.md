# Resilient Store-and-Forward IoT Communication System

Complete end-to-end monitoring, security, persistent store-and-forward queue management, machine learning analytics, and 8-scenario verification dashboard for the three-node ESP32 IoT communication architecture.

## System Architecture

1. **Node 1 — Sensor & Transmitter (ESP32)**
   - Sensors: Raindrop sensor (surface wetness ADC, classified as `DRY` / `NORMAL` / `HEAVY`) + DHT11 temperature & humidity.
   - Deterministic priority scheduling: `HEAVY` rain alerts receive Priority 1 ahead of routine temperature/humidity readings without discarding routine packets.
   - End-to-end encryption: AES-128-GCM with unique 96-bit (12-byte) nonces and AAD. Retries retransmit identical encrypted bytes.
   - Hybrid communication: Wi-Fi preferred with hysteresis (RSSI, packet loss, ACK latency, failed attempts), automatic bidirectional LoRa fallback, and LittleFS local offline queue.
2. **Node 2 — Central Store-and-Forward Gateway (ESP32)**
   - Receives encrypted packets via Wi-Fi or bidirectional LoRa transceiver.
   - Validates framing, detects & suppresses duplicates, flushes ciphertext durably to 16 GB microSD (FAT32) **before** sending Hop-1 ACK to Node 1.
   - Never decrypts sensor payloads; independently queues and forwards opaque ciphertext to Node 3 over Wi-Fi.
3. **Node 3 — Destination Receiver (ESP32)**
   - Validates packet envelope and verifies AES-128-GCM authentication tag & AAD before accepting or displaying plaintext.
   - Updates I2C 16×2 LCD only on valid authentication and sends Hop-2 ACK to Node 2.
   - Rejects tampered/invalid payloads without updating the LCD or sending a success ACK.
4. **Analytics Server, SQLite Database & Dashboard**
   - Persistent SQLite database (`./data/resilient_iot.db`) with strict separation between **Simulation (DEMO MODE)** and **Live Hardware Mode**.
   - **ML Module A (Network Quality)**: Random Forest Classifier (`GOOD` / `MODERATE` / `POOR`) compared against a deterministic Rule-Based Baseline using session-grouped holdout evaluation.
   - **ML Module B (Sensor Anomaly Detection)**: Isolation Forest flagging `ANOMALY / NEEDS CHECK` while preserving all original readings. Heavy-rain priority remains strictly deterministic outside ML.
   - ML and the dashboard are strictly observer/advisory layers and never replace ACKs, retries, AES-GCM verification, or persistent storage guarantees.

---

## Quick Start (Integrated Full-Stack App — Port 3000)

### Required Software
- Node.js v22+ (includes built-in `node:sqlite`)
- Optional for local laptop Python Flask mode: Python 3.11+ with `pip`

### Installation & Startup
```bash
npm install
npm run dev
```
Open in browser: `http://localhost:3000`

### Production Build & Start
```bash
npm run build
npm start
```

### Optional Standalone Python Flask + scikit-learn Backend (Local Laptop Deployment)
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export IOT_AES_KEY_HEX=$(openssl rand -hex 16)
python app.py
```

---

## Operating Modes

- **Simulation Mode (`DEMO MODE`)**: Demonstrates all 3 nodes, Wi-Fi/LoRa fallback with hysteresis, LittleFS & microSD store-and-forward queues, duplicate suppression, AES-128-GCM encryption & tamper rejection, ML analytics, and all 8 PDF Page 12 System Test Cases without physical hardware.
- **Live Hardware Mode (`LIVE ESP32`)**: Displays strictly physical ESP32 records ingested via the `/api/node1/*`, `/api/node2/*`, and `/api/node3/*` REST endpoints. Unconnected nodes display `NOT_CONNECTED` and simulation data is never mixed into hardware views.

## Core REST API Endpoints

- `GET /api/health` — Backend, SQLite, ML & security health
- `GET /api/status` — Dashboard summary KPIs, node states, sensors & links
- `GET /api/nodes` — Per-node heartbeat and connectivity state
- `GET /api/sensors/latest`, `GET /api/sensors/history` — Authenticated Node 3 telemetry
- `POST /api/node1/sensor-data`, `POST /api/node1/packet`, `POST /api/node1/ack` — ESP32 Node 1 ingestion
- `POST /api/node2/packet-received`, `POST /api/node2/network-metrics`, `POST /api/node2/storage-status`, `POST /api/node2/forward` — ESP32 Node 2 gateway ingestion
- `POST /api/node3/packet-received`, `POST /api/node3/authentication`, `POST /api/node3/ack` — ESP32 Node 3 receiver ingestion
- `GET /api/packets`, `GET /api/packets/pending`, `GET /api/queues`, `GET /api/storage`, `GET /api/security`
- `GET /api/ml/network`, `GET /api/ml/anomaly`, `GET /api/history`, `GET /api/alerts`
- `GET /api/tests`, `POST /api/tests/run`, `POST /api/tests/reset` — All 8 PDF Page 12 acceptance tests
- `POST /api/simulation/start|pause|resume|reset|control`, `GET /api/simulation/status`
- `GET /api/export/csv?mode=simulation&type=sensors|network|packets|security` — CSV export
