"""Phase 5 Python ML Inference Service for NODE2_NODE3_WIFI Random Forest models.

Serves:
  1. Model A — Network Quality Classification (GOOD / MODERATE / POOR)
  2. Model B — Predictive Transmission Scheduling (advisory wait time in seconds)

Can be imported directly in Python OR executed as a local HTTP microservice
bound to 127.0.0.1:5055 (`GET /health`, `POST /predict/classification`, `POST /predict/scheduling`).

Honest state handling:
  - Rejects any link_hop other than 'NODE2_NODE3_WIFI'.
  - Never invents predictions when artifacts are missing, features are missing/stale,
    history is insufficient, or scheduling observations are right-censored.
  - Never serves SIMULATED-trained artifacts under ESP32_HARDWARE provenance.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import pandas as pd
from flask import Flask, jsonify, request

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from schema import (  # noqa: E402
    CLASSIFICATION_CLASSES,
    CLASSIFICATION_FEATURES,
    MLSchemaError,
    SCHEDULING_FEATURES,
    SUITABLE_OPPORTUNITY_SPEC,
    TARGET_LINK,
    validate_data_source,
    validate_feature_dict,
    validate_link_hop,
)

DEFAULT_STALE_SECONDS = 60.0
DEFAULT_MIN_SCHEDULING_SAMPLES = 5


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_age_seconds(timestamp_iso: str | None) -> float | None:
    if not timestamp_iso or not isinstance(timestamp_iso, str):
        return None
    raw = timestamp_iso.strip()
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return max(0.0, (datetime.now(timezone.utc) - dt).total_seconds())


class LoadedModelBundle:
    def __init__(self, name: str, artifact_dir: Path) -> None:
        self.name = name
        self.artifact_dir = artifact_dir
        self.pipeline: Any = None
        self.metadata: dict[str, Any] = {}
        self.loaded = False
        self.load_error: str | None = None
        self.reload()

    def reload(self) -> None:
        pipeline_path = self.artifact_dir / "model_pipeline.joblib"
        meta_path = self.artifact_dir / "model_metadata.json"
        if not pipeline_path.exists() or not meta_path.exists():
            self.pipeline = None
            self.metadata = {}
            self.loaded = False
            self.load_error = f"Artifact missing in {self.artifact_dir}"
            return
        try:
            self.pipeline = joblib.load(pipeline_path)
            self.metadata = json.loads(meta_path.read_text(encoding="utf-8"))
            self.loaded = True
            self.load_error = None
        except Exception as exc:  # pragma: no cover - defensive load guard
            self.pipeline = None
            self.metadata = {}
            self.loaded = False
            self.load_error = f"Failed to load {self.name}: {exc}"

    @property
    def model_version(self) -> str:
        return str(self.metadata.get("model_version") or "unloaded")

    @property
    def trained_data_source(self) -> str:
        return str(self.metadata.get("data_source") or "SIMULATED").upper()


class NetworkMLInferenceService:
    """In-process and HTTP-ready inference wrapper for both Phase 5 Random Forest models."""

    def __init__(
        self,
        artifacts_root: Path | None = None,
        stale_seconds: float = DEFAULT_STALE_SECONDS,
        min_scheduling_samples: int = DEFAULT_MIN_SCHEDULING_SAMPLES,
    ) -> None:
        root = artifacts_root or (_THIS_DIR / "artifacts")
        self.stale_seconds = float(stale_seconds)
        self.min_scheduling_samples = int(min_scheduling_samples)
        self.clf_bundle = LoadedModelBundle("network_quality", root / "network_quality")
        self.sch_bundle = LoadedModelBundle("transmission_scheduling", root / "transmission_scheduling")

    def health(self) -> dict[str, Any]:
        return {
            "status": "OK" if (self.clf_bundle.loaded and self.sch_bundle.loaded) else "DEGRADED",
            "target_link": TARGET_LINK,
            "service_name": "python-rf-inference-service",
            "timestamp": _now_iso(),
            "models": {
                "network_quality": {
                    "loaded": self.clf_bundle.loaded,
                    "model_version": self.clf_bundle.model_version,
                    "trained_data_source": self.clf_bundle.trained_data_source,
                    "hardware_validated": self.clf_bundle.trained_data_source == "ESP32_HARDWARE",
                    "error": self.clf_bundle.load_error,
                },
                "transmission_scheduling": {
                    "loaded": self.sch_bundle.loaded,
                    "model_version": self.sch_bundle.model_version,
                    "trained_data_source": self.sch_bundle.trained_data_source,
                    "hardware_validated": self.sch_bundle.trained_data_source == "ESP32_HARDWARE",
                    "error": self.sch_bundle.load_error,
                },
            },
        }

    def predict_classification(self, payload: dict[str, Any]) -> dict[str, Any]:
        link_hop = validate_link_hop(payload.get("link_hop", TARGET_LINK))
        data_source = validate_data_source(payload.get("data_source", "SIMULATED"))
        now_iso = _now_iso()

        if not self.clf_bundle.loaded or self.clf_bundle.pipeline is None:
            return {
                "link_hop": link_hop,
                "model_type": "NETWORK_QUALITY",
                "data_source": data_source,
                "model_version": self.clf_bundle.model_version,
                "prediction_timestamp": now_iso,
                "prediction_status": "UNAVAILABLE",
                "predicted_class": None,
                "probabilities": None,
                "reason": self.clf_bundle.load_error or "Classifier artifact not loaded.",
            }

        if data_source == "ESP32_HARDWARE" and self.clf_bundle.trained_data_source != "ESP32_HARDWARE":
            return {
                "link_hop": link_hop,
                "model_type": "NETWORK_QUALITY",
                "data_source": data_source,
                "model_version": self.clf_bundle.model_version,
                "prediction_timestamp": now_iso,
                "prediction_status": "UNAVAILABLE",
                "predicted_class": None,
                "probabilities": None,
                "reason": (
                    "Loaded classifier was trained on SIMULATED data only; "
                    "cannot serve synthetic model predictions as ESP32_HARDWARE."
                ),
            }

        sample_count = payload.get("sample_count")
        if sample_count is not None and int(sample_count) < 1:
            return {
                "link_hop": link_hop,
                "model_type": "NETWORK_QUALITY",
                "data_source": data_source,
                "model_version": self.clf_bundle.model_version,
                "prediction_timestamp": now_iso,
                "prediction_status": "INSUFFICIENT_DATA",
                "predicted_class": None,
                "probabilities": None,
                "reason": "At least 1 NODE2_NODE3_WIFI metric observation is required.",
            }

        feature_ts = payload.get("feature_timestamp") or payload.get("recorded_at")
        age_sec = _parse_age_seconds(feature_ts)
        is_offline_batch = data_source == "CSV_IMPORT" or bool(payload.get("offline_batch", False))
        if not is_offline_batch and age_sec is not None and age_sec > self.stale_seconds:
            return {
                "link_hop": link_hop,
                "model_type": "NETWORK_QUALITY",
                "data_source": data_source,
                "model_version": self.clf_bundle.model_version,
                "prediction_timestamp": feature_ts,
                "prediction_status": "STALE",
                "predicted_class": None,
                "probabilities": None,
                "features": payload.get("features") if isinstance(payload.get("features"), dict) else {},
                "reason": f"Input metrics are {age_sec:.1f}s old (> {self.stale_seconds:.0f}s threshold).",
            }

        raw_features = payload.get("features")
        try:
            cleaned = validate_feature_dict(raw_features, CLASSIFICATION_FEATURES)
        except MLSchemaError as exc:
            # Missing feature values produce honest INSUFFICIENT_DATA; invalid negative/out-of-range raises
            if "Missing" in str(exc) or "must be a dictionary" in str(exc):
                return {
                    "link_hop": link_hop,
                    "model_type": "NETWORK_QUALITY",
                    "data_source": data_source,
                    "model_version": self.clf_bundle.model_version,
                    "prediction_timestamp": now_iso,
                    "prediction_status": "INSUFFICIENT_DATA",
                    "predicted_class": None,
                    "probabilities": None,
                    "reason": str(exc),
                }
            raise

        X = pd.DataFrame([[cleaned[col] for col in CLASSIFICATION_FEATURES]], columns=CLASSIFICATION_FEATURES)
        probs_arr = self.clf_bundle.pipeline.predict_proba(X)[0]
        pipeline_classes = [str(c) for c in self.clf_bundle.pipeline.classes_]
        raw_prob_map = {cls: float(prob) for cls, prob in zip(pipeline_classes, probs_arr)}

        probabilities = {
            cls: round(raw_prob_map.get(cls, 0.0), 4)
            for cls in CLASSIFICATION_CLASSES
        }
        # Normalize rounding drift slightly so sum is strictly ~1.0000
        prob_sum = sum(probabilities.values())
        if prob_sum > 0:
            top_cls_for_norm = max(probabilities, key=probabilities.get)  # type: ignore[arg-type]
            probabilities[top_cls_for_norm] = round(
                max(0.0, min(1.0, probabilities[top_cls_for_norm] + (1.0 - prob_sum))),
                4,
            )

        predicted_class = max(probabilities, key=probabilities.get)  # type: ignore[arg-type]

        return {
            "link_hop": link_hop,
            "model_type": "NETWORK_QUALITY",
            "data_source": data_source,
            "trained_data_source": self.clf_bundle.trained_data_source,
            "hardware_validated": self.clf_bundle.trained_data_source == "ESP32_HARDWARE",
            "model_version": self.clf_bundle.model_version,
            "prediction_timestamp": now_iso,
            "prediction_status": "READY",
            "predicted_class": predicted_class,
            "probabilities": probabilities,
            "features": cleaned,
        }

    def predict_scheduling(self, payload: dict[str, Any]) -> dict[str, Any]:
        link_hop = validate_link_hop(payload.get("link_hop", TARGET_LINK))
        data_source = validate_data_source(payload.get("data_source", "SIMULATED"))
        now_iso = _now_iso()

        if not self.sch_bundle.loaded or self.sch_bundle.pipeline is None:
            return {
                "link_hop": link_hop,
                "model_type": "TRANSMISSION_SCHEDULING",
                "data_source": data_source,
                "model_version": self.sch_bundle.model_version,
                "prediction_timestamp": now_iso,
                "prediction_status": "UNAVAILABLE",
                "predicted_wait_seconds": None,
                "observation_censored": False,
                "advisory_only": True,
                "recommended_action": "ML scheduler offline; fallback queue logic operates deterministically.",
                "reason": self.sch_bundle.load_error or "Scheduling regressor artifact not loaded.",
            }

        if data_source == "ESP32_HARDWARE" and self.sch_bundle.trained_data_source != "ESP32_HARDWARE":
            return {
                "link_hop": link_hop,
                "model_type": "TRANSMISSION_SCHEDULING",
                "data_source": data_source,
                "model_version": self.sch_bundle.model_version,
                "prediction_timestamp": now_iso,
                "prediction_status": "UNAVAILABLE",
                "predicted_wait_seconds": None,
                "observation_censored": False,
                "advisory_only": True,
                "recommended_action": "Hardware-trained scheduling artifact required before ESP32_HARDWARE inference.",
                "reason": (
                    "Loaded regressor was trained on SIMULATED data only; "
                    "cannot serve synthetic model predictions as ESP32_HARDWARE."
                ),
            }

        sample_count = payload.get("sample_count")
        if sample_count is not None and int(sample_count) < self.min_scheduling_samples:
            return {
                "link_hop": link_hop,
                "model_type": "TRANSMISSION_SCHEDULING",
                "data_source": data_source,
                "model_version": self.sch_bundle.model_version,
                "prediction_timestamp": now_iso,
                "prediction_status": "INSUFFICIENT_DATA",
                "predicted_wait_seconds": None,
                "observation_censored": False,
                "advisory_only": True,
                "recommended_action": (
                    f"Collect at least {self.min_scheduling_samples} NODE2_NODE3_WIFI samples "
                    "before scheduling inference."
                ),
                "reason": (
                    f"Requires >= {self.min_scheduling_samples} samples; received {int(sample_count)}."
                ),
            }

        feature_ts = payload.get("feature_timestamp") or payload.get("recorded_at")
        age_sec = _parse_age_seconds(feature_ts)
        is_offline_batch = data_source == "CSV_IMPORT" or bool(payload.get("offline_batch", False))
        if not is_offline_batch and age_sec is not None and age_sec > self.stale_seconds:
            return {
                "link_hop": link_hop,
                "model_type": "TRANSMISSION_SCHEDULING",
                "data_source": data_source,
                "model_version": self.sch_bundle.model_version,
                "prediction_timestamp": feature_ts,
                "prediction_status": "STALE",
                "predicted_wait_seconds": None,
                "observation_censored": False,
                "advisory_only": True,
                "features": payload.get("features") if isinstance(payload.get("features"), dict) else {},
                "recommended_action": "Telemetry stale; hold advisory forecast until fresh metrics arrive.",
                "reason": f"Input metrics are {age_sec:.1f}s old (> {self.stale_seconds:.0f}s threshold).",
            }

        horizon = float(SUITABLE_OPPORTUNITY_SPEC["censoring_horizon_seconds"])
        raw_features = payload.get("features")

        # Explicit censoring or horizon exhaustion check
        current_link_state = str(payload.get("current_link_state") or "").strip().upper()
        explicit_censored = bool(payload.get("observation_censored", False))
        conn_dur = None
        if isinstance(raw_features, dict) and raw_features.get("connection_duration") is not None:
            try:
                conn_dur = float(raw_features["connection_duration"])
            except (TypeError, ValueError):
                conn_dur = None

        if explicit_censored or (
            current_link_state == "DISCONNECTED" and conn_dur is not None and conn_dur >= horizon
        ):
            safe_features = raw_features if isinstance(raw_features, dict) else {}
            return {
                "link_hop": link_hop,
                "model_type": "TRANSMISSION_SCHEDULING",
                "data_source": data_source,
                "model_version": self.sch_bundle.model_version,
                "prediction_timestamp": now_iso,
                "prediction_status": "CENSORED",
                "predicted_wait_seconds": None,
                "observation_censored": True,
                "advisory_only": True,
                "features": safe_features,
                "recommended_action": (
                    f"Right-censored observation (>= {horizon:.0f}s horizon without reconnection); "
                    "keep non-urgent payloads queued in LittleFS/microSD."
                ),
                "reason": "Observation window exceeded censoring horizon without suitable opportunity.",
            }

        try:
            cleaned = validate_feature_dict(raw_features, SCHEDULING_FEATURES)
        except MLSchemaError as exc:
            if "Missing" in str(exc) or "must be a dictionary" in str(exc):
                return {
                    "link_hop": link_hop,
                    "model_type": "TRANSMISSION_SCHEDULING",
                    "data_source": data_source,
                    "model_version": self.sch_bundle.model_version,
                    "prediction_timestamp": now_iso,
                    "prediction_status": "INSUFFICIENT_DATA",
                    "predicted_wait_seconds": None,
                    "observation_censored": False,
                    "advisory_only": True,
                    "recommended_action": "Awaiting complete 10-feature NODE2_NODE3_WIFI history.",
                    "reason": str(exc),
                }
            raise

        X = pd.DataFrame([[cleaned[col] for col in SCHEDULING_FEATURES]], columns=SCHEDULING_FEATURES)
        raw_pred = float(self.sch_bundle.pipeline.predict(X)[0])
        pred_wait = round(max(0.0, min(horizon, raw_pred)), 2)

        if pred_wait <= 2.5:
            action = f"Advisory: Link near suitable threshold (~{pred_wait:.1f}s wait); clear for normal retry/flush."
        elif pred_wait <= 15.0:
            action = f"Advisory: Short wait estimated (~{pred_wait:.1f}s); pace non-critical bursts gently."
        else:
            action = f"Advisory: Extended wait estimated (~{pred_wait:.1f}s); preserve LittleFS/microSD backlog safely."

        return {
            "link_hop": link_hop,
            "model_type": "TRANSMISSION_SCHEDULING",
            "data_source": data_source,
            "trained_data_source": self.sch_bundle.trained_data_source,
            "hardware_validated": self.sch_bundle.trained_data_source == "ESP32_HARDWARE",
            "model_version": self.sch_bundle.model_version,
            "prediction_timestamp": now_iso,
            "prediction_status": "READY",
            "predicted_wait_seconds": pred_wait,
            "observation_censored": False,
            "advisory_only": True,
            "recommended_action": action,
            "features": cleaned,
        }


def create_app(service: NetworkMLInferenceService | None = None) -> Flask:
    app = Flask(__name__)
    svc = service or NetworkMLInferenceService()

    @app.get("/health")
    def get_health():
        return jsonify(svc.health()), 200

    @app.post("/predict/classification")
    def post_predict_classification():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "JSON object payload is required", "code": "INVALID_JSON"}), 400
        try:
            result = svc.predict_classification(payload)
            return jsonify(result), 200
        except MLSchemaError as exc:
            code = "ML_LINK_SCOPE_VIOLATION" if "exclusively" in str(exc) else "VALIDATION_ERROR"
            return jsonify({"error": str(exc), "code": code}), 400

    @app.post("/predict/scheduling")
    def post_predict_scheduling():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "JSON object payload is required", "code": "INVALID_JSON"}), 400
        try:
            result = svc.predict_scheduling(payload)
            return jsonify(result), 200
        except MLSchemaError as exc:
            code = "ML_LINK_SCOPE_VIOLATION" if "exclusively" in str(exc) else "VALIDATION_ERROR"
            return jsonify({"error": str(exc), "code": code}), 400

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Phase 5 Python Random Forest Inference Service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5055)
    args = parser.parse_args()

    inference_service = NetworkMLInferenceService()
    flask_app = create_app(inference_service)
    flask_app.run(host=args.host, port=args.port, debug=False)
