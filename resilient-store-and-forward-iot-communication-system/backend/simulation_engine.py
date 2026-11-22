"""Python store-and-forward simulation engine matching PDF Pages 4-8 for standalone Flask deployment."""
import json
import random
from database import (
    create_alert,
    db_transaction,
    get_connection,
    get_settings,
    log_comm_event,
    log_security_event,
    now_iso,
)
from ml_anomaly import SensorAnomalyModel
from ml_network import NetworkQualityModel
from security_manager import SecurityManager


def classify_rain(rain_raw: int, normal_thresh: int = 350, heavy_thresh: int = 700) -> tuple[str, int]:
    if rain_raw >= heavy_thresh:
        return "HEAVY", 1
    if rain_raw >= normal_thresh:
        return "NORMAL", 2
    return "DRY", 2


class SimulationEngine:
    def __init__(self, sec: SecurityManager, net_ml: NetworkQualityModel, anom_ml: SensorAnomalyModel) -> None:
        self.sec = sec
        self.net_ml = net_ml
        self.anom_ml = anom_ml
        self.last_rssi = -60.0

    def get_state(self) -> dict:
        conn = get_connection()
        row = conn.execute("SELECT * FROM simulation_state WHERE id = 1").fetchone()
        conn.close()
        return dict(row) if row else {}

    def update_state(self, **kwargs) -> dict:
        allowed = {
            "running", "paused", "speed_ms", "node1_wifi_on", "node1_lora_on",
            "node2_node3_wifi_on", "drop_next_ack", "tamper_next_packet",
            "duplicate_next_packet", "wifi_healthy", "good_wifi_streak",
            "bad_wifi_streak", "sequence_counter", "last_temp", "last_humidity", "last_rain_raw",
        }
        sets = [f"{k} = ?" for k in kwargs if k in allowed]
        vals = [kwargs[k] for k in kwargs if k in allowed]
        sets.append("updated_at = ?")
        vals.append(now_iso())
        with db_transaction() as conn:
            conn.execute(f"UPDATE simulation_state SET {', '.join(sets)} WHERE id = 1", vals)
        return self.get_state()

    def configure_links(self, wifi1: bool, lora1: bool, wifi23: bool) -> dict:
        state = self.update_state(
            node1_wifi_on=1 if wifi1 else 0,
            node1_lora_on=1 if lora1 else 0,
            node2_node3_wifi_on=1 if wifi23 else 0,
            wifi_healthy=1 if wifi1 else 0,
            good_wifi_streak=3 if wifi1 else 0,
            bad_wifi_streak=0 if wifi1 else 3,
        )
        self.last_rssi = -60.0 if wifi1 else -110.0
        self.sync_node_and_storage_summaries()
        return state

    def simulate_nodes_restart(self) -> dict:
        ts = now_iso()
        with db_transaction() as conn:
            conn.execute(
                "UPDATE nodes SET status = 'RESTARTING', updated_at = ? WHERE mode = 'simulation' AND node_id IN ('NODE_1', 'NODE_2')",
                (ts,),
            )
            state_row = conn.execute("SELECT sequence_counter FROM simulation_state WHERE id = 1").fetchone()
            max_seq = conn.execute(
                "SELECT COALESCE(MAX(sequence_number), 100) AS m FROM packets WHERE mode = 'simulation'"
            ).fetchone()["m"]
            recovered_seq = max(int(state_row["sequence_counter"]), int(max_seq))
            conn.execute("UPDATE simulation_state SET sequence_counter = ?, updated_at = ? WHERE id = 1", (recovered_seq, ts))

            n1_pending = [
                r["packet_id"]
                for r in conn.execute(
                    "SELECT packet_id FROM packets WHERE mode = 'simulation' AND node1_acked = 0 ORDER BY priority ASC, packet_id ASC"
                ).fetchall()
            ]
            n2_pending = [
                r["packet_id"]
                for r in conn.execute(
                    """
                    SELECT packet_id FROM packets
                    WHERE mode = 'simulation'
                      AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')
                      AND node2_acked = 0
                      AND destination_status != 'REJECTED'
                    ORDER BY priority ASC, packet_id ASC
                    """
                ).fetchall()
            ]
            log_comm_event(
                conn,
                "simulation",
                "NODE_RESTART",
                "NODE1_NODE2",
                "RECOVERY",
                n1_pending[0] if n1_pending else None,
                f"Node 1 & Node 2 restarted; reloading LittleFS ({len(n1_pending)} un-ACKed) & microSD ({len(n2_pending)} un-ACKed).",
            )
            log_comm_event(
                conn,
                "simulation",
                "QUEUE_RECOVERED",
                "NODE2_NODE3",
                "RECOVERY",
                n2_pending[0] if n2_pending else None,
                f"Recovered LittleFS={n1_pending}, microSD={n2_pending}, sequence_counter=#{recovered_seq}.",
            )
            create_alert(
                conn,
                "simulation",
                "INFO",
                "TEST_RESTART_RECOVERY",
                f"Nodes restarted: recovered {len(n1_pending)} LittleFS and {len(n2_pending)} microSD pending packet(s).",
                "NODE_1",
            )
        self.sync_node_and_storage_summaries()
        return {
            "recovered_node1_pending": n1_pending,
            "recovered_node2_pending": n2_pending,
            "sequence_counter": recovered_seq,
        }

    def sync_node_and_storage_summaries(self) -> None:
        ts = now_iso()
        state = self.get_state()
        conn = get_connection()
        n1_pending = [
            r["packet_id"]
            for r in conn.execute(
                "SELECT packet_id FROM packets WHERE mode = 'simulation' AND node1_acked = 0 ORDER BY priority ASC, packet_id ASC"
            ).fetchall()
        ]
        n2_stored = conn.execute(
            "SELECT COUNT(*) AS c FROM packets WHERE mode = 'simulation' AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')"
        ).fetchone()["c"]
        n2_pending = [
            r["packet_id"]
            for r in conn.execute(
                """
                SELECT packet_id FROM packets
                WHERE mode = 'simulation'
                  AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')
                  AND node2_acked = 0
                  AND destination_status != 'REJECTED'
                ORDER BY priority ASC, packet_id ASC
                """
            ).fetchall()
        ]
        latest = conn.execute(
            "SELECT * FROM sensor_readings WHERE mode = 'simulation' AND authenticated = 1 ORDER BY id DESC LIMIT 1"
        ).fetchone()
        conn.close()

        link_mode_n1 = "WIFI" if (state["node1_wifi_on"] and state["wifi_healthy"]) else ("LORA" if state["node1_lora_on"] else "OFFLINE")
        n2_to_n3 = ("RETRYING" if n2_pending else "CONNECTED") if state["node2_node3_wifi_on"] else "DISCONNECTED"
        lcd1 = f"T:{latest['temperature']:.1f}C H:{latest['humidity']:.0f}%" if latest else "AWAITING DATA"
        lcd2 = f"RAIN:{latest['rain_category']} #{latest['packet_id']}" if latest else "AUTH REQUIRED"

        littlefs_files = [f"/pending/packet_{pid:06d}.bin" for pid in n1_pending] + [
            "/state/sequence_counter",
            "/state/config.json",
        ]
        sd_files = [
            f"/gateway/received_packets.bin ({n2_stored} envelopes)",
            f"/gateway/node3_pending.log ({len(n2_pending)} pending IDs)",
            "/gateway/delivery_status.csv",
            "/gateway/network_metrics.csv",
            "/gateway/gateway_config.json",
        ]

        with db_transaction() as c:
            c.execute(
                """
                UPDATE nodes SET status='ONLINE', link_mode=?, rssi=?, queue_count=?, storage_status='MOUNTED',
                    last_heartbeat=?, metadata_json=?, updated_at=?
                WHERE node_id='NODE_1' AND mode='simulation'
                """,
                (
                    link_mode_n1,
                    self.last_rssi if state["node1_wifi_on"] else -110.0,
                    len(n1_pending),
                    ts,
                    json.dumps({
                        "wifi_status": "HEALTHY" if state["node1_wifi_on"] else "OFF",
                        "lora_status": "ACTIVE_TX" if link_mode_n1 == "LORA" else ("READY" if state["node1_lora_on"] else "OFF"),
                        "pending_ids": n1_pending,
                        "sequence_counter": state["sequence_counter"],
                    }),
                    ts,
                ),
            )
            c.execute(
                """
                UPDATE nodes SET status='ONLINE', link_mode=?, rssi=?, queue_count=?, storage_status='MOUNTED',
                    last_heartbeat=?, metadata_json=?, updated_at=?
                WHERE node_id='NODE_2' AND mode='simulation'
                """,
                (
                    link_mode_n1,
                    self.last_rssi if state["node1_wifi_on"] else -102.0,
                    len(n2_pending),
                    ts,
                    json.dumps({
                        "wifi_receiver": "ACTIVE" if state["node1_wifi_on"] else "NO_SIGNAL",
                        "lora_transceiver": "BIDIRECTIONAL_READY" if state["node1_lora_on"] else "OFFLINE",
                        "node3_link": n2_to_n3,
                        "stored_count": n2_stored,
                        "pending_node3_ids": n2_pending,
                    }),
                    ts,
                ),
            )
            c.execute(
                """
                UPDATE nodes SET status=?, link_mode=?, rssi=?, queue_count=0, storage_status='N/A',
                    lcd_status=?, last_heartbeat=?, metadata_json=?, updated_at=?
                WHERE node_id='NODE_3' AND mode='simulation'
                """,
                (
                    "ONLINE" if state["node2_node3_wifi_on"] else "OFFLINE",
                    "WIFI" if state["node2_node3_wifi_on"] else "OFFLINE",
                    -58.0 if state["node2_node3_wifi_on"] else None,
                    "ACTIVE" if state["node2_node3_wifi_on"] else "STANDBY_LAST_AUTH",
                    ts if state["node2_node3_wifi_on"] else None,
                    json.dumps({
                        "wifi_receiver": "CONNECTED" if state["node2_node3_wifi_on"] else "DISCONNECTED",
                        "aes_gcm": "VERIFY_BEFORE_DISPLAY",
                        "lcd_line1": lcd1,
                        "lcd_line2": lcd2,
                        "last_authenticated_packet": latest["packet_id"] if latest else None,
                    }),
                    ts,
                ),
            )
            c.execute(
                "UPDATE storage_status SET status='MOUNTED', pending_count=?, stored_count=?, sequence_counter=?, files_json=?, updated_at=? WHERE mode='simulation' AND node_id='NODE_1'",
                (len(n1_pending), len(n1_pending), state["sequence_counter"], json.dumps(littlefs_files), ts),
            )
            c.execute(
                "UPDATE storage_status SET status='MOUNTED', capacity_gb=16.0, pending_count=?, stored_count=?, sequence_counter=?, files_json=?, updated_at=? WHERE mode='simulation' AND node_id='NODE_2'",
                (len(n2_pending), n2_stored, state["sequence_counter"], json.dumps(sd_files), ts),
            )

    def create_and_process_packet(
        self,
        temperature: float | None = None,
        humidity: float | None = None,
        rain_raw: int | None = None,
        force_heavy_rain: bool = False,
        force_anomaly: bool = False,
        force_tamper: bool = False,
        tamper_target: str = "ciphertext",
        force_drop_ack: bool = False,
        force_drop_hop2_ack: bool = False,
    ) -> dict:
        settings = get_settings()
        state = self.get_state()
        temp = round(temperature if temperature is not None else max(18.0, min(39.0, state["last_temp"] + random.uniform(-0.35, 0.35))), 1)
        hum = round(humidity if humidity is not None else max(35.0, min(92.0, state["last_humidity"] + random.uniform(-1.2, 1.2))), 1)
        rain = int(rain_raw if rain_raw is not None else max(60, min(1023, state["last_rain_raw"] + random.randint(-45, 55))))
        if force_heavy_rain:
            rain = max(int(settings["rain_heavy_threshold"]) + 120, 845)
        if force_anomaly:
            temp = round(state["last_temp"] + 14.8, 1)
            hum = 97.5

        rain_cat, priority = classify_rain(rain, int(settings["rain_normal_threshold"]), int(settings["rain_heavy_threshold"]))

        # Strictly monotonic packet ID backed by both persistent counter and DB max
        conn = get_connection()
        max_existing = conn.execute(
            "SELECT COALESCE(MAX(packet_id), 100) AS m FROM packets WHERE mode = 'simulation'"
        ).fetchone()["m"]
        pkt_id = max(int(state["sequence_counter"]), int(max_existing)) + 1

        def _db_nonce_exists(nonce_hex: str) -> bool:
            return (
                conn.execute("SELECT 1 FROM packets WHERE mode = 'simulation' AND nonce = ? LIMIT 1", (nonce_hex,)).fetchone()
                is not None
            )

        payload = {"rain": rain_cat, "rain_raw": rain, "temperature": temp, "humidity": hum}
        env = self.sec.encrypt_node1(pkt_id, priority, payload, external_nonce_exists=_db_nonce_exists)
        conn.close()

        ts = now_iso()
        with db_transaction() as c:
            c.execute(
                """
                INSERT INTO packets (
                    mode, packet_id, sequence_number, protocol_version, source_node, destination_node,
                    priority, comm_mode, encryption_status, gateway_status, destination_status,
                    overall_status, retry_count, nonce, ciphertext, auth_tag, aad, key_version,
                    is_duplicate, tampered, node1_acked, node2_acked, payload_preview_json, created_at, updated_at
                ) VALUES ('simulation', ?, ?, 1, 1, 3, ?, 'PENDING', 'ENCRYPTED', 'PENDING', 'PENDING', 'PENDING', 0, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, ?, ?)
                """,
                (pkt_id, pkt_id, priority, env["nonce"], env["ciphertext"], env["tag"], env["aad"], env["key_version"], ts, ts),
            )
            log_security_event(
                c,
                "simulation",
                pkt_id,
                "ENCRYPT",
                "NODE_1",
                "SUCCESS",
                env["nonce"],
                env["key_version"],
                f"Node 1 encrypted packet #{pkt_id} with AES-128-GCM (unique 96-bit nonce) and persisted in LittleFS awaiting gateway ACK.",
            )
            if rain_cat == "HEAVY":
                create_alert(c, "simulation", "CRITICAL", "HEAVY_RAIN", f"Heavy rain detected (raw={rain}). High priority P1 assigned to packet #{pkt_id}.", "NODE_1")
            c.execute(
                "UPDATE simulation_state SET sequence_counter = ?, last_temp = ?, last_humidity = ?, last_rain_raw = ?, updated_at = ? WHERE id = 1",
                (pkt_id, temp, hum, rain, ts),
            )

        self.drain_node1(target_pkt=pkt_id, drop_ack=force_drop_ack)
        self.drain_node2(target_pkt=pkt_id, tamper=force_tamper, tamper_target=tamper_target, drop_hop2_ack=force_drop_hop2_ack)
        self.sync_node_and_storage_summaries()

        conn = get_connection()
        row = conn.execute("SELECT overall_status FROM packets WHERE mode = 'simulation' AND packet_id = ?", (pkt_id,)).fetchone()
        conn.close()
        return {"packet_id": pkt_id, "overall_status": row["overall_status"] if row else "PENDING"}

    def drain_node1(self, target_pkt: int | None = None, drop_ack: bool = False) -> None:
        state = self.get_state()
        settings = get_settings()
        conn = get_connection()
        pending = conn.execute(
            "SELECT * FROM packets WHERE mode = 'simulation' AND node1_acked = 0 ORDER BY priority ASC, packet_id ASC"
        ).fetchall()
        conn.close()

        for pkt in pending:
            ts = now_iso()
            comm = "WIFI" if state["node1_wifi_on"] else ("LORA" if state["node1_lora_on"] else "OFFLINE")
            if comm == "OFFLINE":
                next_retry = min(int(settings["retry_limit"]), int(pkt["retry_count"]) + 1)
                offline_status = "RETRYING" if next_retry < int(settings["retry_limit"]) else "PENDING"
                with db_transaction() as c:
                    c.execute(
                        "UPDATE packets SET comm_mode = 'OFFLINE', overall_status = ?, retry_count = ?, updated_at = ? WHERE id = ?",
                        (offline_status, next_retry, ts, pkt["id"]),
                    )
                    log_comm_event(c, "simulation", "OFFLINE_QUEUE", "NODE1_NODE2", "OFFLINE", pkt["packet_id"], f"Packet #{pkt['packet_id']} queued in Node 1 LittleFS (node1_acked=0).")
                continue

            # Node 2 inspects envelope format ONLY — never decrypts sensor payload
            env_ok, env_err = SecurityManager.validate_envelope_format(
                pkt["nonce"],
                pkt["ciphertext"],
                pkt["auth_tag"],
                pkt["aad"],
                pkt["protocol_version"],
                pkt["source_node"],
                pkt["destination_node"],
                pkt["packet_id"],
                pkt["priority"],
            )
            if not env_ok:
                with db_transaction() as c:
                    log_security_event(c, "simulation", pkt["packet_id"], "ENVELOPE_FORMAT_ERROR", "NODE_2", "REJECTED", pkt["nonce"], pkt["key_version"], f"Node 2 rejected malformed envelope: {env_err}")
                continue

            is_target = target_pkt is None or target_pkt == pkt["packet_id"]
            rssi = round(random.uniform(-68.0, -56.0), 1) if comm == "WIFI" else -96.0
            self.last_rssi = rssi
            lat = round(random.uniform(45.0, 110.0), 1) if comm == "WIFI" else round(random.uniform(250.0, 420.0), 1)

            with db_transaction() as c:
                log_comm_event(c, "simulation", "WIFI_TX" if comm == "WIFI" else "LORA_TX", "NODE1_NODE2", comm, pkt["packet_id"], f"Node 1 transmitted encrypted packet #{pkt['packet_id']} over {comm} (identical persisted ciphertext).", rssi, lat)

                if drop_ack and is_target:
                    # Phase 1: Node 2 persists opaque ciphertext on microSD, but Hop-1 ACK is lost.
                    # Node 1 MUST NOT retire the packet from LittleFS (node1_acked remains 0).
                    c.execute(
                        "UPDATE packets SET comm_mode = ?, gateway_status = 'STORED', overall_status = 'GATEWAY_STORED', node1_acked = 0, updated_at = ? WHERE id = ?",
                        (comm, ts, pkt["id"]),
                    )
                    c.execute(
                        "INSERT INTO acknowledgements (mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at) VALUES ('simulation', ?, 'NODE1_NODE2', 2, 1, 'LOST', 'ACK_TIMEOUT', ?, 1, ?)",
                        (pkt["packet_id"], settings["ack_timeout_ms"], ts),
                    )
                    log_comm_event(c, "simulation", "ACK_LOST", "NODE1_NODE2", comm, pkt["packet_id"], f"Hop-1 ACK lost for packet #{pkt['packet_id']}; packet retained in Node 1 LittleFS (node1_acked=0) for identical-ciphertext retry.", rssi, settings["ack_timeout_ms"])

                    # Phase 2: Node 1 re-reads persisted bytes without re-encrypting and retransmits.
                    persisted = c.execute("SELECT nonce, ciphertext, auth_tag, aad FROM packets WHERE id = ?", (pkt["id"],)).fetchone()
                    if (
                        not persisted
                        or persisted["nonce"] != pkt["nonce"]
                        or persisted["ciphertext"] != pkt["ciphertext"]
                        or persisted["auth_tag"] != pkt["auth_tag"]
                        or persisted["aad"] != pkt["aad"]
                    ):
                        raise RuntimeError(f"Protocol violation: ciphertext mutated during retransmission of packet #{pkt['packet_id']}")

                    c.execute(
                        "UPDATE packets SET gateway_status = 'DUPLICATE_SUPPRESSED', overall_status = 'GATEWAY_STORED', retry_count = retry_count + 1, is_duplicate = 1, updated_at = ? WHERE id = ?",
                        (ts, pkt["id"]),
                    )
                    c.execute(
                        "INSERT INTO acknowledgements (mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at) VALUES ('simulation', ?, 'NODE1_NODE2', 2, 1, 'ACK_DUPLICATE_RESENT', NULL, ?, 1, ?)",
                        (pkt["packet_id"], lat, ts),
                    )
                    log_comm_event(c, "simulation", "DUPLICATE_SUPPRESSED", "NODE1_NODE2", comm, pkt["packet_id"], f"Node 2 detected duplicate #{pkt['packet_id']} (identical ciphertext), avoided double storage, and resent matching ACK.", rssi, lat)

                    # Node 1 verifies matching gateway ACK before retiring LittleFS file
                    ack_match = c.execute(
                        "SELECT id FROM acknowledgements WHERE mode='simulation' AND packet_id=? AND link_hop='NODE1_NODE2' AND sender_node=2 AND receiver_node=1 AND status='ACK_DUPLICATE_RESENT' ORDER BY id DESC LIMIT 1",
                        (pkt["packet_id"],),
                    ).fetchone()
                    if ack_match:
                        c.execute("UPDATE packets SET node1_acked = 1, updated_at = ? WHERE id = ?", (ts, pkt["id"]))
                else:
                    already_stored = pkt["gateway_status"] in ("STORED", "DUPLICATE_SUPPRESSED")
                    next_gw = "DUPLICATE_SUPPRESSED" if already_stored else "STORED"
                    ack_status = "ACK_DUPLICATE_RESENT" if already_stored else "ACK_STORED"
                    c.execute(
                        "UPDATE packets SET comm_mode = ?, gateway_status = ?, overall_status = 'GATEWAY_STORED', is_duplicate = CASE WHEN ? = 1 THEN 1 ELSE is_duplicate END, retry_count = CASE WHEN ? = 1 THEN retry_count + 1 ELSE retry_count END, updated_at = ? WHERE id = ?",
                        (comm, next_gw, 1 if already_stored else 0, 1 if already_stored else 0, ts, pkt["id"]),
                    )
                    c.execute(
                        "INSERT INTO acknowledgements (mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at) VALUES ('simulation', ?, 'NODE1_NODE2', 2, 1, ?, NULL, ?, 1, ?)",
                        (pkt["packet_id"], ack_status, lat, ts),
                    )
                    # Node 1 retires LittleFS entry ONLY after verifying matching gateway ACK
                    ack_match = c.execute(
                        "SELECT id FROM acknowledgements WHERE mode='simulation' AND packet_id=? AND link_hop='NODE1_NODE2' AND sender_node=2 AND receiver_node=1 AND status=? ORDER BY id DESC LIMIT 1",
                        (pkt["packet_id"], ack_status),
                    ).fetchone()
                    if ack_match:
                        c.execute("UPDATE packets SET node1_acked = 1, updated_at = ? WHERE id = ?", (ts, pkt["id"]))
                    log_comm_event(
                        c,
                        "simulation",
                        "DUPLICATE_SUPPRESSED" if already_stored else "ACK_RECEIVED",
                        "NODE1_NODE2",
                        comm,
                        pkt["packet_id"],
                        f"Node 2 suppressed duplicate #{pkt['packet_id']} and resent matching ACK; Node 1 retired LittleFS file."
                        if already_stored
                        else f"Node 2 stored opaque ciphertext #{pkt['packet_id']} on microSD and sent matching ACK; Node 1 retired LittleFS file.",
                        rssi,
                        lat,
                    )

                features = {"rssi": rssi, "rssi_variation": 1.8, "packet_loss_ratio": 0.02, "ack_latency_ms": lat, "retry_count": int(pkt["retry_count"]), "queue_depth": 0}
                c.execute("INSERT INTO network_metrics (mode, rssi, rssi_variation, packet_loss_ratio, ack_latency_ms, retry_count, queue_depth, link_mode, node2_to_node3_status, recorded_at) VALUES ('simulation', ?, ?, ?, ?, ?, ?, ?, ?, ?)", (rssi, 1.8, 0.02, lat, int(pkt["retry_count"]), 0, comm, "CONNECTED" if state["node2_node3_wifi_on"] else "DISCONNECTED", ts))
                if settings.get("ml_network_enabled", True):
                    pred = self.net_ml.predict(features)
                    c.execute("INSERT INTO ml_predictions (mode, model_type, predicted_class, confidence, risk_score, baseline_class, features_json, model_status, created_at) VALUES ('simulation', 'NETWORK_QUALITY', ?, ?, ?, ?, ?, ?, ?)", (pred["predicted_class"], pred["confidence"], pred["risk_score"], pred["baseline_class"], json.dumps(features), pred["evaluation"]["model_status"], ts))

    def drain_node2(
        self,
        target_pkt: int | None = None,
        tamper: bool = False,
        tamper_target: str = "ciphertext",
        drop_hop2_ack: bool = False,
    ) -> None:
        state = self.get_state()
        settings = get_settings()
        conn = get_connection()
        pending = conn.execute(
            """
            SELECT * FROM packets
            WHERE mode = 'simulation'
              AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')
              AND node2_acked = 0
              AND destination_status != 'REJECTED'
            ORDER BY priority ASC, packet_id ASC
            """
        ).fetchall()
        conn.close()

        for pkt in pending:
            ts = now_iso()
            if not state["node2_node3_wifi_on"]:
                with db_transaction() as c:
                    c.execute(
                        "UPDATE packets SET destination_status = 'RETRYING', overall_status = 'GATEWAY_STORED', node2_acked = 0, updated_at = ? WHERE id = ?",
                        (ts, pkt["id"]),
                    )
                    log_comm_event(c, "simulation", "NODE3_PENDING", "NODE2_NODE3", "OFFLINE", pkt["packet_id"], f"Node 3 offline; packet #{pkt['packet_id']} retained on Node 2 microSD (node2_acked=0).")
                continue

            ct, tag = pkt["ciphertext"], pkt["auth_tag"]
            is_target = target_pkt is None or target_pkt == pkt["packet_id"]
            if tamper and is_target:
                if tamper_target == "tag":
                    b = bytearray.fromhex(tag)
                    b[0] ^= 0xFF
                    tag = b.hex()
                else:
                    b = bytearray.fromhex(ct)
                    b[0] ^= 0xFF
                    ct = b.hex()

            # Node 3 verifies AES-128-GCM auth tag with canonical AAD recomputed from header fields
            ok, reading, err = self.sec.verify_and_decrypt_node3(
                pkt["nonce"],
                ct,
                tag,
                pkt["aad"],
                version=pkt["protocol_version"],
                source=pkt["source_node"],
                destination=pkt["destination_node"],
                packet_id=pkt["packet_id"],
                priority=pkt["priority"],
            )
            with db_transaction() as c:
                if not ok or reading is None:
                    c.execute(
                        "UPDATE packets SET ciphertext = ?, auth_tag = ?, encryption_status = 'AUTH_FAILED', destination_status = 'REJECTED', overall_status = 'REJECTED', tampered = 1, node2_acked = 0, updated_at = ? WHERE id = ?",
                        (ct, tag, ts, pkt["id"]),
                    )
                    c.execute(
                        "INSERT INTO acknowledgements (mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at) VALUES ('simulation', ?, 'NODE2_NODE3', 3, 2, 'REJECTED_NO_ACK', ?, 40, 1, ?)",
                        (pkt["packet_id"], err, ts),
                    )
                    log_security_event(c, "simulation", pkt["packet_id"], "AUTH_REJECTED", "NODE_3", "REJECTED", pkt["nonce"], pkt["key_version"], f"AES-128-GCM tag check failed at Node 3 for packet #{pkt['packet_id']}.")
                    create_alert(c, "simulation", "CRITICAL", "AUTH_FAILURE", f"Node 3 rejected tampered packet #{pkt['packet_id']}.", "NODE_3")
                    continue

                anom = (
                    self.anom_ml.evaluate(reading["temperature"], reading["humidity"], reading["rain_raw"], 0.0, 0.0, 0.0, 3.5)
                    if settings.get("ml_anomaly_enabled", True)
                    else {"is_anomaly": False, "anomaly_score": 0.0, "status": "NORMAL"}
                )
                c.execute(
                    "INSERT OR IGNORE INTO sensor_readings (mode, packet_id, node_id, temperature, humidity, rain_raw, rain_category, priority, authenticated, is_anomaly, anomaly_score, recorded_at) VALUES ('simulation', ?, 'NODE_3', ?, ?, ?, ?, ?, 1, ?, ?, ?)",
                    (pkt["packet_id"], reading["temperature"], reading["humidity"], reading["rain_raw"], reading["rain"], pkt["priority"], 1 if anom["is_anomaly"] else 0, anom["anomaly_score"], ts),
                )
                log_security_event(c, "simulation", pkt["packet_id"], "AUTH_VERIFIED", "NODE_3", "AUTHENTICATED", pkt["nonce"], pkt["key_version"], f"Node 3 verified AES-GCM tag and decrypted packet #{pkt['packet_id']}.")

                if drop_hop2_ack and is_target:
                    # Hop-2 ACK lost: Node 2 MUST keep packet pending (node2_acked=0)
                    c.execute(
                        "UPDATE packets SET encryption_status = 'AUTHENTICATED', destination_status = 'RETRYING', overall_status = 'FORWARDED', retry_count = retry_count + 1, node2_acked = 0, updated_at = ? WHERE id = ?",
                        (ts, pkt["id"]),
                    )
                    c.execute(
                        "INSERT INTO acknowledgements (mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at) VALUES ('simulation', ?, 'NODE2_NODE3', 3, 2, 'LOST', 'HOP2_ACK_TIMEOUT', ?, 1, ?)",
                        (pkt["packet_id"], settings["ack_timeout_ms"], ts),
                    )
                    log_comm_event(c, "simulation", "HOP2_ACK_LOST", "NODE2_NODE3", "WIFI", pkt["packet_id"], f"Hop-2 ACK lost for packet #{pkt['packet_id']}; Node 2 retains packet in microSD pending queue (node2_acked=0).", -58.0, settings["ack_timeout_ms"])
                    continue

                c.execute(
                    "INSERT INTO acknowledgements (mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at) VALUES ('simulation', ?, 'NODE2_NODE3', 3, 2, 'ACK_DELIVERED', NULL, 42, 1, ?)",
                    (pkt["packet_id"], ts),
                )
                # Node 2 marks DELIVERED ONLY after verifying matching Node 3 ACK_DELIVERED
                ack3 = c.execute(
                    "SELECT id FROM acknowledgements WHERE mode='simulation' AND packet_id=? AND link_hop='NODE2_NODE3' AND sender_node=3 AND receiver_node=2 AND status='ACK_DELIVERED' ORDER BY id DESC LIMIT 1",
                    (pkt["packet_id"],),
                ).fetchone()
                if ack3:
                    c.execute(
                        "UPDATE packets SET encryption_status = 'AUTHENTICATED', destination_status = 'DELIVERED', overall_status = 'DELIVERED', node2_acked = 1, updated_at = ? WHERE id = ?",
                        (ts, pkt["id"]),
                    )
                    log_comm_event(c, "simulation", "DELIVERED", "NODE2_NODE3", "WIFI", pkt["packet_id"], f"Packet #{pkt['packet_id']} authenticated by Node 3 and marked DELIVERED at Node 2 only after matching Node 3 ACK.", -58.0, 42.0)

                if anom["is_anomaly"]:
                    c.execute(
                        "INSERT INTO anomaly_events (mode, packet_id, temperature, humidity, rain_raw, anomaly_score, status, reason, preserved, created_at) VALUES ('simulation', ?, ?, ?, ?, ?, ?, ?, 1, ?)",
                        (pkt["packet_id"], reading["temperature"], reading["humidity"], reading["rain_raw"], anom["anomaly_score"], anom["status"], "Isolation Forest flagged unusual telemetry. Original reading preserved.", ts),
                    )
