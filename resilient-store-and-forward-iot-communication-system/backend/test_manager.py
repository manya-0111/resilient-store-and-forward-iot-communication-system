"""Python Test Manager implementing all 8 PDF Page 12 System Test Cases with strict SQLite state assertions."""
import json
from database import db_transaction, get_connection, now_iso
from simulation_engine import SimulationEngine

TEST_DEFS = [
    (1, "Normal Wi-Fi Communication", {"node1_wifi": "ON", "node1_lora": "Ready", "node2_node3_wifi": "ON"}, "Wi-Fi packet reaches Node 2, is stored, forwarded, decrypted at Node 3 and ACKed."),
    (2, "Wi-Fi Failure with LoRa Fallback", {"node1_wifi": "OFF", "node1_lora": "ON", "node2_node3_wifi": "ON"}, "LoRa delivers packet to gateway; Node 2 stores and forwards it."),
    (3, "Both Node 1 Links Unavailable (LittleFS Store-and-Forward)", {"node1_wifi": "OFF", "node1_lora": "OFF", "node2_node3_wifi": "ON"}, "Node 1 saves packet in LittleFS; it is forwarded after a link returns."),
    (4, "Node 3 Unavailable (microSD Independent Buffering)", {"node1_wifi": "ON", "node1_lora": "Ready", "node2_node3_wifi": "OFF"}, "Node 2 stores packet; Node 3 pending queue grows; delivery occurs after reconnection."),
    (5, "All Communication Links Unavailable", {"node1_wifi": "OFF", "node1_lora": "OFF", "node2_node3_wifi": "OFF"}, "Node 1 and Node 2 retain their respective pending queues; no data is falsely marked delivered."),
    (6, "ACK Loss and Duplicate Detection", {"node1_wifi": "ON", "node1_lora": "Ready", "node2_node3_wifi": "ON"}, "Drop an ACK; retransmission is deduplicated and correct ACK is resent."),
    (7, "AES-128-GCM Ciphertext/Tag Tampering", {"node1_wifi": "ON", "node1_lora": "Ready", "node2_node3_wifi": "ON"}, "Modify ciphertext/tag; Node 3 rejects authentication and does not display the reading as valid."),
    (8, "Node Restart with Pending Packets", {"node1_wifi": "ON", "node1_lora": "Ready", "node2_node3_wifi": "ON"}, "Restart nodes while packets are pending; persistent queues recover correctly."),
]


def _get_packet(pid: int) -> dict | None:
    conn = get_connection()
    row = conn.execute("SELECT * FROM packets WHERE mode='simulation' AND packet_id=?", (pid,)).fetchone()
    conn.close()
    return dict(row) if row else None


def _get_node(nid: str) -> dict:
    conn = get_connection()
    row = conn.execute("SELECT * FROM nodes WHERE mode='simulation' AND node_id=?", (nid,)).fetchone()
    conn.close()
    d = dict(row)
    d["metadata"] = json.loads(d.get("metadata_json") or "{}")
    return d


def _get_storage(nid: str) -> dict:
    conn = get_connection()
    row = conn.execute("SELECT * FROM storage_status WHERE mode='simulation' AND node_id=?", (nid,)).fetchone()
    conn.close()
    d = dict(row)
    d["files"] = json.loads(d.get("files_json") or "[]")
    return d


def _get_acks(pid: int, hop: str | None = None) -> list[dict]:
    conn = get_connection()
    if hop:
        rows = conn.execute("SELECT * FROM acknowledgements WHERE mode='simulation' AND packet_id=? AND link_hop=? ORDER BY id ASC", (pid, hop)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM acknowledgements WHERE mode='simulation' AND packet_id=? ORDER BY id ASC", (pid,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _get_readings(pid: int) -> list[dict]:
    conn = get_connection()
    rows = conn.execute("SELECT * FROM sensor_readings WHERE mode='simulation' AND packet_id=?", (pid,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _all_nonces_unique() -> bool:
    conn = get_connection()
    total = conn.execute("SELECT COUNT(*) FROM packets WHERE mode='simulation'").fetchone()[0]
    uniq = conn.execute("SELECT COUNT(DISTINCT nonce) FROM packets WHERE mode='simulation'").fetchone()[0]
    conn.close()
    return total == uniq


def _failures(checks: list[tuple[str, bool]]) -> list[str]:
    return [name for name, ok in checks if not ok]


class TestManager:
    def __init__(self, sim: SimulationEngine) -> None:
        self.sim = sim
        self.ensure_seeded()

    def ensure_seeded(self) -> None:
        with db_transaction() as conn:
            for tid, name, cfg, exp in TEST_DEFS:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO test_results (
                        test_id, mode, test_name, initial_config_json, status, passed, expected_result, actual_result, steps_json, packet_id, executed_at
                    ) VALUES (?, 'simulation', ?, ?, 'NOT_RUN', NULL, ?, NULL, '[]', NULL, NULL)
                    """,
                    (tid, name, json.dumps(cfg), exp),
                )

    def get_all(self) -> list[dict]:
        self.ensure_seeded()
        conn = get_connection()
        rows = conn.execute("SELECT * FROM test_results WHERE mode = 'simulation' ORDER BY test_id ASC").fetchall()
        conn.close()
        return [
            {
                "test_id": r["test_id"],
                "mode": r["mode"],
                "test_name": r["test_name"],
                "initial_config": json.loads(r["initial_config_json"]),
                "status": r["status"],
                "passed": None if r["passed"] is None else bool(r["passed"]),
                "expected_result": r["expected_result"],
                "actual_result": r["actual_result"],
                "steps": json.loads(r["steps_json"] or "[]"),
                "packet_id": r["packet_id"],
                "executed_at": r["executed_at"],
            }
            for r in rows
        ]

    def reset(self) -> list[dict]:
        with db_transaction() as conn:
            conn.execute("UPDATE test_results SET status='NOT_RUN', passed=NULL, actual_result=NULL, steps_json='[]', packet_id=NULL, executed_at=NULL WHERE mode='simulation'")
        return self.get_all()

    def _save(self, tid: int, passed: bool, actual: str, steps: list[dict], pkt_id: int | None) -> dict:
        with db_transaction() as conn:
            conn.execute(
                "UPDATE test_results SET status=?, passed=?, actual_result=?, steps_json=?, packet_id=?, executed_at=? WHERE test_id=? AND mode='simulation'",
                ("PASS" if passed else "FAIL", 1 if passed else 0, actual, json.dumps(steps), pkt_id, now_iso(), tid),
            )
        return next(t for t in self.get_all() if t["test_id"] == tid)

    def run_test(self, tid: int) -> dict:
        if tid == 1:
            self.sim.configure_links(True, True, True)
            self.sim.drain_node1()
            self.sim.drain_node2()
            self.sim.sync_node_and_storage_summaries()
            sd_before = _get_storage("NODE_2")["stored_count"]
            res = self.sim.create_and_process_packet(27.6, 62.0, 210)
            pkt = _get_packet(res["packet_id"])
            h1, h2 = _get_acks(res["packet_id"], "NODE1_NODE2"), _get_acks(res["packet_id"], "NODE2_NODE3")
            reads = _get_readings(res["packet_id"])
            n1, n3, sd_after = _get_node("NODE_1"), _get_node("NODE_3"), _get_storage("NODE_2")
            fails = _failures([
                ("node1_WIFI", n1["link_mode"] == "WIFI"),
                ("pkt_WIFI", bool(pkt and pkt["comm_mode"] == "WIFI")),
                ("pkt_STORED_DELIVERED", bool(pkt and pkt["gateway_status"] == "STORED" and pkt["destination_status"] == "DELIVERED" and pkt["encryption_status"] == "AUTHENTICATED")),
                ("hop_acks_marked", bool(pkt and pkt["node1_acked"] == 1 and pkt["node2_acked"] == 1)),
                ("no_preview", bool(pkt and pkt["payload_preview_json"] is None)),
                ("unique_nonces", _all_nonces_unique()),
                ("hop1_ACK", any(a["status"] == "ACK_STORED" for a in h1)),
                ("hop2_ACK", any(a["status"] == "ACK_DELIVERED" for a in h2)),
                ("sd_inc", sd_after["stored_count"] == sd_before + 1),
                ("reading_ok", len(reads) == 1 and reads[0]["authenticated"] == 1),
                ("lcd_updated", n3["metadata"].get("last_authenticated_packet") == res["packet_id"]),
            ])
            ok = not fails
            return self._save(1, ok, f"PASS: Packet #{res['packet_id']} delivered over WIFI (node1_acked=1, node2_acked=1)." if ok else f"FAIL: {fails}", [{"step": 1, "label": "Wi-Fi E2E Verification", "status": "PASS" if ok else "WARN", "detail": "All checks passed" if ok else str(fails)}], res["packet_id"])

        if tid == 2:
            self.sim.configure_links(True, True, True)
            self.sim.drain_node1()
            self.sim.drain_node2()
            self.sim.configure_links(False, True, True)
            sd_before = _get_storage("NODE_2")["stored_count"]
            res = self.sim.create_and_process_packet(28.1, 65.5, 420)
            pkt = _get_packet(res["packet_id"])
            h1, h2 = _get_acks(res["packet_id"], "NODE1_NODE2"), _get_acks(res["packet_id"], "NODE2_NODE3")
            reads = _get_readings(res["packet_id"])
            n1, sd_after = _get_node("NODE_1"), _get_storage("NODE_2")
            fails = _failures([
                ("node1_LORA", n1["link_mode"] == "LORA"),
                ("pkt_LORA", bool(pkt and pkt["comm_mode"] == "LORA")),
                ("pkt_DELIVERED", bool(pkt and pkt["gateway_status"] == "STORED" and pkt["destination_status"] == "DELIVERED" and pkt["node1_acked"] == 1 and pkt["node2_acked"] == 1)),
                ("hop1_ACK", any(a["status"] == "ACK_STORED" for a in h1)),
                ("hop2_ACK", any(a["status"] == "ACK_DELIVERED" for a in h2)),
                ("sd_inc", sd_after["stored_count"] == sd_before + 1),
                ("reading_ok", len(reads) == 1 and reads[0]["authenticated"] == 1),
            ])
            ok = not fails
            return self._save(2, ok, f"PASS: Packet #{res['packet_id']} delivered via LORA." if ok else f"FAIL: {fails}", [{"step": 1, "label": "LoRa Fallback Verification", "status": "PASS" if ok else "WARN", "detail": "All checks passed" if ok else str(fails)}], res["packet_id"])

        if tid == 3:
            self.sim.configure_links(True, True, True)
            self.sim.drain_node1()
            self.sim.drain_node2()
            self.sim.configure_links(False, False, True)
            res = self.sim.create_and_process_packet(26.4, 78.0, 810, force_heavy_rain=True)
            pkt_off = _get_packet(res["packet_id"])
            lfs_off = _get_storage("NODE_1")
            acks_off = _get_acks(res["packet_id"])
            reads_off = _get_readings(res["packet_id"])
            exp_file = f"/pending/packet_{res['packet_id']:06d}.bin"

            self.sim.configure_links(True, True, True)
            self.sim.drain_node1()
            self.sim.drain_node2()
            self.sim.sync_node_and_storage_summaries()
            pkt_rec = _get_packet(res["packet_id"])
            lfs_rec = _get_storage("NODE_1")
            h1, h2 = _get_acks(res["packet_id"], "NODE1_NODE2"), _get_acks(res["packet_id"], "NODE2_NODE3")
            reads_rec = _get_readings(res["packet_id"])
            fails = _failures([
                ("offline_pending", bool(pkt_off and pkt_off["gateway_status"] == "PENDING" and pkt_off["comm_mode"] == "OFFLINE" and pkt_off["node1_acked"] == 0 and pkt_off["node2_acked"] == 0)),
                ("lfs_file_saved", lfs_off["pending_count"] >= 1 and exp_file in lfs_off["files"]),
                ("zero_acks_offline", len(acks_off) == 0 and len(reads_off) == 0),
                ("identical_ciphertext_retransmitted", bool(pkt_off and pkt_rec and pkt_off["nonce"] == pkt_rec["nonce"] and pkt_off["ciphertext"] == pkt_rec["ciphertext"] and pkt_off["auth_tag"] == pkt_rec["auth_tag"])),
                ("lfs_retired", lfs_rec["pending_count"] == 0 and exp_file not in lfs_rec["files"]),
                ("delivered_after", bool(pkt_rec and pkt_rec["overall_status"] == "DELIVERED" and pkt_rec["node1_acked"] == 1 and pkt_rec["node2_acked"] == 1)),
                ("acks_after", any(a["status"] == "ACK_STORED" for a in h1) and any(a["status"] == "ACK_DELIVERED" for a in h2)),
                ("reading_after", len(reads_rec) == 1),
            ])
            ok = not fails
            return self._save(3, ok, f"PASS: Packet #{res['packet_id']} buffered in LittleFS then delivered with identical ciphertext." if ok else f"FAIL: {fails}", [{"step": 1, "label": "LittleFS Store & Recovery", "status": "PASS" if ok else "WARN", "detail": "All checks passed" if ok else str(fails)}], res["packet_id"])

        if tid == 4:
            self.sim.configure_links(True, True, True)
            self.sim.drain_node1()
            self.sim.drain_node2()
            self.sim.configure_links(True, True, False)
            sd_before = _get_storage("NODE_2")
            res = self.sim.create_and_process_packet(29.0, 59.0, 230)
            pkt_mid = _get_packet(res["packet_id"])
            sd_mid = _get_storage("NODE_2")
            h1_mid, h2_mid = _get_acks(res["packet_id"], "NODE1_NODE2"), _get_acks(res["packet_id"], "NODE2_NODE3")
            reads_mid = _get_readings(res["packet_id"])

            self.sim.configure_links(True, True, True)
            self.sim.drain_node2()
            self.sim.sync_node_and_storage_summaries()
            pkt_fin = _get_packet(res["packet_id"])
            sd_fin = _get_storage("NODE_2")
            h2_fin = _get_acks(res["packet_id"], "NODE2_NODE3")
            reads_fin = _get_readings(res["packet_id"])
            fails = _failures([
                ("sd_pending_grew", sd_mid["pending_count"] == sd_before["pending_count"] + 1),
                ("hop1_sent_hop2_none", any(a["status"] == "ACK_STORED" for a in h1_mid) and len(h2_mid) == 0 and len(reads_mid) == 0),
                ("mid_buffered", bool(pkt_mid and pkt_mid["gateway_status"] == "STORED" and pkt_mid["node1_acked"] == 1 and pkt_mid["node2_acked"] == 0 and pkt_mid["destination_status"] in ("PENDING", "RETRYING"))),
                ("sd_drained", sd_fin["pending_count"] == 0),
                ("final_delivered", bool(pkt_fin and pkt_fin["overall_status"] == "DELIVERED" and pkt_fin["node2_acked"] == 1)),
                ("hop2_ack_and_reading", any(a["status"] == "ACK_DELIVERED" for a in h2_fin) and len(reads_fin) == 1),
            ])
            ok = not fails
            return self._save(4, ok, f"PASS: Packet #{res['packet_id']} buffered on Node 2 microSD (node2_acked=0) then DELIVERED after Node 3 ACK." if ok else f"FAIL: {fails}", [{"step": 1, "label": "microSD Pending Queue & Recovery", "status": "PASS" if ok else "WARN", "detail": "All checks passed" if ok else str(fails)}], res["packet_id"])

        if tid == 5:
            self.sim.configure_links(True, True, True)
            self.sim.drain_node1()
            self.sim.drain_node2()
            self.sim.configure_links(True, True, False)
            gw_res = self.sim.create_and_process_packet(27.1, 60.2, 260)
            self.sim.configure_links(False, False, False)
            n1_res = self.sim.create_and_process_packet(27.3, 61.8, 310)
            lfs, sd = _get_storage("NODE_1"), _get_storage("NODE_2")
            p_n1, p_gw = _get_packet(n1_res["packet_id"]), _get_packet(gw_res["packet_id"])
            fails = _failures([
                ("lfs_retained", lfs["pending_count"] >= 1 and bool(p_n1 and p_n1["gateway_status"] == "PENDING" and p_n1["node1_acked"] == 0 and p_n1["overall_status"] != "DELIVERED")),
                ("sd_retained", sd["pending_count"] >= 1 and bool(p_gw and p_gw["gateway_status"] == "STORED" and p_gw["node2_acked"] == 0 and p_gw["overall_status"] != "DELIVERED")),
                ("zero_false_deliveries", len(_get_acks(n1_res["packet_id"])) == 0 and len(_get_acks(gw_res["packet_id"], "NODE2_NODE3")) == 0 and len(_get_readings(n1_res["packet_id"])) == 0 and len(_get_readings(gw_res["packet_id"])) == 0),
            ])
            ok = not fails
            return self._save(5, ok, f"PASS: Both Node 1 (#{n1_res['packet_id']}) and Node 2 (#{gw_res['packet_id']}) retained queues with 0 false deliveries." if ok else f"FAIL: {fails}", [{"step": 1, "label": "Full Outage Retention", "status": "PASS" if ok else "WARN", "detail": "All checks passed" if ok else str(fails)}], n1_res["packet_id"])

        if tid == 6:
            self.sim.configure_links(True, True, True)
            self.sim.drain_node1()
            self.sim.drain_node2()
            self.sim.sync_node_and_storage_summaries()
            sd_before = _get_storage("NODE_2")["stored_count"]
            res = self.sim.create_and_process_packet(28.4, 58.9, 190, force_drop_ack=True)
            pkt = _get_packet(res["packet_id"])
            h1, h2 = _get_acks(res["packet_id"], "NODE1_NODE2"), _get_acks(res["packet_id"], "NODE2_NODE3")
            sd_after = _get_storage("NODE_2")
            fails = _failures([
                ("ack_lost_and_resent", any(a["status"] == "LOST" for a in h1) and any(a["status"] == "ACK_DUPLICATE_RESENT" for a in h1)),
                ("dup_suppressed", bool(pkt and pkt["is_duplicate"] == 1 and pkt["gateway_status"] == "DUPLICATE_SUPPRESSED" and pkt["retry_count"] >= 1)),
                ("hop_acks_completed", bool(pkt and pkt["node1_acked"] == 1 and pkt["node2_acked"] == 1)),
                ("sd_single_store", sd_after["stored_count"] == sd_before + 1),
                ("delivered_e2e", bool(pkt and pkt["overall_status"] == "DELIVERED") and any(a["status"] == "ACK_DELIVERED" for a in h2)),
            ])
            ok = not fails
            return self._save(6, ok, f"PASS: Packet #{res['packet_id']} deduplicated and resent ACK." if ok else f"FAIL: {fails}", [{"step": 1, "label": "ACK Loss & Deduplication", "status": "PASS" if ok else "WARN", "detail": "All checks passed" if ok else str(fails)}], res["packet_id"])

        if tid == 7:
            self.sim.configure_links(True, True, True)
            self.sim.drain_node1()
            self.sim.drain_node2()
            self.sim.sync_node_and_storage_summaries()
            lcd_before = _get_node("NODE_3")["metadata"].get("lcd_line1")
            res_ct = self.sim.create_and_process_packet(43.2, 91.0, 910, force_tamper=True, tamper_target="ciphertext")
            res_tag = self.sim.create_and_process_packet(44.8, 92.5, 930, force_tamper=True, tamper_target="tag")
            p_ct, p_tag = _get_packet(res_ct["packet_id"]), _get_packet(res_tag["packet_id"])
            lcd_after = _get_node("NODE_3")["metadata"].get("lcd_line1")
            fails = _failures([
                ("ct_rejected", bool(p_ct and p_ct["tampered"] == 1 and p_ct["overall_status"] == "REJECTED" and p_ct["encryption_status"] == "AUTH_FAILED" and p_ct["node2_acked"] == 0)),
                ("tag_rejected", bool(p_tag and p_tag["tampered"] == 1 and p_tag["overall_status"] == "REJECTED" and p_tag["encryption_status"] == "AUTH_FAILED" and p_tag["node2_acked"] == 0)),
                ("zero_readings", len(_get_readings(res_ct["packet_id"])) == 0 and len(_get_readings(res_tag["packet_id"])) == 0),
                ("no_success_ack", not any(a["status"] == "ACK_DELIVERED" for a in _get_acks(res_ct["packet_id"], "NODE2_NODE3")) and not any(a["status"] == "ACK_DELIVERED" for a in _get_acks(res_tag["packet_id"], "NODE2_NODE3"))),
                ("lcd_unchanged", lcd_after == lcd_before),
            ])
            ok = not fails
            return self._save(7, ok, f"PASS: Ciphertext (#{res_ct['packet_id']}) & Tag (#{res_tag['packet_id']}) tampering rejected; node2_acked=0; LCD unchanged." if ok else f"FAIL: {fails}", [{"step": 1, "label": "AES-GCM Tamper Rejection", "status": "PASS" if ok else "WARN", "detail": "All checks passed" if ok else str(fails)}], res_ct["packet_id"])

        if tid == 8:
            self.sim.configure_links(True, True, True)
            self.sim.drain_node1()
            self.sim.drain_node2()
            self.sim.configure_links(True, True, False)
            gw_res = self.sim.create_and_process_packet(26.8, 67.2, 460)
            self.sim.configure_links(False, False, False)
            n1_res = self.sim.create_and_process_packet(26.6, 68.4, 495)
            seq_before = self.sim.get_state()["sequence_counter"]
            restart = self.sim.simulate_nodes_restart()

            self.sim.configure_links(True, True, True)
            self.sim.drain_node1()
            self.sim.drain_node2()
            self.sim.sync_node_and_storage_summaries()
            post_res = self.sim.create_and_process_packet(27.0, 64.0, 240)
            p_n1, p_gw, p_post = _get_packet(n1_res["packet_id"]), _get_packet(gw_res["packet_id"]), _get_packet(post_res["packet_id"])
            fails = _failures([
                ("recovered_both_queues", n1_res["packet_id"] in restart["recovered_node1_pending"] and gw_res["packet_id"] in restart["recovered_node2_pending"]),
                ("seq_preserved", restart["sequence_counter"] == seq_before),
                ("both_delivered", bool(p_n1 and p_n1["overall_status"] == "DELIVERED" and p_n1["node1_acked"] == 1 and p_n1["node2_acked"] == 1 and p_gw and p_gw["overall_status"] == "DELIVERED" and p_gw["node2_acked"] == 1)),
                ("no_seq_reuse", bool(p_post and p_post["sequence_number"] > seq_before)),
                ("unique_nonces", _all_nonces_unique()),
            ])
            ok = not fails
            return self._save(8, ok, f"PASS: Node 1 (#{n1_res['packet_id']}) & Node 2 (#{gw_res['packet_id']}) queues survived restart and delivered." if ok else f"FAIL: {fails}", [{"step": 1, "label": "Restart Queue Recovery", "status": "PASS" if ok else "WARN", "detail": "All checks passed" if ok else str(fails)}], n1_res["packet_id"])

        raise ValueError(f"Unknown test_id {tid}")

    def run_all(self) -> list[dict]:
        for tid in range(1, 9):
            self.run_test(tid)
        return self.get_all()
