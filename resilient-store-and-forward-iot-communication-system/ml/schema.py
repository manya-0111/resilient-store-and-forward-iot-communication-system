"""Shared schema, feature definitions, objective scheduling criteria, and validation for Phase 5 ML models.

Both models operate EXCLUSIVELY on link_hop='NODE2_NODE3_WIFI' (Node 2 Gateway -> Node 3 Receiver).
"""

from __future__ import annotations

import math
from typing import Any

TARGET_LINK = "NODE2_NODE3_WIFI"
CLASSIFICATION_CLASSES = ["GOOD", "MODERATE", "POOR"]
ALLOWED_DATA_SOURCES = ("SIMULATED", "ESP32_HARDWARE", "CSV_IMPORT")

CLASSIFICATION_FEATURES = [
    "rssi",
    "rssi_variation",
    "packet_loss_ratio",
    "ack_latency_ms",
    "retry_count",
    "queue_depth",
]

SCHEDULING_FEATURES = [
    "rssi",
    "rssi_variation",
    "packet_loss_ratio",
    "ack_latency_ms",
    "retry_count",
    "queue_depth",
    "wifi_availability_history",
    "connection_duration",
    "hour",
    "day_of_week",
]

# Objective criteria defining a suitable Node 2 -> Node 3 Wi-Fi transmission opportunity.
# Used consistently during dataset labeling and future ESP32 hardware label extraction.
SUITABLE_OPPORTUNITY_SPEC = {
    "target_link": TARGET_LINK,
    "required_link_status": "CONNECTED",
    "min_rssi_dbm": -78.0,
    "max_packet_loss_ratio": 0.20,
    "max_ack_latency_ms": 350.0,
    "min_consecutive_healthy_samples": 2,
    "censoring_horizon_seconds": 180.0,
    "description": (
        "A suitable Node 2 -> Node 3 Wi-Fi transmission opportunity begins at the earliest "
        "time t' >= t where node2_to_node3_status == 'CONNECTED' and at least 2 consecutive "
        "observations satisfy rssi > -78 dBm, packet_loss_ratio < 0.20, and ack_latency_ms <= 350 ms. "
        "If no such opportunity occurs within 180 seconds or before session termination, the "
        "observation is marked right-censored (observation_censored=1, target=null)."
    ),
}


class MLSchemaError(ValueError):
    """Raised when input features, link_hop, or data_source fail strict Phase 5 validation."""


def validate_link_hop(link_hop: Any) -> str:
    val = str(link_hop or "").strip().upper()
    if val != TARGET_LINK:
        raise MLSchemaError(
            f"ML models operate exclusively on '{TARGET_LINK}'. Received link_hop='{link_hop}'."
        )
    return val


def validate_data_source(data_source: Any) -> str:
    val = str(data_source or "").strip().upper()
    if val not in ALLOWED_DATA_SOURCES:
        raise MLSchemaError(
            f"data_source must be one of {ALLOWED_DATA_SOURCES}. Received '{data_source}'."
        )
    return val


def validate_feature_dict(features: dict[str, Any], required_keys: list[str]) -> dict[str, float]:
    if not isinstance(features, dict):
        raise MLSchemaError("features must be a dictionary.")

    cleaned: dict[str, float] = {}
    for key in required_keys:
        if key not in features or features[key] is None:
            raise MLSchemaError(f"Missing required feature '{key}'.")
        try:
            val = float(features[key])
        except (TypeError, ValueError) as exc:
            raise MLSchemaError(f"Feature '{key}' must be numeric.") from exc
        if not math.isfinite(val):
            raise MLSchemaError(f"Feature '{key}' must be a finite number.")

        if key == "packet_loss_ratio" and not (0.0 <= val <= 1.0):
            raise MLSchemaError("packet_loss_ratio must be in [0.0, 1.0].")
        if key in ("rssi_variation", "ack_latency_ms", "retry_count", "queue_depth", "connection_duration") and val < 0.0:
            raise MLSchemaError(f"Feature '{key}' cannot be negative.")
        if key == "wifi_availability_history" and not (0.0 <= val <= 1.0):
            raise MLSchemaError("wifi_availability_history must be in [0.0, 1.0].")
        if key == "hour":
            if int(val) != val or not (0 <= int(val) <= 23):
                raise MLSchemaError("hour must be an integer in [0, 23].")
        if key == "day_of_week":
            if int(val) != val or not (0 <= int(val) <= 6):
                raise MLSchemaError("day_of_week must be an integer in [0, 6] (Monday=0 .. Sunday=6).")

        cleaned[key] = val
    return cleaned


def rule_based_classification_baseline(features: dict[str, Any]) -> str:
    """Simple deterministic threshold baseline for comparing Model A (Random Forest Classifier)."""
    rssi = float(features["rssi"])
    rssi_var = float(features["rssi_variation"])
    loss = float(features["packet_loss_ratio"])
    latency = float(features["ack_latency_ms"])
    retries = float(features["retry_count"])
    queue_depth = float(features["queue_depth"])

    if rssi <= -82.0 or loss >= 0.28 or latency >= 480.0 or retries >= 3.0 or queue_depth >= 8.0:
        return "POOR"
    if rssi <= -72.0 or rssi_var >= 6.0 or loss >= 0.10 or latency >= 220.0 or retries >= 1.0 or queue_depth >= 3.0:
        return "MODERATE"
    return "GOOD"
