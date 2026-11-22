"""Express <-> Python Random Forest Integration Bridge (HTTP API only).

Communicates strictly with the active Node.js + Express backend (default http://127.0.0.1:3000)
via Phase 4 REST endpoints:
  - GET  /api/ml/features?mode=simulation&limit=60
  - POST /api/ml/network/status
  - POST /api/ml/network/evaluation
  - POST /api/ml/network/classification
  - POST /api/ml/network/scheduling

Never writes to SQLite directly and never bypasses Express validation.
Pushes strictly SIMULATED evaluations/predictions unless retrained on real ESP32 hardware.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from inference_service import NetworkMLInferenceService  # noqa: E402
from schema import TARGET_LINK  # noqa: E402


class ExpressMLBridge:
    def __init__(
        self,
        express_url: str = "http://127.0.0.1:3000",
        inference_service: NetworkMLInferenceService | None = None,
        service_url: str | None = None,
        timeout: float = 8.0,
    ) -> None:
        self.express_url = express_url.rstrip("/")
        self.service_url = service_url.rstrip("/") if service_url else None
        self.svc = inference_service or NetworkMLInferenceService()
        self.timeout = timeout

    def _get(self, path: str) -> tuple[int, dict[str, Any]]:
        resp = requests.get(f"{self.express_url}{path}", timeout=self.timeout)
        return resp.status_code, resp.json()

    def _post(self, path: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        resp = requests.post(
            f"{self.express_url}{path}",
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=self.timeout,
        )
        return resp.status_code, resp.json()

    def _infer_classification(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self.service_url:
            resp = requests.post(
                f"{self.service_url}/predict/classification",
                json=payload,
                timeout=self.timeout,
            )
            resp.raise_for_status()
            return resp.json()
        return self.svc.predict_classification(payload)

    def _infer_scheduling(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self.service_url:
            resp = requests.post(
                f"{self.service_url}/predict/scheduling",
                json=payload,
                timeout=self.timeout,
            )
            resp.raise_for_status()
            return resp.json()
        return self.svc.predict_scheduling(payload)

    def push_heartbeats(self) -> list[dict[str, Any]]:
        results = []
        for model_type, bundle in [
            ("NETWORK_QUALITY", self.svc.clf_bundle),
            ("TRANSMISSION_SCHEDULING", self.svc.sch_bundle),
        ]:
            status, body = self._post(
                "/api/ml/network/status",
                {
                    "link_hop": TARGET_LINK,
                    "model_type": model_type,
                    "status": "AVAILABLE" if bundle.loaded else "OFFLINE",
                    "model_version": bundle.model_version,
                    "service_name": "python-rf-ml-service",
                    "note": (
                        f"Trained on {bundle.trained_data_source} data; "
                        "advisory only, core network deterministic."
                    ),
                },
            )
            if status >= 400:
                raise RuntimeError(f"Failed heartbeat for {model_type}: {status} {body}")
            results.append(body)
        return results

    def push_evaluations(self) -> list[dict[str, Any]]:
        """Upload SIMULATED training evaluations to Express (never claims ESP32_HARDWARE)."""
        uploaded = []
        for bundle in (self.svc.clf_bundle, self.svc.sch_bundle):
            if not bundle.loaded:
                continue
            eval_payload = dict(bundle.metadata.get("evaluation") or {})
            if not eval_payload:
                continue
            if str(eval_payload.get("data_source", "")).upper() != "SIMULATED":
                raise RuntimeError("Refusing to push non-SIMULATED evaluation from synthetic artifacts.")
            eval_payload["mode"] = "simulation"
            status, body = self._post("/api/ml/network/evaluation", eval_payload)
            if status >= 400:
                raise RuntimeError(f"Failed evaluation upload: {status} {body}")
            uploaded.append(body)
        return uploaded

    def sync_once(
        self,
        mode: str = "simulation",
        include_evaluations: bool = True,
        data_source: str | None = None,
    ) -> dict[str, Any]:
        resolved_source = (data_source or ("CSV_IMPORT" if mode == "csv_import" else "SIMULATED")).strip().upper()
        if resolved_source not in ("SIMULATED", "CSV_IMPORT"):
            raise ValueError(
                "Only data_source='SIMULATED' or 'CSV_IMPORT' is permitted until physical ESP32 hardware models are trained."
            )
        resolved_mode = "simulation" if resolved_source == "SIMULATED" else "hardware"

        self.push_heartbeats()
        evals = (
            self.push_evaluations()
            if (include_evaluations and resolved_source == "SIMULATED")
            else []
        )

        status_code, feat_data = self._get(
            f"/api/ml/features?mode={resolved_mode}&data_source={resolved_source}&limit=60"
        )
        if status_code >= 400:
            raise RuntimeError(f"GET /api/ml/features failed: {status_code} {feat_data}")

        latest_metric = feat_data.get("latest_metric") or {}
        metric_id = latest_metric.get("id")
        recorded_at = latest_metric.get("recorded_at")
        sample_count = int(feat_data.get("sample_count") or 0)
        sched_ctx = feat_data.get("scheduling_context") or {}

        clf_req = {
            "link_hop": TARGET_LINK,
            "data_source": resolved_source,
            "sample_count": sample_count,
            "feature_timestamp": recorded_at,
            "offline_batch": resolved_source == "CSV_IMPORT",
            "features": feat_data.get("classification_features"),
        }
        clf_pred = self._infer_classification(clf_req)

        clf_post_body: dict[str, Any] = {
            "link_hop": TARGET_LINK,
            "mode": resolved_mode,
            "data_source": resolved_source,
            "prediction_status": clf_pred["prediction_status"],
            "model_version": clf_pred["model_version"],
            "prediction_timestamp": clf_pred["prediction_timestamp"],
            "metric_id": metric_id,
            "features": clf_pred.get("features") or feat_data.get("classification_features") or {},
        }
        if clf_pred["prediction_status"] == "READY":
            clf_post_body["predicted_class"] = clf_pred["predicted_class"]
            clf_post_body["probabilities"] = clf_pred["probabilities"]

        clf_status, clf_saved = self._post("/api/ml/network/classification", clf_post_body)
        if clf_status >= 400:
            raise RuntimeError(f"POST /api/ml/network/classification failed: {clf_status} {clf_saved}")

        sch_req = {
            "link_hop": TARGET_LINK,
            "data_source": resolved_source,
            "sample_count": sample_count,
            "feature_timestamp": recorded_at,
            "offline_batch": resolved_source == "CSV_IMPORT",
            "current_link_state": sched_ctx.get("current_link_state"),
            "features": feat_data.get("scheduling_features"),
        }
        sch_pred = self._infer_scheduling(sch_req)

        sch_post_body: dict[str, Any] = {
            "link_hop": TARGET_LINK,
            "mode": resolved_mode,
            "data_source": resolved_source,
            "prediction_status": sch_pred["prediction_status"],
            "observation_censored": bool(sch_pred.get("observation_censored", False)),
            "model_version": sch_pred["model_version"],
            "prediction_timestamp": sch_pred["prediction_timestamp"],
            "recommended_action": sch_pred.get("recommended_action"),
            "metric_id": metric_id,
            "features": sch_pred.get("features") or feat_data.get("scheduling_features") or {},
        }
        if sch_pred["prediction_status"] == "READY":
            sch_post_body["predicted_wait_seconds"] = sch_pred["predicted_wait_seconds"]

        sch_status, sch_saved = self._post("/api/ml/network/scheduling", sch_post_body)
        if sch_status >= 400:
            raise RuntimeError(f"POST /api/ml/network/scheduling failed: {sch_status} {sch_saved}")

        return {
            "mode": resolved_mode,
            "data_source": resolved_source,
            "metric_id": metric_id,
            "evaluations_uploaded": len(evals),
            "classification": clf_saved.get("prediction"),
            "scheduling": sch_saved.get("prediction"),
        }

    def verify_integration(self) -> dict[str, Any]:
        """Run non-destructive contract & end-to-end ML bridge verification against Express."""
        checks: list[dict[str, Any]] = []

        # 1. Verify inference service loaded both artifacts
        health = self.svc.health()
        assert health["status"] == "OK", f"ML artifacts not loaded: {health}"
        checks.append({"name": "Artifacts loaded (RF classifier + RF regressor)", "passed": True})

        # 2. Verify unsupported link scopes are rejected locally & by Express
        for bad_hop in ("NODE1_NODE3_WIFI", "NODE1_NODE2_LORA"):
            rejected_locally = False
            try:
                self.svc.predict_classification({"link_hop": bad_hop, "data_source": "SIMULATED", "features": {}})
            except Exception:
                rejected_locally = True
            assert rejected_locally, f"Local inference failed to reject {bad_hop}"

            code, body = self._post(
                "/api/ml/network/classification",
                {
                    "link_hop": bad_hop,
                    "data_source": "SIMULATED",
                    "prediction_status": "UNAVAILABLE",
                    "model_version": self.svc.clf_bundle.model_version,
                    "prediction_timestamp": datetime.now(timezone.utc).isoformat(),
                },
            )
            assert code == 400 and body.get("code") == "ML_LINK_SCOPE_VIOLATION", f"Express failed to reject {bad_hop}: {code} {body}"
        checks.append({"name": "Strict NODE2_NODE3_WIFI link isolation (rejects NODE1_NODE3_WIFI & NODE1_NODE2_LORA)", "passed": True})

        # 3. Verify honest unavailability / stale / insufficient / censored handling without invented predictions
        unavail_svc = NetworkMLInferenceService(artifacts_root=_THIS_DIR / "nonexistent_artifacts_dir")
        u_clf = unavail_svc.predict_classification({"link_hop": TARGET_LINK, "data_source": "SIMULATED", "features": {}})
        u_sch = unavail_svc.predict_scheduling({"link_hop": TARGET_LINK, "data_source": "SIMULATED", "features": {}})
        assert u_clf["prediction_status"] == "UNAVAILABLE" and u_clf["predicted_class"] is None
        assert u_sch["prediction_status"] == "UNAVAILABLE" and u_sch["predicted_wait_seconds"] is None

        stale_ts = (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat()
        s_clf = self.svc.predict_classification(
            {
                "link_hop": TARGET_LINK,
                "data_source": "SIMULATED",
                "sample_count": 10,
                "feature_timestamp": stale_ts,
                "features": {"rssi": -65, "rssi_variation": 1.2, "packet_loss_ratio": 0.02, "ack_latency_ms": 60, "retry_count": 0, "queue_depth": 1},
            }
        )
        assert s_clf["prediction_status"] == "STALE" and s_clf["predicted_class"] is None

        insuff_sch = self.svc.predict_scheduling(
            {
                "link_hop": TARGET_LINK,
                "data_source": "SIMULATED",
                "sample_count": 2,
                "features": {},
            }
        )
        assert insuff_sch["prediction_status"] == "INSUFFICIENT_DATA" and insuff_sch["predicted_wait_seconds"] is None

        censored_sch = self.svc.predict_scheduling(
            {
                "link_hop": TARGET_LINK,
                "data_source": "SIMULATED",
                "sample_count": 12,
                "current_link_state": "DISCONNECTED",
                "features": {
                    "rssi": -102,
                    "rssi_variation": 4.0,
                    "packet_loss_ratio": 0.95,
                    "ack_latency_ms": 1400,
                    "retry_count": 4,
                    "queue_depth": 14,
                    "wifi_availability_history": 0.1,
                    "connection_duration": 210.0,
                    "hour": 12,
                    "day_of_week": 2,
                },
            }
        )
        assert censored_sch["prediction_status"] == "CENSORED"
        assert censored_sch["observation_censored"] is True
        assert censored_sch["predicted_wait_seconds"] is None

        # Reject ESP32_HARDWARE request when only SIMULATED artifact exists
        hw_guard = self.svc.predict_classification(
            {
                "link_hop": TARGET_LINK,
                "data_source": "ESP32_HARDWARE",
                "sample_count": 5,
                "features": {"rssi": -65, "rssi_variation": 1.2, "packet_loss_ratio": 0.02, "ack_latency_ms": 60, "retry_count": 0, "queue_depth": 1},
            }
        )
        assert hw_guard["prediction_status"] == "UNAVAILABLE" and hw_guard["predicted_class"] is None
        checks.append({"name": "Honest UNAVAILABLE / STALE / INSUFFICIENT_DATA / CENSORED / Hardware provenance guards", "passed": True})

        # 4. Sync live SIMULATED features -> trained RF models -> Express API -> verify state isolation
        sync_res = self.sync_once(mode="simulation", include_evaluations=True)
        sim_code, sim_dash = self._get("/api/ml/network?mode=simulation&limit=60")
        hw_code, hw_dash = self._get("/api/ml/network?mode=hardware&limit=60")
        assert sim_code == 200 and hw_code == 200
        assert sim_dash["data_source"] == "SIMULATED"
        assert sim_dash["classification"]["evaluation"]["accuracy"] > 0
        assert sim_dash["scheduling"]["evaluation"]["mae"] >= 0
        assert sim_dash["classification"]["latest_prediction"]["data_source"] == "SIMULATED"
        assert sim_dash["scheduling"]["latest_prediction"]["data_source"] == "SIMULATED"
        assert hw_dash["data_source"] == "ESP32_HARDWARE"
        assert hw_dash["classification"]["evaluation"] is None, "SIMULATED evaluation leaked into ESP32_HARDWARE!"
        assert hw_dash["scheduling"]["evaluation"] is None, "SIMULATED evaluation leaked into ESP32_HARDWARE!"
        checks.append({"name": "Live SIMULATED sync & strict isolation from ESP32_HARDWARE", "passed": True})

        return {
            "all_passed": True,
            "checks": checks,
            "sync_result": sync_res,
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Express <-> Python ML Integration Bridge")
    parser.add_argument("--express-url", default="http://127.0.0.1:3000")
    parser.add_argument("--service-url", default=None, help="Optional running inference_service.py HTTP URL")
    parser.add_argument("--sync-once", action="store_true", help="Push heartbeats, evaluations, and one inference cycle")
    parser.add_argument("--verify", action="store_true", help="Run integration verification checks against Express")
    parser.add_argument("--poll", action="store_true", help="Run continuous polling sync loop for simulation mode")
    parser.add_argument("--interval", type=float, default=10.0, help="Polling interval in seconds")
    args = parser.parse_args()

    bridge = ExpressMLBridge(express_url=args.express_url, service_url=args.service_url)

    if args.verify:
        out = bridge.verify_integration()
        print(json.dumps(out, indent=2))
    elif args.sync_once:
        out = bridge.sync_once(mode="simulation", include_evaluations=True)
        print(json.dumps(out, indent=2))
    elif args.poll:
        bridge.push_heartbeats()
        bridge.push_evaluations()
        while True:
            try:
                res = bridge.sync_once(mode="simulation", include_evaluations=False)
                print(json.dumps(res), flush=True)
            except Exception as exc:
                print(json.dumps({"error": str(exc)}), file=sys.stderr, flush=True)
            time.sleep(max(2.0, args.interval))
    else:
        parser.print_help()
