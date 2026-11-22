"""Complete Flask REST API server with 100% endpoint parity across Simulation and Live Hardware modes."""
import csv
import io
import json
import math
import os
import re
import threading
import time
from flask import Flask, Response, jsonify, request
from flask_cors import CORS

from database import (
    can_transition_packet_status,
    create_alert,
    db_transaction,
    get_all_persisted_nonces,
    get_connection,
    get_settings,
    init_db,
    log_comm_event,
    log_security_event,
    now_iso,
    update_settings,
)
from ml_anomaly import SensorAnomalyModel
from ml_network import NetworkQualityModel
from security_manager import SecurityManager
from simulation_engine import SimulationEngine, classify_rain
from test_manager import TestManager

app = Flask(__name__)
CORS(
    app,
    origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        re.compile(r"^https://[a-zA-Z0-9-]+\.run\.app$"),
    ],
)

init_db()
security_mgr = SecurityManager()
security_mgr.hydrate_used_nonces(get_all_persisted_nonces())
net_ml = NetworkQualityModel()
anom_ml = SensorAnomalyModel()
sim_engine = SimulationEngine(security_mgr, net_ml, anom_ml)
test_mgr = TestManager(sim_engine)
sim_lock = threading.Lock()


def _seed_initial_simulation() -> None:
    conn = get_connection()
    count = conn.execute("SELECT COUNT(*) FROM packets WHERE mode = 'simulation'").fetchone()[0]
    conn.close()
    if count == 0:
        with sim_lock:
            for _ in range(5):
                sim_engine.tick()
            sim_engine.sync_node_and_storage_summaries()


def _simulation_background_worker() -> None:
    while True:
        try:
            st = sim_engine.get_state()
            settings = get_settings()
            interval_s = max(1.0, min(15.0, float(st.get("speed_ms", 3500)) / 1000.0))
            if settings.get("active_mode") == "simulation" and st.get("running") and not st.get("paused"):
                with sim_lock:
                    sim_engine.tick()
            time.sleep(interval_s)
        except Exception:
            time.sleep(2.0)


_sim_thread_started = False


def start_simulation_worker() -> None:
    global _sim_thread_started
    if _sim_thread_started:
        return
    _sim_thread_started = True
    _seed_initial_simulation()
    t = threading.Thread(target=_simulation_background_worker, name="sim-ticker", daemon=True)
    t.start()

NODE1_ACK_SUCCESS = {"ACK_STORED", "ACK_RECEIVED", "ACK_DUPLICATE_RESENT"}
NODE1_ACK_FAILURE = {"LOST", "ACK_TIMEOUT", "NACK"}
NODE2_PLAINTEXT_KEYS = ("temperature", "humidity", "rain_raw", "rain", "plaintext", "payload", "payload_preview_json")


def get_mode() -> str:
    m = request.args.get("mode")
    if m in ("simulation", "hardware"):
        return m
    return str(get_settings().get("active_mode", "simulation"))


def csv_safe(v) -> str:
    s = "" if v is None else str(v)
    if s and s[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + s
    return s


def parse_positive_int(val) -> int | None:
    try:
        n = int(val)
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def parse_finite_float(val) -> float | None:
    try:
        n = float(val)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


def sync_hardware_queue_counts(conn, ts: str) -> None:
    n1_pending = conn.execute("SELECT COUNT(*) FROM packets WHERE mode = 'hardware' AND node1_acked = 0").fetchone()[0]
    n2_stored = conn.execute(
        "SELECT COUNT(*) FROM packets WHERE mode = 'hardware' AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')"
    ).fetchone()[0]
    n2_pending = conn.execute(
        """
        SELECT COUNT(*) FROM packets
        WHERE mode = 'hardware'
          AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')
          AND node2_acked = 0
          AND destination_status != 'REJECTED'
        """
    ).fetchone()[0]
    max_seq = conn.execute("SELECT COALESCE(MAX(sequence_number), 0) FROM packets WHERE mode = 'hardware'").fetchone()[0]
    conn.execute("UPDATE nodes SET queue_count = ?, updated_at = ? WHERE mode = 'hardware' AND node_id = 'NODE_1'", (n1_pending, ts))
    conn.execute("UPDATE nodes SET queue_count = ?, updated_at = ? WHERE mode = 'hardware' AND node_id = 'NODE_2'", (n2_pending, ts))
    conn.execute(
        "UPDATE storage_status SET pending_count = ?, stored_count = ?, sequence_counter = ?, updated_at = ? WHERE mode = 'hardware' AND node_id = 'NODE_1'",
        (n1_pending, n1_pending, max_seq, ts),
    )
    conn.execute(
        "UPDATE storage_status SET pending_count = ?, stored_count = ?, sequence_counter = ?, updated_at = ? WHERE mode = 'hardware' AND node_id = 'NODE_2'",
        (n2_pending, n2_stored, max_seq, ts),
    )


@app.errorhandler(400)
def bad_request(_err):
    return jsonify({"error": "Invalid request", "timestamp": now_iso()}), 400


@app.errorhandler(404)
def not_found(_err):
    return jsonify({"error": "Endpoint not found", "timestamp": now_iso()}), 404


@app.errorhandler(500)
def server_error(_err):
    return jsonify({"error": "Internal server error", "timestamp": now_iso()}), 500


@app.get("/api/health")
def health():
    s = get_settings()
    return jsonify({
        "status": "HEALTHY",
        "database": "CONNECTED",
        "database_file": "resilient_iot.db",
        "active_mode": s["active_mode"],
        "ml_network_status": "READY (Synthetic Baseline)" if s["ml_network_enabled"] else "DISABLED",
        "ml_anomaly_status": "READY (Synthetic Baseline)" if s["ml_anomaly_enabled"] else "DISABLED",
        "security_algorithm": "AES-128-GCM",
        "timestamp": now_iso(),
    })


@app.get("/api/settings")
def api_get_settings():
    return jsonify({
        "settings": get_settings(),
        "security": {
            "algorithm": "AES-128-GCM",
            "key_version": security_mgr.key_version,
            "key_source": security_mgr.key_source,
        },
        "hardware_ack_note": "Settings update backend immediately; physical ESP32 boards apply changes upon firmware sync ACK.",
    })


@app.post("/api/settings")
def api_update_settings():
    body = request.get_json(silent=True) or {}
    saved = update_settings(body)
    return jsonify({"ok": True, "settings": saved})


@app.get("/api/status")
def api_status():
    mode = get_mode()
    conn = get_connection()
    total_created = conn.execute("SELECT COUNT(*) FROM packets WHERE mode = ?", (mode,)).fetchone()[0]
    received_n2 = conn.execute("SELECT COUNT(*) FROM packets WHERE mode = ? AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')", (mode,)).fetchone()[0]
    delivered_n3 = conn.execute("SELECT COUNT(*) FROM packets WHERE mode = ? AND node2_acked = 1 AND destination_status = 'DELIVERED'", (mode,)).fetchone()[0]
    pending_n1 = conn.execute("SELECT COUNT(*) FROM packets WHERE mode = ? AND node1_acked = 0", (mode,)).fetchone()[0]
    pending_n2 = conn.execute(
        "SELECT COUNT(*) FROM packets WHERE mode = ? AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED') AND node2_acked = 0 AND destination_status != 'REJECTED'",
        (mode,),
    ).fetchone()[0]
    dups = conn.execute("SELECT COUNT(*) FROM packets WHERE mode = ? AND is_duplicate = 1", (mode,)).fetchone()[0]
    failed_auth = conn.execute("SELECT COUNT(*) FROM packets WHERE mode = ? AND encryption_status = 'AUTH_FAILED'", (mode,)).fetchone()[0]
    unread = conn.execute("SELECT COUNT(*) FROM system_alerts WHERE mode = ? AND is_read = 0", (mode,)).fetchone()[0]
    nodes = [dict(r, metadata=json.loads(r["metadata_json"] or "{}")) for r in conn.execute("SELECT * FROM nodes WHERE mode = ? ORDER BY node_id ASC", (mode,)).fetchall()]
    latest_sensor = conn.execute("SELECT * FROM sensor_readings WHERE mode = ? AND authenticated = 1 ORDER BY id DESC LIMIT 1", (mode,)).fetchone()
    prev_sensor = conn.execute("SELECT * FROM sensor_readings WHERE mode = ? AND authenticated = 1 ORDER BY id DESC LIMIT 1 OFFSET 1", (mode,)).fetchone()
    latest_metric = conn.execute("SELECT * FROM network_metrics WHERE mode = ? ORDER BY id DESC LIMIT 1", (mode,)).fetchone()
    conn.close()
    hw_n2_n3 = (
        str(latest_metric["node2_to_node3_status"]).upper()
        if latest_metric and latest_metric["node2_to_node3_status"]
        else ("CONNECTED" if len(nodes) > 2 and nodes[2]["status"] == "ONLINE" else "DISCONNECTED")
    )
    return jsonify({
        "mode": mode,
        "is_demo_mode": mode == "simulation",
        "timestamp": now_iso(),
        "overall_status": "AWAITING_HARDWARE" if (mode == "hardware" and all(n["status"] == "NOT_CONNECTED" for n in nodes)) else "NOMINAL",
        "active_comm_mode": nodes[0]["link_mode"] if nodes else "OFFLINE",
        "node2_to_node3_status": ("CONNECTED" if sim_engine.get_state().get("node2_node3_wifi_on") else "DISCONNECTED") if mode == "simulation" else hw_n2_n3,
        "summary": {
            "total_created": total_created,
            "received_by_node2": received_n2,
            "delivered_to_node3": delivered_n3,
            "pending_packets": pending_n1 + pending_n2,
            "pending_node1_littlefs": pending_n1,
            "pending_node2_microsd": pending_n2,
            "duplicate_packets": dups,
            "failed_auth_count": failed_auth,
            "unread_alerts": unread,
        },
        "nodes": nodes,
        "latest_sensor": dict(latest_sensor) if latest_sensor else None,
        "previous_sensor": dict(prev_sensor) if prev_sensor else None,
        "latest_metric": dict(latest_metric) if latest_metric else None,
        "simulation": sim_engine.get_state() if mode == "simulation" else None,
        "settings": get_settings(),
    })


@app.get("/api/nodes")
def api_nodes():
    mode = get_mode()
    conn = get_connection()
    rows = conn.execute("SELECT * FROM nodes WHERE mode = ? ORDER BY node_id ASC", (mode,)).fetchall()
    conn.close()
    return jsonify({"mode": mode, "nodes": [dict(r, metadata=json.loads(r["metadata_json"] or "{}")) for r in rows]})


@app.get("/api/sensors/latest")
def api_sensors_latest():
    mode = get_mode()
    conn = get_connection()
    latest = conn.execute("SELECT * FROM sensor_readings WHERE mode = ? AND authenticated = 1 ORDER BY id DESC LIMIT 1", (mode,)).fetchone()
    prev = conn.execute("SELECT * FROM sensor_readings WHERE mode = ? AND authenticated = 1 ORDER BY id DESC LIMIT 1 OFFSET 1", (mode,)).fetchone()
    conn.close()
    return jsonify({"mode": mode, "latest": dict(latest) if latest else None, "previous": dict(prev) if prev else None})


@app.get("/api/sensors/history")
def api_sensors_history():
    mode = get_mode()
    limit = max(10, min(500, int(request.args.get("limit", 100))))
    conn = get_connection()
    rows = conn.execute("SELECT * FROM sensor_readings WHERE mode = ? AND authenticated = 1 ORDER BY id DESC LIMIT ?", (mode, limit)).fetchall()
    conn.close()
    return jsonify({"mode": mode, "readings": [dict(r) for r in reversed(rows)]})


@app.get("/api/communication")
def api_comm():
    mode = get_mode()
    limit = max(10, min(200, int(request.args.get("limit", 60))))
    conn = get_connection()
    metrics = [dict(r) for r in reversed(conn.execute("SELECT * FROM network_metrics WHERE mode = ? ORDER BY id DESC LIMIT ?", (mode, limit)).fetchall())]
    events = [dict(r) for r in conn.execute("SELECT * FROM communication_events WHERE mode = ? ORDER BY id DESC LIMIT ?", (mode, limit)).fetchall()]
    acks = [dict(r) for r in conn.execute("SELECT * FROM acknowledgements WHERE mode = ? ORDER BY id DESC LIMIT ?", (mode, min(limit, 100))).fetchall()]
    conn.close()
    return jsonify({"mode": mode, "metrics": metrics, "events": events, "acknowledgements": acks})


# --- ESP32 LIVE HARDWARE ENDPOINTS (strictly 'hardware' mode) ---
@app.post("/api/node1/sensor-data")
def hw_node1_sensor():
    b = request.get_json(silent=True) or {}
    ts = now_iso()
    rssi = parse_finite_float(b.get("rssi"))
    q_count = max(0, int(b.get("littlefs_queue_count", 0) or 0))
    with db_transaction() as conn:
        conn.execute(
            "UPDATE nodes SET status='ONLINE', link_mode=?, rssi=?, queue_count=?, storage_status=?, last_heartbeat=?, updated_at=? WHERE node_id='NODE_1' AND mode='hardware'",
            (str(b.get("comm_mode", "WIFI")).upper(), rssi, q_count, str(b.get("littlefs_status", "MOUNTED")), ts, ts),
        )
    return jsonify({"ok": True, "mode": "hardware", "received_at": ts}), 201


@app.post("/api/node1/packet")
def hw_node1_packet():
    b = request.get_json(silent=True) or {}
    pkt_id = parse_positive_int(b.get("packet_id"))
    if pkt_id is None:
        return jsonify({"error": "packet_id must be a positive integer"}), 400
    for k in ("nonce", "ciphertext", "tag"):
        if not isinstance(b.get(k), str) or not str(b[k]).strip():
            return jsonify({"error": f"Missing required field: {k}"}), 400

    seq_num = parse_positive_int(b.get("sequence_number", pkt_id)) or pkt_id
    version = parse_positive_int(b.get("version", 1)) or 1
    source = parse_positive_int(b.get("source", 1)) or 1
    destination = parse_positive_int(b.get("destination", 3)) or 3
    priority = 1 if int(b.get("priority", 2) or 2) == 1 else 2
    if source != 1 or destination != 3:
        return jsonify({"error": "Invalid routing header: expected source=1, destination=3"}), 400

    nonce = str(b["nonce"]).strip().lower()
    ciphertext = str(b["ciphertext"]).strip().lower()
    tag = str(b["tag"]).strip().lower()
    expected_aad = SecurityManager.build_aad(version, source, destination, pkt_id, priority).decode("utf-8")
    aad = str(b.get("aad", expected_aad))
    key_version = str(b.get("key_version", "v1"))
    comm_mode = str(b.get("comm_mode", "WIFI")).upper()
    if comm_mode not in ("WIFI", "LORA", "OFFLINE", "PENDING"):
        comm_mode = "WIFI"

    valid, env_err = SecurityManager.validate_envelope_format(
        nonce, ciphertext, tag, aad, version, source, destination, pkt_id, priority
    )
    if not valid:
        return jsonify({"error": f"Invalid AES-128-GCM packet envelope: {env_err}", "code": env_err}), 400

    ts = now_iso()
    with db_transaction() as conn:
        existing = conn.execute(
            "SELECT id, nonce, ciphertext, auth_tag, aad, retry_count FROM packets WHERE mode='hardware' AND packet_id=?",
            (pkt_id,),
        ).fetchone()
        if existing:
            if (
                existing["nonce"].lower() != nonce
                or existing["ciphertext"].lower() != ciphertext
                or existing["auth_tag"].lower() != tag
                or existing["aad"] != aad
            ):
                log_security_event(
                    conn,
                    "hardware",
                    pkt_id,
                    "ILLEGAL_REENCRYPTION",
                    "NODE_1",
                    "REJECTED",
                    nonce,
                    key_version,
                    f"Blocked retransmission of packet #{pkt_id} with altered ciphertext/nonce/tag.",
                )
                return jsonify({
                    "error": "Retransmission must send identical persisted ciphertext, nonce, tag, and AAD (never re-encrypt).",
                    "code": "ILLEGAL_REENCRYPTION_DETECTED",
                }), 409
            conn.execute(
                "UPDATE packets SET comm_mode=?, retry_count=retry_count+1, updated_at=? WHERE id=?",
                (comm_mode, ts, existing["id"]),
            )
            log_comm_event(
                conn,
                "hardware",
                "RETRANSMIT",
                "NODE1_NODE2",
                comm_mode,
                pkt_id,
                f"Node 1 retransmitted identical persisted ciphertext for packet #{pkt_id}.",
            )
            sync_hardware_queue_counts(conn, ts)
            return jsonify({"ok": True, "packet_id": pkt_id, "mode": "hardware", "retransmission": True}), 200

        nonce_collision = conn.execute(
            "SELECT packet_id FROM packets WHERE mode='hardware' AND nonce=? LIMIT 1",
            (nonce,),
        ).fetchone()
        if nonce_collision:
            log_security_event(
                conn,
                "hardware",
                pkt_id,
                "NONCE_REUSE_BLOCKED",
                "NODE_1",
                "REJECTED",
                nonce,
                key_version,
                f"Blocked duplicate 96-bit AES-GCM nonce already used by packet #{nonce_collision['packet_id']}.",
            )
            create_alert(
                conn,
                "hardware",
                "CRITICAL",
                "NONCE_REUSE",
                f"AES-GCM nonce reuse detected on packet #{pkt_id} (matches #{nonce_collision['packet_id']}).",
                "NODE_1",
            )
            return jsonify({
                "error": f"AES-128-GCM nonce already used by packet #{nonce_collision['packet_id']}.",
                "code": "NONCE_REUSE_DETECTED",
            }), 409

        conn.execute(
            """
            INSERT INTO packets (
                mode, packet_id, sequence_number, protocol_version, source_node, destination_node,
                priority, comm_mode, encryption_status, gateway_status, destination_status,
                overall_status, retry_count, nonce, ciphertext, auth_tag, aad, key_version,
                is_duplicate, tampered, node1_acked, node2_acked, payload_preview_json, created_at, updated_at
            ) VALUES ('hardware', ?, ?, ?, ?, ?, ?, ?, 'ENCRYPTED', 'PENDING', 'PENDING', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, ?, ?)
            """,
            (
                pkt_id,
                seq_num,
                version,
                source,
                destination,
                priority,
                comm_mode,
                "PENDING" if comm_mode == "OFFLINE" else "TRANSMITTED",
                max(0, int(b.get("retry_count", 0) or 0)),
                nonce,
                ciphertext,
                tag,
                aad,
                key_version,
                ts,
                ts,
            ),
        )
        security_mgr.record_external_nonce(nonce)
        log_security_event(conn, "hardware", pkt_id, "ENCRYPT", "NODE_1", "SUCCESS", nonce, key_version, f"ESP32 Node 1 encrypted packet #{pkt_id} (queued in LittleFS awaiting gateway ACK).")
        sync_hardware_queue_counts(conn, ts)
    return jsonify({"ok": True, "packet_id": pkt_id, "mode": "hardware"}), 201


@app.post("/api/node1/ack")
def hw_node1_ack():
    b = request.get_json(silent=True) or {}
    pkt_id = parse_positive_int(b.get("packet_id"))
    if pkt_id is None:
        return jsonify({"error": "packet_id must be a positive integer"}), 400
    status = str(b.get("status", "ACK_STORED")).upper()
    if status not in NODE1_ACK_SUCCESS and status not in NODE1_ACK_FAILURE:
        return jsonify({"error": f"Invalid Hop-1 ACK status: {status}"}), 400
    latency = parse_finite_float(b.get("latency_ms", 0)) or 0.0
    ts = now_iso()

    with db_transaction() as conn:
        pkt = conn.execute(
            "SELECT id, gateway_status, node1_acked FROM packets WHERE mode='hardware' AND packet_id=?",
            (pkt_id,),
        ).fetchone()
        if not pkt:
            return jsonify({"error": f"Packet #{pkt_id} not found"}), 404

        if status in NODE1_ACK_SUCCESS and pkt["gateway_status"] not in ("STORED", "DUPLICATE_SUPPRESSED"):
            return jsonify({
                "error": f"Node 1 cannot retire packet #{pkt_id} before Node 2 confirms persistent storage.",
                "code": "CANNOT_RETIRE_UNSTORED_PACKET",
            }), 409

        conn.execute(
            "INSERT INTO acknowledgements (mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at) VALUES ('hardware', ?, 'NODE1_NODE2', 2, 1, ?, ?, ?, 1, ?)",
            (pkt_id, status, b.get("error_code"), latency, ts),
        )
        retired = False
        if status in NODE1_ACK_SUCCESS:
            conn.execute("UPDATE packets SET node1_acked = 1, updated_at = ? WHERE id = ?", (ts, pkt["id"]))
            retired = True
            log_comm_event(conn, "hardware", "ACK_RECEIVED", "NODE1_NODE2", "WIFI", pkt_id, f"Node 1 verified matching gateway {status} for packet #{pkt_id} and retired LittleFS file.", None, latency)
        else:
            conn.execute("UPDATE packets SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?", (ts, pkt["id"]))
            log_comm_event(conn, "hardware", "ACK_LOST", "NODE1_NODE2", "WIFI", pkt_id, f"Node 1 Hop-1 ACK {status} for packet #{pkt_id}; packet remains in LittleFS (node1_acked=0).", None, latency)
        sync_hardware_queue_counts(conn, ts)
    return jsonify({"ok": True, "packet_id": pkt_id, "status": status, "node1_retired": retired}), 201


@app.post("/api/node2/packet-received")
def hw_node2_received():
    b = request.get_json(silent=True) or {}
    pkt_id = parse_positive_int(b.get("packet_id"))
    if pkt_id is None:
        return jsonify({"error": "packet_id must be a positive integer"}), 400

    # Strict architectural boundary: Node 2 MUST NEVER decrypt or submit plaintext sensor telemetry
    for forbidden in NODE2_PLAINTEXT_KEYS:
        if forbidden in b and b[forbidden] is not None:
            return jsonify({
                "error": f"Security policy violation: Node 2 gateway must never decrypt or submit plaintext field '{forbidden}'.",
                "code": "NODE2_NO_DECRYPTION_POLICY",
            }), 400

    comm_mode = str(b.get("comm_mode", "WIFI")).upper()
    if comm_mode not in ("WIFI", "LORA"):
        comm_mode = "WIFI"
    ts = now_iso()
    dup = False

    with db_transaction() as conn:
        row = conn.execute(
            "SELECT id, gateway_status, nonce, ciphertext, auth_tag, aad FROM packets WHERE mode='hardware' AND packet_id=?",
            (pkt_id,),
        ).fetchone()
        if row:
            # Verify ciphertext immutability if gateway echoed crypto envelope fields
            if b.get("nonce") and str(b["nonce"]).strip().lower() != row["nonce"].lower():
                return jsonify({"error": "Gateway reported mismatched nonce for existing packet", "code": "CIPHERTEXT_MISMATCH"}), 409
            if b.get("ciphertext") and str(b["ciphertext"]).strip().lower() != row["ciphertext"].lower():
                return jsonify({"error": "Gateway reported mismatched ciphertext for existing packet", "code": "CIPHERTEXT_MISMATCH"}), 409
            if b.get("tag") and str(b["tag"]).strip().lower() != row["auth_tag"].lower():
                return jsonify({"error": "Gateway reported mismatched auth tag for existing packet", "code": "CIPHERTEXT_MISMATCH"}), 409

            if row["gateway_status"] in ("STORED", "DUPLICATE_SUPPRESSED"):
                dup = True
                conn.execute(
                    "UPDATE packets SET comm_mode=?, gateway_status='DUPLICATE_SUPPRESSED', is_duplicate=1, retry_count=retry_count+1, updated_at=? WHERE id=?",
                    (comm_mode, ts, row["id"]),
                )
                conn.execute(
                    "INSERT INTO acknowledgements (mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at) VALUES ('hardware', ?, 'NODE1_NODE2', 2, 1, 'ACK_DUPLICATE_RESENT', NULL, 0, 1, ?)",
                    (pkt_id, ts),
                )
                log_comm_event(conn, "hardware", "DUPLICATE_SUPPRESSED", "NODE1_NODE2", comm_mode, pkt_id, f"Node 2 suppressed duplicate packet #{pkt_id} and resent matching gateway ACK.")
            else:
                conn.execute(
                    "UPDATE packets SET comm_mode=?, gateway_status='STORED', overall_status='GATEWAY_STORED', updated_at=? WHERE id=?",
                    (comm_mode, ts, row["id"]),
                )
                log_comm_event(conn, "hardware", "GATEWAY_STORED", "NODE1_NODE2", comm_mode, pkt_id, f"Node 2 stored opaque ciphertext packet #{pkt_id} on microSD (awaiting Node 1 ACK confirmation).")
        else:
            # Creating packet directly from Node 2 requires a valid opaque AES-GCM envelope
            for k in ("nonce", "ciphertext", "tag"):
                if not isinstance(b.get(k), str) or not str(b[k]).strip():
                    return jsonify({"error": f"Unknown packet #{pkt_id}: opaque AES-GCM field '{k}' is required"}), 400
            priority = 1 if int(b.get("priority", 2) or 2) == 1 else 2
            nonce = str(b["nonce"]).strip().lower()
            ciphertext = str(b["ciphertext"]).strip().lower()
            tag = str(b["tag"]).strip().lower()
            expected_aad = SecurityManager.build_aad(1, 1, 3, pkt_id, priority).decode("utf-8")
            aad = str(b.get("aad", expected_aad))
            valid, env_err = SecurityManager.validate_envelope_format(nonce, ciphertext, tag, aad, 1, 1, 3, pkt_id, priority)
            if not valid:
                return jsonify({"error": f"Invalid AES-128-GCM envelope at Node 2: {env_err}", "code": env_err}), 400
            if conn.execute("SELECT 1 FROM packets WHERE mode='hardware' AND nonce=? LIMIT 1", (nonce,)).fetchone():
                return jsonify({"error": "AES-128-GCM nonce already exists", "code": "NONCE_REUSE_DETECTED"}), 409
            conn.execute(
                """
                INSERT INTO packets (
                    mode, packet_id, sequence_number, protocol_version, source_node, destination_node,
                    priority, comm_mode, encryption_status, gateway_status, destination_status,
                    overall_status, retry_count, nonce, ciphertext, auth_tag, aad, key_version,
                    is_duplicate, tampered, node1_acked, node2_acked, payload_preview_json, created_at, updated_at
                ) VALUES ('hardware', ?, ?, 1, 1, 3, ?, ?, 'ENCRYPTED', 'STORED', 'PENDING', 'GATEWAY_STORED', 0, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, ?, ?)
                """,
                (pkt_id, pkt_id, priority, comm_mode, nonce, ciphertext, tag, aad, str(b.get("key_version", "v1")), ts, ts),
            )
            security_mgr.record_external_nonce(nonce)
        sync_hardware_queue_counts(conn, ts)
    return jsonify({
        "ok": True,
        "packet_id": pkt_id,
        "duplicate_suppressed": dup,
        "gateway_ack_status": "ACK_DUPLICATE_RESENT" if dup else "ACK_STORED",
    }), 201


@app.post("/api/node2/network-metrics")
def hw_node2_metrics():
    b = request.get_json(silent=True) or {}
    ts = now_iso()
    features = {
        "rssi": parse_finite_float(b.get("rssi", -70)) or -70.0,
        "rssi_variation": parse_finite_float(b.get("rssi_variation", 0)) or 0.0,
        "packet_loss_ratio": parse_finite_float(b.get("packet_loss_ratio", 0)) or 0.0,
        "ack_latency_ms": parse_finite_float(b.get("ack_latency_ms", 0)) or 0.0,
        "retry_count": max(0, int(b.get("retry_count", 0) or 0)),
        "queue_depth": max(0, int(b.get("queue_depth", 0) or 0)),
    }
    pred = net_ml.predict(features)
    with db_transaction() as conn:
        conn.execute(
            "INSERT INTO network_metrics (mode, rssi, rssi_variation, packet_loss_ratio, ack_latency_ms, retry_count, queue_depth, link_mode, node2_to_node3_status, recorded_at) VALUES ('hardware', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (features["rssi"], features["rssi_variation"], features["packet_loss_ratio"], features["ack_latency_ms"], features["retry_count"], features["queue_depth"], str(b.get("link_mode", "WIFI")).upper(), str(b.get("node2_to_node3_status", "CONNECTED")).upper(), ts),
        )
        conn.execute(
            "INSERT INTO ml_predictions (mode, model_type, predicted_class, confidence, risk_score, baseline_class, features_json, model_status, created_at) VALUES ('hardware', 'NETWORK_QUALITY', ?, ?, ?, ?, ?, ?, ?)",
            (pred["predicted_class"], pred["confidence"], pred["risk_score"], pred["baseline_class"], json.dumps(features), pred["evaluation"]["model_status"], ts),
        )
    return jsonify({"ok": True, "ml_prediction": pred}), 201


@app.post("/api/node2/storage-status")
def hw_node2_storage():
    b = request.get_json(silent=True) or {}
    ts = now_iso()
    with db_transaction() as conn:
        conn.execute(
            "UPDATE storage_status SET status=?, capacity_gb=?, pending_count=?, stored_count=?, storage_errors=?, updated_at=? WHERE mode='hardware' AND node_id='NODE_2'",
            (
                str(b.get("status", "MOUNTED")),
                parse_finite_float(b.get("capacity_gb", 16.0)) or 16.0,
                max(0, int(b.get("pending_count", 0) or 0)),
                max(0, int(b.get("stored_count", 0) or 0)),
                max(0, int(b.get("storage_errors", 0) or 0)),
                ts,
            ),
        )
    return jsonify({"ok": True}), 201


@app.post("/api/node2/forward")
def hw_node2_forward():
    b = request.get_json(silent=True) or {}
    pkt_id = parse_positive_int(b.get("packet_id"))
    if pkt_id is None:
        return jsonify({"error": "packet_id must be a positive integer"}), 400
    status = str(b.get("status", "FORWARDED")).upper()
    if status not in ("FORWARDED", "RETRYING", "PENDING"):
        return jsonify({"error": f"Invalid forward status: {status}"}), 400
    target = "FORWARDED" if status == "FORWARDED" else ("RETRYING" if status == "RETRYING" else "GATEWAY_STORED")
    ts = now_iso()
    with db_transaction() as conn:
        cur = conn.execute(
            "SELECT overall_status, gateway_status FROM packets WHERE mode='hardware' AND packet_id=?",
            (pkt_id,),
        ).fetchone()
        if not cur:
            return jsonify({"error": f"Packet #{pkt_id} not found"}), 404
        if cur["gateway_status"] not in ("STORED", "DUPLICATE_SUPPRESSED"):
            return jsonify({"error": f"Cannot forward packet #{pkt_id} before Node 2 stores it on microSD."}), 409
        if not can_transition_packet_status(cur["overall_status"], target):
            return jsonify({"error": f"Invalid transition {cur['overall_status']} -> {target}"}), 409
        conn.execute(
            "UPDATE packets SET destination_status=?, overall_status=?, updated_at=? WHERE mode='hardware' AND packet_id=? AND destination_status NOT IN ('DELIVERED','REJECTED')",
            (status, target, ts, pkt_id),
        )
        sync_hardware_queue_counts(conn, ts)
    return jsonify({"ok": True, "packet_id": pkt_id, "status": status}), 201


@app.post("/api/node3/packet-received")
def hw_node3_received():
    b = request.get_json(silent=True) or {}
    pkt_id = parse_positive_int(b.get("packet_id"))
    if pkt_id is None:
        return jsonify({"error": "packet_id must be a positive integer"}), 400
    ts = now_iso()

    with db_transaction() as conn:
        pkt = conn.execute(
            "SELECT id, protocol_version, source_node, destination_node, priority, nonce, ciphertext, auth_tag, aad, key_version, overall_status FROM packets WHERE mode='hardware' AND packet_id=?",
            (pkt_id,),
        ).fetchone()
        if pkt and pkt["overall_status"] == "REJECTED":
            return jsonify({"error": f"Packet #{pkt_id} was already rejected by Node 3."}), 409

        # If ciphertext envelope fields are supplied, perform real server-side AES-128-GCM verification
        decrypted = None
        if b.get("nonce") and b.get("ciphertext") and b.get("tag"):
            aad = str(b.get("aad", pkt["aad"] if pkt else SecurityManager.build_aad(1, 1, 3, pkt_id, 2).decode("utf-8")))
            ok, reading, err = security_mgr.verify_and_decrypt_node3(
                str(b["nonce"]),
                str(b["ciphertext"]),
                str(b["tag"]),
                aad,
                version=pkt["protocol_version"] if pkt else 1,
                source=pkt["source_node"] if pkt else 1,
                destination=pkt["destination_node"] if pkt else 3,
                packet_id=pkt_id,
                priority=pkt["priority"] if pkt else 2,
            )
            auth = ok and reading is not None
            decrypted = reading
            reject_reason = err or "AES_GCM_AUTH_TAG_VERIFICATION_FAILED"
        else:
            auth = bool(b.get("authenticated", False))
            reject_reason = str(b.get("error_code", "AES_GCM_AUTH_TAG_VERIFICATION_FAILED"))

        if not auth:
            conn.execute(
                "UPDATE packets SET encryption_status='AUTH_FAILED', destination_status='REJECTED', overall_status='REJECTED', tampered=1, node2_acked=0, updated_at=? WHERE mode='hardware' AND packet_id=?",
                (ts, pkt_id),
            )
            conn.execute(
                "INSERT INTO acknowledgements (mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at) VALUES ('hardware', ?, 'NODE2_NODE3', 3, 2, 'REJECTED_NO_ACK', ?, 0, 1, ?)",
                (pkt_id, reject_reason, ts),
            )
            log_security_event(conn, "hardware", pkt_id, "AUTH_REJECTED", "NODE_3", "REJECTED", pkt["nonce"] if pkt else b.get("nonce"), pkt["key_version"] if pkt else "v1", f"Node 3 rejected packet #{pkt_id}: {reject_reason}")
            create_alert(conn, "hardware", "CRITICAL", "AUTH_FAILURE", f"Node 3 rejected unauthenticated packet #{pkt_id}.", "NODE_3")
            sync_hardware_queue_counts(conn, ts)
            return jsonify({"ok": True, "authenticated": False, "rejected": True}), 201

        temp = parse_finite_float(decrypted["temperature"] if decrypted else b.get("temperature"))
        hum = parse_finite_float(decrypted["humidity"] if decrypted else b.get("humidity"))
        rain_raw_f = parse_finite_float(decrypted["rain_raw"] if decrypted else b.get("rain_raw"))
        if temp is None or hum is None or rain_raw_f is None:
            return jsonify({"error": "Authenticated Node 3 reading requires finite numeric temperature, humidity, and rain_raw"}), 400
        rain_raw = int(round(rain_raw_f))
        rain_cat, priority = classify_rain(rain_raw)
        anom = anom_ml.evaluate(temp, hum, rain_raw, 0.0, 0.0, 0.0, 5.0)

        conn.execute(
            "INSERT OR IGNORE INTO sensor_readings (mode, packet_id, node_id, temperature, humidity, rain_raw, rain_category, priority, authenticated, is_anomaly, anomaly_score, recorded_at) VALUES ('hardware', ?, 'NODE_3', ?, ?, ?, ?, ?, 1, ?, ?, ?)",
            (pkt_id, temp, hum, rain_raw, rain_cat, priority, 1 if anom["is_anomaly"] else 0, anom["anomaly_score"], ts),
        )
        # Keep node2_acked = 0 and destination_status = AUTHENTICATED_AWAITING_ACK until Node 3 ACK arrives at Node 2!
        conn.execute(
            "UPDATE packets SET encryption_status='AUTHENTICATED', destination_status=CASE WHEN node2_acked=1 THEN 'DELIVERED' ELSE 'AUTHENTICATED_AWAITING_ACK' END, overall_status=CASE WHEN node2_acked=1 THEN 'DELIVERED' ELSE 'FORWARDED' END, updated_at=? WHERE mode='hardware' AND packet_id=?",
            (ts, pkt_id),
        )
        log_security_event(conn, "hardware", pkt_id, "AUTH_VERIFIED", "NODE_3", "AUTHENTICATED", pkt["nonce"] if pkt else b.get("nonce"), pkt["key_version"] if pkt else "v1", f"Node 3 authenticated packet #{pkt_id}; awaiting Node 3 ACK confirmation at Node 2.")
        sync_hardware_queue_counts(conn, ts)
    return jsonify({"ok": True, "authenticated": True, "awaiting_node3_ack": True, "rain_category": rain_cat, "anomaly": anom}), 201


@app.post("/api/node3/authentication")
def hw_node3_auth():
    b = request.get_json(silent=True) or {}
    passed = bool(b.get("authenticated", False))
    pkt_id = parse_positive_int(b.get("packet_id"))
    ts = now_iso()
    with db_transaction() as conn:
        log_security_event(conn, "hardware", pkt_id, "AUTH_VERIFIED" if passed else "AUTH_REJECTED", "NODE_3", "AUTHENTICATED" if passed else "REJECTED", b.get("nonce"), str(b.get("key_version", "v1")), str(b.get("details", "Node 3 AES-GCM verification")))
        if pkt_id is not None and not passed:
            conn.execute(
                "UPDATE packets SET encryption_status='AUTH_FAILED', destination_status='REJECTED', overall_status='REJECTED', tampered=1, node2_acked=0, updated_at=? WHERE mode='hardware' AND packet_id=?",
                (ts, pkt_id),
            )
            sync_hardware_queue_counts(conn, ts)
    return jsonify({"ok": True, "authenticated": passed}), 201


@app.post("/api/node3/ack")
def hw_node3_ack():
    b = request.get_json(silent=True) or {}
    pkt_id = parse_positive_int(b.get("packet_id"))
    if pkt_id is None:
        return jsonify({"error": "packet_id must be a positive integer"}), 400
    status = str(b.get("status", "ACK_DELIVERED")).upper()
    if status not in ("ACK_DELIVERED", "LOST", "ACK_TIMEOUT", "REJECTED_NO_ACK"):
        return jsonify({"error": f"Invalid Hop-2 ACK status: {status}"}), 400
    latency = parse_finite_float(b.get("latency_ms", 0)) or 0.0
    ts = now_iso()

    with db_transaction() as conn:
        pkt = conn.execute(
            "SELECT id, gateway_status, encryption_status, overall_status FROM packets WHERE mode='hardware' AND packet_id=?",
            (pkt_id,),
        ).fetchone()
        if not pkt:
            return jsonify({"error": f"Packet #{pkt_id} not found"}), 404

        if status == "ACK_DELIVERED":
            if (
                pkt["gateway_status"] not in ("STORED", "DUPLICATE_SUPPRESSED")
                or pkt["encryption_status"] != "AUTHENTICATED"
                or pkt["overall_status"] == "REJECTED"
            ):
                return jsonify({
                    "error": f"Node 2 cannot mark packet #{pkt_id} DELIVERED without gateway storage and Node 3 AES-GCM authentication.",
                    "code": "CANNOT_ACK_UNAUTHENTICATED_OR_REJECTED_PACKET",
                }), 409

        conn.execute(
            "INSERT INTO acknowledgements (mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at) VALUES ('hardware', ?, 'NODE2_NODE3', 3, 2, ?, ?, ?, 1, ?)",
            (pkt_id, status, b.get("error_code"), latency, ts),
        )
        delivered = False
        if status == "ACK_DELIVERED":
            conn.execute(
                "UPDATE packets SET destination_status='DELIVERED', overall_status='DELIVERED', node2_acked=1, updated_at=? WHERE id=?",
                (ts, pkt["id"]),
            )
            delivered = True
            log_comm_event(conn, "hardware", "DELIVERED", "NODE2_NODE3", "WIFI", pkt_id, f"Node 2 received matching Node 3 ACK_DELIVERED for packet #{pkt_id} and marked delivery complete.", None, latency)
        elif status in ("LOST", "ACK_TIMEOUT"):
            conn.execute(
                "UPDATE packets SET destination_status='RETRYING', retry_count=retry_count+1, node2_acked=0, updated_at=? WHERE id=?",
                (ts, pkt["id"]),
            )
            log_comm_event(conn, "hardware", "HOP2_ACK_LOST", "NODE2_NODE3", "WIFI", pkt_id, f"Node 2 Hop-2 ACK {status} for packet #{pkt_id}; retained in microSD pending queue.", None, latency)
        sync_hardware_queue_counts(conn, ts)
    return jsonify({"ok": True, "packet_id": pkt_id, "status": status, "delivered": delivered}), 201


# --- QUERY, STORAGE, SECURITY, ML, ALERTS, TESTS, SIMULATION & CSV ---
@app.get("/api/packets")
def api_packets():
    mode = get_mode()
    view = str(request.args.get("view", "all")).strip()
    status = str(request.args.get("status", "")).strip().upper()
    priority = str(request.args.get("priority", "")).strip()
    comm_mode = str(request.args.get("comm_mode", "")).strip().upper()
    search = str(request.args.get("search", "")).strip()
    limit = max(10, min(500, int(request.args.get("limit", 120))))

    clauses = ["mode = ?"]
    params: list = [mode]

    if view == "node1_pending":
        clauses.append("node1_acked = 0")
    elif view == "node2_received":
        clauses.append("gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')")
    elif view == "node2_pending_node3":
        clauses.append("gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED') AND node2_acked = 0 AND destination_status != 'REJECTED'")
    elif view == "node3_delivered":
        clauses.append("node2_acked = 1 AND destination_status = 'DELIVERED'")

    if status and status != "ALL":
        clauses.append("overall_status = ?")
        params.append(status)
    if priority in ("1", "2"):
        clauses.append("priority = ?")
        params.append(int(priority))
    if comm_mode and comm_mode != "ALL":
        clauses.append("comm_mode = ?")
        params.append(comm_mode)
    if search:
        clauses.append("(CAST(packet_id AS TEXT) LIKE ? OR nonce LIKE ? OR overall_status LIKE ?)")
        like = f"%{search}%"
        params.extend([like, like, like])

    order_by = "priority ASC, packet_id ASC" if view in ("node1_pending", "node2_pending_node3") else "id DESC"
    params.append(limit)
    conn = get_connection()
    rows = conn.execute(
        f"SELECT * FROM packets WHERE {' AND '.join(clauses)} ORDER BY {order_by} LIMIT ?",
        tuple(params),
    ).fetchall()
    conn.close()
    return jsonify({"mode": mode, "view": view, "packets": [dict(r) for r in rows]})


@app.get("/api/packets/pending")
def api_packets_pending():
    mode = get_mode()
    conn = get_connection()
    n1 = [dict(r) for r in conn.execute("SELECT * FROM packets WHERE mode = ? AND node1_acked = 0 ORDER BY priority ASC, packet_id ASC", (mode,)).fetchall()]
    n2 = [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM packets WHERE mode = ? AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED') AND node2_acked = 0 AND destination_status != 'REJECTED' ORDER BY priority ASC, packet_id ASC",
            (mode,),
        ).fetchall()
    ]
    conn.close()
    return jsonify({"mode": mode, "node1_pending": n1, "node2_pending_node3": n2})


@app.get("/api/packets/<int:packet_id>")
def api_packet_detail(packet_id: int):
    mode = get_mode()
    conn = get_connection()
    pkt = conn.execute("SELECT * FROM packets WHERE mode = ? AND packet_id = ?", (mode, packet_id)).fetchone()
    if not pkt:
        conn.close()
        return jsonify({"error": f"Packet #{packet_id} not found"}), 404
    acks = [dict(r) for r in conn.execute("SELECT * FROM acknowledgements WHERE mode = ? AND packet_id = ? ORDER BY id ASC", (mode, packet_id)).fetchall()]
    sec = [dict(r) for r in conn.execute("SELECT * FROM security_events WHERE mode = ? AND packet_id = ? ORDER BY id ASC", (mode, packet_id)).fetchall()]
    comm = [dict(r) for r in conn.execute("SELECT * FROM communication_events WHERE mode = ? AND packet_id = ? ORDER BY id ASC", (mode, packet_id)).fetchall()]
    reading = (
        conn.execute("SELECT * FROM sensor_readings WHERE mode = ? AND packet_id = ? AND authenticated = 1 LIMIT 1", (mode, packet_id)).fetchone()
        if pkt["encryption_status"] == "AUTHENTICATED" and pkt["destination_status"] != "REJECTED"
        else None
    )
    conn.close()
    return jsonify({"mode": mode, "packet": dict(pkt), "acknowledgements": acks, "security_events": sec, "communication_events": comm, "authenticated_reading": dict(reading) if reading else None})


@app.get("/api/queues")
def api_queues():
    mode = get_mode()
    conn = get_connection()
    n1 = [dict(r) for r in conn.execute("SELECT * FROM packets WHERE mode=? AND node1_acked=0 ORDER BY priority ASC, packet_id ASC", (mode,)).fetchall()]
    n2r = [dict(r) for r in conn.execute("SELECT * FROM packets WHERE mode=? AND gateway_status IN ('STORED','DUPLICATE_SUPPRESSED') ORDER BY id DESC LIMIT 50", (mode,)).fetchall()]
    n2p = [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM packets WHERE mode=? AND gateway_status IN ('STORED','DUPLICATE_SUPPRESSED') AND node2_acked=0 AND destination_status != 'REJECTED' ORDER BY priority ASC, packet_id ASC",
            (mode,),
        ).fetchall()
    ]
    n3 = [dict(r) for r in conn.execute("SELECT * FROM packets WHERE mode=? AND node2_acked=1 AND destination_status='DELIVERED' ORDER BY id DESC LIMIT 50", (mode,)).fetchall()]
    conn.close()
    queues = {
        "node1_pending": n1,
        "node2_received": n2r,
        "node2_pending_node3": n2p,
        "node3_delivered": n3,
    }
    return jsonify({
        "mode": mode,
        "counts": {"node1_pending": len(n1), "node2_received": len(n2r), "node2_pending_node3": len(n2p), "node3_delivered": len(n3)},
        "queues": queues,
        **queues,
    })


@app.get("/api/storage")
def api_storage():
    mode = get_mode()
    conn = get_connection()
    rows = [dict(r, files=json.loads(r["files_json"] or "[]")) for r in conn.execute("SELECT * FROM storage_status WHERE mode=? ORDER BY node_id ASC", (mode,)).fetchall()]
    n1 = [dict(r) for r in conn.execute("SELECT packet_id, priority, created_at FROM packets WHERE mode=? AND node1_acked=0 ORDER BY priority ASC, packet_id ASC", (mode,)).fetchall()]
    n2 = [
        dict(r)
        for r in conn.execute(
            "SELECT packet_id, priority, created_at FROM packets WHERE mode=? AND gateway_status IN ('STORED','DUPLICATE_SUPPRESSED') AND node2_acked=0 AND destination_status != 'REJECTED' ORDER BY priority ASC, packet_id ASC",
            (mode,),
        ).fetchall()
    ]
    conn.close()
    return jsonify({"mode": mode, "storage": rows, "node1_pending_packets": n1, "node2_pending_node3_packets": n2})


@app.get("/api/security")
def api_security():
    mode = get_mode()
    conn = get_connection()
    enc = conn.execute("SELECT COUNT(*) FROM packets WHERE mode=?", (mode,)).fetchone()[0]
    ok = conn.execute("SELECT COUNT(*) FROM packets WHERE mode=? AND encryption_status='AUTHENTICATED'", (mode,)).fetchone()[0]
    fail = conn.execute("SELECT COUNT(*) FROM packets WHERE mode=? AND encryption_status='AUTH_FAILED'", (mode,)).fetchone()[0]
    rej = conn.execute("SELECT COUNT(*) FROM packets WHERE mode=? AND destination_status='REJECTED'", (mode,)).fetchone()[0]
    uniq = conn.execute("SELECT COUNT(DISTINCT nonce) FROM packets WHERE mode=?", (mode,)).fetchone()[0]
    events = [dict(r) for r in conn.execute("SELECT * FROM security_events WHERE mode=? ORDER BY id DESC LIMIT 60", (mode,)).fetchall()]
    conn.close()
    return jsonify({
        "mode": mode,
        "metadata": {"algorithm": "AES-128-GCM", "nonce_bits": 96, "tag_bits": 128, "key_version": security_mgr.key_version, "key_source": security_mgr.key_source, "encryption_endpoint": "Node 1 (ESP32 Sensor Transmitter)", "gateway_behavior": "Node 2 stores & forwards opaque ciphertext; never decrypts", "decryption_endpoint": "Node 3 (ESP32 Destination Receiver)", "unique_nonces_tracked": uniq},
        "metrics": {"encrypted_packet_count": enc, "auth_success_count": ok, "auth_failed_count": fail, "rejected_packet_count": rej, "unique_nonce_verified": uniq == enc, "unique_nonces_count": uniq},
        "events": events,
    })


@app.get("/api/ml/network")
def api_ml_network():
    mode = get_mode()
    enabled = bool(get_settings()["ml_network_enabled"])
    conn = get_connection()
    latest = conn.execute("SELECT * FROM network_metrics WHERE mode=? ORDER BY id DESC LIMIT 1", (mode,)).fetchone()
    history = [dict(r) for r in reversed(conn.execute("SELECT * FROM ml_predictions WHERE mode=? AND model_type='NETWORK_QUALITY' ORDER BY id DESC LIMIT 60", (mode,)).fetchall())]
    conn.close()
    pred = net_ml.predict(dict(latest)) if (enabled and latest) else None
    return jsonify({
        "mode": mode,
        "enabled": enabled,
        "advisory_notice": "Advisory Only — ML does NOT override deterministic Wi-Fi -> LoRa -> LittleFS failover or encryption rules.",
        "latest_features": dict(latest) if latest else None,
        "prediction": pred,
        "reference_model_info": net_ml.get_reference_info(),
        "history": history,
    })


@app.get("/api/ml/anomaly")
def api_ml_anomaly():
    mode = get_mode()
    enabled = bool(get_settings()["ml_anomaly_enabled"])
    conn = get_connection()
    anomalies = [dict(r) for r in conn.execute("SELECT * FROM anomaly_events WHERE mode=? ORDER BY id DESC LIMIT 60", (mode,)).fetchall()]
    readings = [dict(r) for r in reversed(conn.execute("SELECT * FROM sensor_readings WHERE mode=? AND authenticated=1 ORDER BY id DESC LIMIT 50", (mode,)).fetchall())]
    latest_reading = readings[-1] if readings else None
    conn.close()
    return jsonify({
        "mode": mode,
        "enabled": enabled,
        "model_status": anom_ml.model_status,
        "policy_notice": "Anomalous readings are flagged with anomaly_score and ALWAYS preserved — never silently deleted.",
        "anomaly_count": len(anomalies),
        "latest_reading": latest_reading,
        "anomalies": anomalies,
        "recent_readings": readings,
    })


@app.get("/api/history")
def api_history():
    mode = get_mode()
    from_iso = str(request.args.get("from", "")).strip()
    to_iso = str(request.args.get("to", "")).strip()
    limit = max(10, min(500, int(request.args.get("limit", 150))))

    def range_clause(col: str) -> tuple[str, list]:
        parts = ["mode = ?"]
        vals: list = [mode]
        if from_iso:
            parts.append(f"{col} >= ?")
            vals.append(from_iso)
        if to_iso:
            parts.append(f"{col} <= ?")
            vals.append(to_iso)
        vals.append(limit)
        return " AND ".join(parts), vals

    conn = get_connection()
    w, p = range_clause("recorded_at")
    sensors = [dict(r) for r in reversed(conn.execute(f"SELECT * FROM sensor_readings WHERE {w} ORDER BY id DESC LIMIT ?", tuple(p)).fetchall())]
    w, p = range_clause("recorded_at")
    metrics = [dict(r) for r in reversed(conn.execute(f"SELECT * FROM network_metrics WHERE {w} ORDER BY id DESC LIMIT ?", tuple(p)).fetchall())]
    w, p = range_clause("created_at")
    packets = [dict(r) for r in conn.execute(f"SELECT * FROM packets WHERE {w} ORDER BY id DESC LIMIT ?", tuple(p)).fetchall()]
    w, p = range_clause("created_at")
    sec = [dict(r) for r in conn.execute(f"SELECT * FROM security_events WHERE {w} ORDER BY id DESC LIMIT ?", tuple(p)).fetchall()]
    w, p = range_clause("created_at")
    anom = [dict(r) for r in conn.execute(f"SELECT * FROM anomaly_events WHERE {w} ORDER BY id DESC LIMIT ?", tuple(p)).fetchall()]
    w, p = range_clause("created_at")
    comm = [dict(r) for r in conn.execute(f"SELECT * FROM communication_events WHERE {w} ORDER BY id DESC LIMIT ?", tuple(p)).fetchall()]
    conn.close()
    return jsonify({"mode": mode, "sensors": sensors, "metrics": metrics, "packets": packets, "security_events": sec, "anomaly_events": anom, "communication_events": comm})


@app.get("/api/alerts")
def api_alerts():
    mode = get_mode()
    conn = get_connection()
    alerts = [dict(r) for r in conn.execute("SELECT * FROM system_alerts WHERE mode=? ORDER BY id DESC LIMIT 100", (mode,)).fetchall()]
    conn.close()
    return jsonify({"mode": mode, "alerts": alerts})


@app.post("/api/alerts/read")
def api_alerts_read():
    b = request.get_json(silent=True) or {}
    req_mode = b.get("mode")
    mode = req_mode if req_mode in ("simulation", "hardware") else get_mode()
    with db_transaction() as conn:
        if b.get("id"):
            alert_id = parse_positive_int(b["id"])
            if alert_id is None:
                return jsonify({"error": "Invalid alert id"}), 400
            conn.execute("UPDATE system_alerts SET is_read=1 WHERE id=? AND mode=?", (alert_id, mode))
        else:
            conn.execute("UPDATE system_alerts SET is_read=1 WHERE mode=?", (mode,))
    return jsonify({"ok": True})


@app.get("/api/tests")
def api_tests():
    tests = test_mgr.get_all()
    passed = sum(1 for t in tests if t["passed"] is True)
    failed = sum(1 for t in tests if t["passed"] is False)
    return jsonify({"tests": tests, "summary": {"total": len(tests), "passed": passed, "failed": failed, "not_run": len(tests) - passed - failed}})


@app.post("/api/tests/run")
def api_tests_run():
    b = request.get_json(silent=True) or {}
    tid = b.get("test_id")
    if tid is None or b.get("all"):
        tests = test_mgr.run_all()
    else:
        parsed_tid = parse_positive_int(tid)
        if parsed_tid is None or parsed_tid > 8:
            return jsonify({"error": "test_id must be between 1 and 8"}), 400
        test_mgr.run_test(parsed_tid)
        tests = test_mgr.get_all()
    passed = sum(1 for t in tests if t["passed"] is True)
    failed = sum(1 for t in tests if t["passed"] is False)
    return jsonify({"ok": True, "tests": tests, "summary": {"total": len(tests), "passed": passed, "failed": failed, "not_run": len(tests) - passed - failed}})


@app.post("/api/tests/reset")
def api_tests_reset():
    tests = test_mgr.reset()
    return jsonify({"ok": True, "tests": tests, "summary": {"total": len(tests), "passed": 0, "failed": 0, "not_run": len(tests)}})


@app.get("/api/simulation/status")
def api_sim_status():
    return jsonify({"simulation": sim_engine.get_state()})


@app.post("/api/simulation/start")
def api_sim_start():
    return jsonify({"ok": True, "simulation": sim_engine.update_state(running=1, paused=0)})


@app.post("/api/simulation/pause")
def api_sim_pause():
    return jsonify({"ok": True, "simulation": sim_engine.update_state(paused=1)})


@app.post("/api/simulation/resume")
def api_sim_resume():
    return jsonify({"ok": True, "simulation": sim_engine.update_state(running=1, paused=0)})


@app.post("/api/simulation/reset")
def api_sim_reset():
    with sim_lock:
        with db_transaction() as conn:
            for tbl in ("sensor_readings", "packets", "acknowledgements", "network_metrics", "security_events", "ml_predictions", "anomaly_events", "system_alerts", "communication_events"):
                conn.execute(f"DELETE FROM {tbl} WHERE mode='simulation'")
        state = sim_engine.update_state(running=1, paused=0, node1_wifi_on=1, node1_lora_on=1, node2_node3_wifi_on=1, sequence_counter=100)
        sim_engine.sync_node_and_storage_summaries()
    return jsonify({"ok": True, "simulation": state})


@app.post("/api/simulation/control")
def api_sim_control():
    b = request.get_json(silent=True) or {}
    act = str(b.get("action", ""))
    with sim_lock:
        st = sim_engine.get_state()
        if act == "pause":
            return jsonify({"ok": True, "action": act, "message": "Simulation paused", "state": sim_engine.update_state(paused=1)})
        if act == "resume":
            return jsonify({"ok": True, "action": act, "message": "Simulation resumed", "state": sim_engine.update_state(running=1, paused=0)})
        if act == "set_speed":
            speed_ms = max(1000, min(15000, int(b.get("speed_ms", 3500) or 3500)))
            return jsonify({"ok": True, "action": act, "message": f"Simulation speed set to {speed_ms}ms", "state": sim_engine.update_state(speed_ms=speed_ms)})
        if act == "toggle_node1_wifi":
            nv = 0 if st["node1_wifi_on"] else 1
            sim_engine.update_state(node1_wifi_on=nv)
            if nv:
                sim_engine.drain_node1()
                sim_engine.drain_node2()
            sim_engine.sync_node_and_storage_summaries()
            return jsonify({"ok": True, "action": act, "message": f"Node 1 Wi-Fi {'ON' if nv else 'OFF'}", "state": sim_engine.get_state()})
        if act == "toggle_node1_lora":
            nv = 0 if st["node1_lora_on"] else 1
            sim_engine.update_state(node1_lora_on=nv)
            sim_engine.sync_node_and_storage_summaries()
            return jsonify({"ok": True, "action": act, "message": f"Node 1 LoRa {'READY' if nv else 'OFF'}", "state": sim_engine.get_state()})
        if act == "toggle_node2_node3_wifi":
            nv = 0 if st["node2_node3_wifi_on"] else 1
            sim_engine.update_state(node2_node3_wifi_on=nv)
            if nv:
                sim_engine.drain_node2()
            sim_engine.sync_node_and_storage_summaries()
            return jsonify({"ok": True, "action": act, "message": f"Node 2->3 Wi-Fi {'ON' if nv else 'OFF'}", "state": sim_engine.get_state()})
        if act == "restore_all_links":
            sim_engine.update_state(node1_wifi_on=1, node1_lora_on=1, node2_node3_wifi_on=1)
            sim_engine.drain_node1()
            sim_engine.drain_node2()
            sim_engine.sync_node_and_storage_summaries()
            return jsonify({"ok": True, "action": act, "message": "All links restored", "state": sim_engine.get_state()})
        if act == "restart_node":
            res = sim_engine.simulate_nodes_restart()
            return jsonify({"ok": True, "action": act, "message": f"Nodes restarted; recovered {len(res['recovered_node1_pending'])} LittleFS & {len(res['recovered_node2_pending'])} microSD pending packet(s).", "state": sim_engine.get_state()})
        if act == "generate_heavy_rain":
            r = sim_engine.create_and_process_packet(force_heavy_rain=True)
            return jsonify({"ok": True, "action": act, "message": f"Heavy rain packet #{r['packet_id']}", "state": sim_engine.get_state(), "packet_id": r["packet_id"]})
        if act == "generate_routine":
            r = sim_engine.create_and_process_packet(rain_raw=195)
            return jsonify({"ok": True, "action": act, "message": f"Routine packet #{r['packet_id']}", "state": sim_engine.get_state(), "packet_id": r["packet_id"]})
        if act == "drop_ack" or act == "trigger_duplicate":
            r = sim_engine.create_and_process_packet(force_drop_ack=True)
            return jsonify({"ok": True, "action": act, "message": f"Duplicate suppressed on packet #{r['packet_id']}", "state": sim_engine.get_state(), "packet_id": r["packet_id"]})
        if act == "trigger_tamper":
            r = sim_engine.create_and_process_packet(force_tamper=True, tamper_target=str(b.get("target", "ciphertext")))
            return jsonify({"ok": True, "action": act, "message": f"Tampered packet #{r['packet_id']} rejected", "state": sim_engine.get_state(), "packet_id": r["packet_id"]})
        if act == "generate_anomaly":
            r = sim_engine.create_and_process_packet(force_anomaly=True)
            return jsonify({"ok": True, "action": act, "message": f"Anomaly packet #{r['packet_id']} flagged & preserved", "state": sim_engine.get_state(), "packet_id": r["packet_id"]})
    return jsonify({"error": f"Unknown action: {act}"}), 400


@app.get("/api/export/csv")
def api_export_csv():
    mode = get_mode()
    kind = request.args.get("type", "sensors")
    queries = {
        "sensors": ("SELECT id, mode, packet_id, node_id, temperature, humidity, rain_raw, rain_category, priority, authenticated, is_anomaly, anomaly_score, recorded_at FROM sensor_readings WHERE mode=? ORDER BY id DESC", ["id", "mode", "packet_id", "node_id", "temperature", "humidity", "rain_raw", "rain_category", "priority", "authenticated", "is_anomaly", "anomaly_score", "recorded_at"]),
        "network": ("SELECT id, mode, rssi, rssi_variation, packet_loss_ratio, ack_latency_ms, retry_count, queue_depth, link_mode, node2_to_node3_status, recorded_at FROM network_metrics WHERE mode=? ORDER BY id DESC", ["id", "mode", "rssi", "rssi_variation", "packet_loss_ratio", "ack_latency_ms", "retry_count", "queue_depth", "link_mode", "node2_to_node3_status", "recorded_at"]),
        "packets": ("SELECT packet_id, sequence_number, protocol_version, source_node, destination_node, priority, comm_mode, encryption_status, gateway_status, destination_status, overall_status, node1_acked, node2_acked, retry_count, nonce, key_version, is_duplicate, tampered, created_at, updated_at FROM packets WHERE mode=? ORDER BY id DESC", ["packet_id", "sequence_number", "protocol_version", "source_node", "destination_node", "priority", "comm_mode", "encryption_status", "gateway_status", "destination_status", "overall_status", "node1_acked", "node2_acked", "retry_count", "nonce", "key_version", "is_duplicate", "tampered", "created_at", "updated_at"]),
        "security": ("SELECT id, mode, packet_id, event_type, endpoint, status, nonce_hex, key_version, details, created_at FROM security_events WHERE mode=? ORDER BY id DESC", ["id", "mode", "packet_id", "event_type", "endpoint", "status", "nonce_hex", "key_version", "details", "created_at"]),
    }
    if kind not in queries:
        return jsonify({"error": "Invalid CSV type"}), 400
    sql, cols = queries[kind]
    conn = get_connection()
    rows = conn.execute(sql, (mode,)).fetchall()
    conn.close()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(cols)
    for r in rows:
        writer.writerow([csv_safe(r[c]) for c in cols])
    return Response(buf.getvalue(), mimetype="text/csv", headers={"Content-Disposition": f'attachment; filename="resilient_iot_{kind}_{mode}.csv"'})


if __name__ == "__main__":
    start_simulation_worker()
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
