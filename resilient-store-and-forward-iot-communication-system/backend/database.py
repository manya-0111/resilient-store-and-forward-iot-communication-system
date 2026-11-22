"""Complete SQLite persistence layer (13 core tables + system_settings) for Python Flask backend."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
import sqlite3

DB_PATH = os.environ.get(
    "SQLITE_DB_PATH",
    os.path.join(os.path.dirname(__file__), "..", "data", "resilient_iot.db"),
)

DEFAULT_SETTINGS = {
    "active_mode": "simulation",
    "ack_timeout_ms": 1500,
    "retry_limit": 3,
    "hysteresis_good_samples": 3,
    "hysteresis_bad_samples": 2,
    "wifi_rssi_poor_threshold": -78,
    "wifi_loss_poor_threshold": 0.25,
    "wifi_latency_poor_threshold": 450,
    "sampling_interval_ms": 3500,
    "rain_normal_threshold": 350,
    "rain_heavy_threshold": 700,
    "ml_network_enabled": True,
    "ml_anomaly_enabled": True,
}

ALLOWED_TRANSITIONS = {
    "CREATED": {"ENCRYPTED"},
    "ENCRYPTED": {"PENDING", "TRANSMITTED"},
    "PENDING": {"TRANSMITTED", "RETRYING"},
    "TRANSMITTED": {"GATEWAY_STORED", "RETRYING", "PENDING"},
    "RETRYING": {"TRANSMITTED", "GATEWAY_STORED", "FORWARDED", "DELIVERED", "REJECTED", "PENDING"},
    "GATEWAY_STORED": {"FORWARDED", "RETRYING", "GATEWAY_STORED", "REJECTED"},
    "FORWARDED": {"DELIVERED", "REJECTED", "RETRYING", "FORWARDED"},
    "DELIVERED": {"DELIVERED"},
    "REJECTED": {"REJECTED"},
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def can_transition_packet_status(current: str, target: str) -> bool:
    allowed = ALLOWED_TRANSITIONS.get(current)
    return False if allowed is None else target in allowed


def get_connection() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


@contextmanager
def db_transaction():
    conn = get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE;")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    ts = now_iso()
    with db_transaction() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id TEXT NOT NULL,
                mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
                name TEXT NOT NULL,
                role TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
                link_mode TEXT NOT NULL DEFAULT 'OFFLINE',
                rssi REAL,
                queue_count INTEGER NOT NULL DEFAULT 0,
                storage_status TEXT NOT NULL DEFAULT 'UNKNOWN',
                lcd_status TEXT,
                last_heartbeat TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL,
                UNIQUE(node_id, mode)
            );
            CREATE TABLE IF NOT EXISTS sensor_readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
                packet_id INTEGER,
                node_id TEXT NOT NULL,
                temperature REAL NOT NULL,
                humidity REAL NOT NULL,
                rain_raw INTEGER NOT NULL,
                rain_category TEXT NOT NULL CHECK(rain_category IN ('DRY', 'NORMAL', 'HEAVY')),
                priority INTEGER NOT NULL,
                authenticated INTEGER NOT NULL DEFAULT 1,
                is_anomaly INTEGER NOT NULL DEFAULT 0,
                anomaly_score REAL DEFAULT 0,
                recorded_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS packets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
                packet_id INTEGER NOT NULL,
                sequence_number INTEGER NOT NULL,
                protocol_version INTEGER NOT NULL DEFAULT 1,
                source_node INTEGER NOT NULL DEFAULT 1,
                destination_node INTEGER NOT NULL DEFAULT 3,
                priority INTEGER NOT NULL DEFAULT 2,
                comm_mode TEXT NOT NULL DEFAULT 'WIFI',
                encryption_status TEXT NOT NULL DEFAULT 'ENCRYPTED',
                gateway_status TEXT NOT NULL DEFAULT 'PENDING',
                destination_status TEXT NOT NULL DEFAULT 'PENDING',
                overall_status TEXT NOT NULL DEFAULT 'CREATED',
                retry_count INTEGER NOT NULL DEFAULT 0,
                nonce TEXT NOT NULL,
                ciphertext TEXT NOT NULL,
                auth_tag TEXT NOT NULL,
                aad TEXT NOT NULL,
                key_version TEXT NOT NULL DEFAULT 'v1',
                is_duplicate INTEGER NOT NULL DEFAULT 0,
                tampered INTEGER NOT NULL DEFAULT 0,
                node1_acked INTEGER NOT NULL DEFAULT 0,
                node2_acked INTEGER NOT NULL DEFAULT 0,
                payload_preview_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(mode, packet_id)
            );
            CREATE TABLE IF NOT EXISTS acknowledgements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
                packet_id INTEGER NOT NULL,
                link_hop TEXT NOT NULL CHECK(link_hop IN ('NODE1_NODE2', 'NODE2_NODE3')),
                sender_node INTEGER NOT NULL,
                receiver_node INTEGER NOT NULL,
                status TEXT NOT NULL,
                error_code TEXT,
                latency_ms REAL DEFAULT 0,
                authenticated_ack INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS network_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
                rssi REAL NOT NULL,
                rssi_variation REAL NOT NULL DEFAULT 0,
                packet_loss_ratio REAL NOT NULL DEFAULT 0,
                ack_latency_ms REAL NOT NULL DEFAULT 0,
                retry_count INTEGER NOT NULL DEFAULT 0,
                queue_depth INTEGER NOT NULL DEFAULT 0,
                link_mode TEXT NOT NULL,
                node2_to_node3_status TEXT NOT NULL DEFAULT 'CONNECTED',
                recorded_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS storage_status (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
                node_id TEXT NOT NULL,
                storage_type TEXT NOT NULL,
                status TEXT NOT NULL,
                capacity_gb REAL,
                pending_count INTEGER NOT NULL DEFAULT 0,
                stored_count INTEGER NOT NULL DEFAULT 0,
                sequence_counter INTEGER NOT NULL DEFAULT 0,
                storage_errors INTEGER NOT NULL DEFAULT 0,
                files_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL,
                UNIQUE(mode, node_id)
            );
            CREATE TABLE IF NOT EXISTS security_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
                packet_id INTEGER,
                event_type TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                status TEXT NOT NULL,
                nonce_hex TEXT,
                key_version TEXT DEFAULT 'v1',
                details TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ml_predictions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
                model_type TEXT NOT NULL,
                predicted_class TEXT NOT NULL,
                confidence REAL NOT NULL,
                risk_score REAL NOT NULL,
                baseline_class TEXT,
                features_json TEXT NOT NULL DEFAULT '{}',
                model_status TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS anomaly_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
                packet_id INTEGER,
                temperature REAL NOT NULL,
                humidity REAL NOT NULL,
                rain_raw INTEGER NOT NULL,
                anomaly_score REAL NOT NULL,
                status TEXT NOT NULL,
                reason TEXT NOT NULL,
                preserved INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS system_alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
                severity TEXT NOT NULL CHECK(severity IN ('INFO', 'WARNING', 'CRITICAL')),
                category TEXT NOT NULL,
                message TEXT NOT NULL,
                related_node TEXT NOT NULL,
                is_read INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS test_results (
                test_id INTEGER NOT NULL,
                mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
                test_name TEXT NOT NULL,
                initial_config_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'NOT_RUN',
                passed INTEGER,
                expected_result TEXT NOT NULL,
                actual_result TEXT,
                steps_json TEXT NOT NULL DEFAULT '[]',
                packet_id INTEGER,
                executed_at TEXT,
                PRIMARY KEY(test_id, mode)
            );
            CREATE TABLE IF NOT EXISTS simulation_state (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                running INTEGER NOT NULL DEFAULT 0,
                paused INTEGER NOT NULL DEFAULT 0,
                speed_ms INTEGER NOT NULL DEFAULT 3500,
                node1_wifi_on INTEGER NOT NULL DEFAULT 1,
                node1_lora_on INTEGER NOT NULL DEFAULT 1,
                node2_node3_wifi_on INTEGER NOT NULL DEFAULT 1,
                drop_next_ack INTEGER NOT NULL DEFAULT 0,
                tamper_next_packet INTEGER NOT NULL DEFAULT 0,
                duplicate_next_packet INTEGER NOT NULL DEFAULT 0,
                wifi_healthy INTEGER NOT NULL DEFAULT 1,
                good_wifi_streak INTEGER NOT NULL DEFAULT 3,
                bad_wifi_streak INTEGER NOT NULL DEFAULT 0,
                sequence_counter INTEGER NOT NULL DEFAULT 100,
                last_temp REAL NOT NULL DEFAULT 27.4,
                last_humidity REAL NOT NULL DEFAULT 61.5,
                last_rain_raw INTEGER NOT NULL DEFAULT 210,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS communication_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
                event_type TEXT NOT NULL,
                link_hop TEXT NOT NULL,
                comm_mode TEXT NOT NULL,
                packet_id INTEGER,
                details TEXT NOT NULL,
                rssi REAL,
                latency_ms REAL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS system_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_packets_mode_status ON packets(mode, overall_status, created_at);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_packets_mode_nonce ON packets(mode, nonce);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_sensor_readings_mode_pkt ON sensor_readings(mode, packet_id) WHERE packet_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_sensor_mode_time ON sensor_readings(mode, recorded_at);
            CREATE INDEX IF NOT EXISTS idx_metrics_mode_time ON network_metrics(mode, recorded_at);
            CREATE INDEX IF NOT EXISTS idx_comm_mode_time ON communication_events(mode, created_at);
            CREATE INDEX IF NOT EXISTS idx_alerts_mode_time ON system_alerts(mode, is_read, created_at);
            CREATE INDEX IF NOT EXISTS idx_security_mode_time ON security_events(mode, created_at);
            """
        )

        # Idempotent migration for existing SQLite databases
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(packets)").fetchall()}
        if "node1_acked" not in cols:
            conn.execute("ALTER TABLE packets ADD COLUMN node1_acked INTEGER NOT NULL DEFAULT 0")
            conn.execute("UPDATE packets SET node1_acked = 1 WHERE gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')")
        if "node2_acked" not in cols:
            conn.execute("ALTER TABLE packets ADD COLUMN node2_acked INTEGER NOT NULL DEFAULT 0")
            conn.execute("UPDATE packets SET node2_acked = 1 WHERE destination_status = 'DELIVERED'")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_packets_mode_ack ON packets(mode, node1_acked, node2_acked, gateway_status, destination_status)"
        )

        for k, v in DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
                (k, json.dumps(v), ts),
            )

        conn.execute(
            """
            INSERT OR IGNORE INTO simulation_state (
                id, running, paused, speed_ms, node1_wifi_on, node1_lora_on, node2_node3_wifi_on,
                drop_next_ack, tamper_next_packet, duplicate_next_packet, wifi_healthy,
                good_wifi_streak, bad_wifi_streak, sequence_counter, last_temp, last_humidity, last_rain_raw, updated_at
            ) VALUES (1, 1, 0, 3500, 1, 1, 1, 0, 0, 0, 1, 3, 0, 100, 27.4, 61.5, 210, ?)
            """,
            (ts,),
        )

        for mode in ("simulation", "hardware"):
            is_sim = mode == "simulation"
            nodes_seed = [
                ("NODE_1", "Node 1 — Sensor & Transmitter", "ESP32 Sensor Transmitter (DHT11 + Raindrop + AES-128-GCM + LittleFS)", "ONLINE" if is_sim else "NOT_CONNECTED", "WIFI" if is_sim else "OFFLINE", -61 if is_sim else None, "MOUNTED" if is_sim else "NOT_REPORTED", None),
                ("NODE_2", "Node 2 — Central Gateway", "ESP32 Store-and-Forward Gateway (Wi-Fi + LoRa Transceiver + 16 GB microSD)", "ONLINE" if is_sim else "NOT_CONNECTED", "WIFI" if is_sim else "OFFLINE", -61 if is_sim else None, "MOUNTED" if is_sim else "NOT_REPORTED", None),
                ("NODE_3", "Node 3 — Destination Receiver", "ESP32 Authenticated Receiver (Wi-Fi + AES-128-GCM Verify/Decrypt + I2C LCD)", "ONLINE" if is_sim else "NOT_CONNECTED", "WIFI" if is_sim else "OFFLINE", -58 if is_sim else None, "N/A", "ACTIVE" if is_sim else "NOT_REPORTED"),
            ]
            for nid, name, role, status, lmode, rssi, sstat, lcd in nodes_seed:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO nodes (
                        node_id, mode, name, role, status, link_mode, rssi, queue_count,
                        storage_status, lcd_status, last_heartbeat, metadata_json, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, '{}', ?)
                    """,
                    (nid, mode, name, role, status, lmode, rssi, sstat, lcd, ts if is_sim else None, ts),
                )

            conn.execute(
                """
                INSERT OR IGNORE INTO storage_status (
                    mode, node_id, storage_type, status, capacity_gb, pending_count,
                    stored_count, sequence_counter, storage_errors, files_json, updated_at
                ) VALUES (?, 'NODE_1', 'LittleFS', ?, 0.004, 0, 0, ?, 0, ?, ?)
                """,
                (mode, "MOUNTED" if is_sim else "NOT_REPORTED", 100 if is_sim else 0, json.dumps(["/state/sequence_counter", "/state/config.json"] if is_sim else []), ts),
            )
            conn.execute(
                """
                INSERT OR IGNORE INTO storage_status (
                    mode, node_id, storage_type, status, capacity_gb, pending_count,
                    stored_count, sequence_counter, storage_errors, files_json, updated_at
                ) VALUES (?, 'NODE_2', 'microSD (FAT32)', ?, 16.0, 0, 0, 0, 0, ?, ?)
                """,
                (mode, "MOUNTED" if is_sim else "NOT_REPORTED", json.dumps(["/gateway/received_packets.bin", "/gateway/node3_pending.log", "/gateway/delivery_status.csv", "/gateway/network_metrics.csv", "/gateway/gateway_config.json"] if is_sim else []), ts),
            )


def get_settings() -> dict:
    conn = get_connection()
    rows = conn.execute("SELECT key, value FROM system_settings").fetchall()
    conn.close()
    merged = dict(DEFAULT_SETTINGS)
    for r in rows:
        try:
            merged[r["key"]] = json.loads(r["value"])
        except Exception:
            merged[r["key"]] = r["value"]
    return merged


def update_settings(updates: dict) -> dict:
    ts = now_iso()
    with db_transaction() as conn:
        for k, v in updates.items():
            if k in DEFAULT_SETTINGS:
                conn.execute(
                    """
                    INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                    """,
                    (k, json.dumps(v), ts),
                )
    return get_settings()


def create_alert(conn: sqlite3.Connection, mode: str, severity: str, category: str, message: str, node: str) -> None:
    conn.execute(
        "INSERT INTO system_alerts (mode, severity, category, message, related_node, is_read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
        (mode, severity, category, message, node, now_iso()),
    )


def log_comm_event(conn: sqlite3.Connection, mode: str, event_type: str, link_hop: str, comm_mode: str, packet_id: int | None, details: str, rssi: float | None = None, latency_ms: float | None = None) -> None:
    conn.execute(
        "INSERT INTO communication_events (mode, event_type, link_hop, comm_mode, packet_id, details, rssi, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (mode, event_type, link_hop, comm_mode, packet_id, details, rssi, latency_ms, now_iso()),
    )


def log_security_event(conn: sqlite3.Connection, mode: str, packet_id: int | None, event_type: str, endpoint: str, status: str, nonce_hex: str | None, key_version: str, details: str) -> None:
    conn.execute(
        "INSERT INTO security_events (mode, packet_id, event_type, endpoint, status, nonce_hex, key_version, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (mode, packet_id, event_type, endpoint, status, nonce_hex, key_version, details, now_iso()),
    )


def get_all_persisted_nonces() -> list[str]:
    conn = get_connection()
    rows = conn.execute("SELECT nonce FROM packets").fetchall()
    conn.close()
    return [str(r["nonce"]) for r in rows if r["nonce"]]
