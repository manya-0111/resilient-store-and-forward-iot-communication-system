"""Reproducible synthetic dataset generator for Phase 5 NODE2_NODE3_WIFI ML models.

Generates realistic multi-session telemetry strictly marked data_source='SIMULATED'.
Never labels synthetic records as ESP32_HARDWARE.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from schema import (
    CLASSIFICATION_FEATURES,
    SCHEDULING_FEATURES,
    SUITABLE_OPPORTUNITY_SPEC,
    TARGET_LINK,
)

DATASET_VERSION = "v1.0.0-sim"
DATA_SOURCE = "SIMULATED"
DEFAULT_SEED = 42


def _is_healthy_sample(row: dict) -> bool:
    return (
        row["node2_to_node3_status"] == "CONNECTED"
        and row["rssi"] > SUITABLE_OPPORTUNITY_SPEC["min_rssi_dbm"]
        and row["packet_loss_ratio"] < SUITABLE_OPPORTUNITY_SPEC["max_packet_loss_ratio"]
        and row["ack_latency_ms"] <= SUITABLE_OPPORTUNITY_SPEC["max_ack_latency_ms"]
    )


def generate_synthetic_sessions(
    n_sessions: int = 40,
    seed: int = DEFAULT_SEED,
) -> pd.DataFrame:
    """Generate realistic multi-session NODE2_NODE3_WIFI observations with noise, overlap, outages, and recoveries."""
    rng = np.random.default_rng(seed)
    regimes = [
        "STABLE_GOOD",
        "MODERATE_CONGESTED",
        "DEGRADED_POOR",
        "FLUCTUATING",
        "INTERMITTENT_OUTAGE",
    ]
    rows: list[dict] = []

    base_epoch = datetime(2026, 10, 1, 0, 0, 0, tzinfo=timezone.utc)

    for session_idx in range(1, n_sessions + 1):
        regime = regimes[(session_idx - 1) % len(regimes)]
        n_steps = int(rng.integers(95, 135))
        # Spread sessions across hours & days of week for temporal diversity
        start_offset_hours = int(rng.integers(0, 24 * 14))
        t_cur = base_epoch + timedelta(hours=start_offset_hours, minutes=int(rng.integers(0, 60)))

        # Latent Markov state: 0=GOOD, 1=MODERATE, 2=POOR, 3=DISCONNECTED
        if regime == "STABLE_GOOD":
            state = 0
            rssi_anchor = float(rng.uniform(-66.0, -56.0))
        elif regime == "MODERATE_CONGESTED":
            state = 1
            rssi_anchor = float(rng.uniform(-76.5, -69.5))
        elif regime == "DEGRADED_POOR":
            state = 2
            rssi_anchor = float(rng.uniform(-87.0, -78.5))
        elif regime == "FLUCTUATING":
            state = int(rng.choice([0, 1, 2]))
            rssi_anchor = float(rng.uniform(-78.0, -64.0))
        else:  # INTERMITTENT_OUTAGE
            state = int(rng.choice([1, 2, 3], p=[0.35, 0.30, 0.35]))
            rssi_anchor = float(rng.uniform(-82.0, -68.0))

        prev_rssi = rssi_anchor
        prev_status = "DISCONNECTED" if state == 3 else "CONNECTED"
        state_started_at = t_cur
        queue_depth = int(rng.integers(0, 4))
        status_history: list[int] = []
        session_tag = f"sim_sess_{session_idx:03d}"

        for step in range(n_steps):
            dt_sec = float(rng.uniform(3.0, 5.5))
            t_cur = t_cur + timedelta(seconds=dt_sec)

            # Diurnal congestion factor (busier evenings slightly degrade latency/loss)
            hour = t_cur.hour
            day_of_week = t_cur.weekday()  # 0=Mon .. 6=Sun
            busy_hour = 1.0 if (17 <= hour <= 22 or 8 <= hour <= 11) else 0.0

            # Markov transition probabilities depend on session regime
            u = rng.random()
            if regime == "STABLE_GOOD":
                if state == 0 and u < 0.08:
                    state = 1
                elif state == 1 and u < 0.45:
                    state = 0
                elif state == 1 and u < 0.50:
                    state = 2
                elif state >= 2 and u < 0.65:
                    state = 1
            elif regime == "MODERATE_CONGESTED":
                if state == 0 and u < 0.35:
                    state = 1
                elif state == 1 and u < 0.14:
                    state = 0
                elif state == 1 and u < 0.22:
                    state = 2
                elif state == 2 and u < 0.32:
                    state = 1
                elif state == 2 and u < 0.37:
                    state = 3
                elif state == 3 and u < 0.30:
                    state = 2
            elif regime == "DEGRADED_POOR":
                if state == 0 and u < 0.55:
                    state = 1
                elif state == 1 and u < 0.40:
                    state = 2
                elif state == 2 and u < 0.14:
                    state = 1
                elif state == 2 and u < 0.28:
                    state = 3
                elif state == 3 and u < 0.14:
                    state = 2
            elif regime == "FLUCTUATING":
                if state == 0 and u < 0.22:
                    state = 1
                elif state == 1 and u < 0.26:
                    state = 0
                elif state == 1 and u < 0.50:
                    state = 2
                elif state == 2 and u < 0.30:
                    state = 1
                elif state == 2 and u < 0.42:
                    state = 3
                elif state == 3 and u < 0.22:
                    state = 1 if rng.random() < 0.45 else 2
            else:  # INTERMITTENT_OUTAGE
                if state == 0 and u < 0.18:
                    state = 1
                elif state == 1 and u < 0.22:
                    state = 0
                elif state == 1 and u < 0.44:
                    state = 3
                elif state == 2 and u < 0.30:
                    state = 3
                elif state == 2 and u < 0.55:
                    state = 1
                elif state == 3:
                    # Outages persist for several steps to create varying waits + right-censored tails
                    recover_p = 0.08 if session_idx % 5 == 0 else 0.15
                    if u < recover_p:
                        state = 1 if rng.random() < 0.6 else 2

            # Generate overlapping feature realizations from latent state + noise
            if state == 0:  # Latent GOOD
                target_rssi = rng.normal(-62.5 - 1.5 * busy_hour, 4.2)
                rssi = float(np.clip(0.55 * prev_rssi + 0.45 * target_rssi, -79.0, -45.0))
                rssi_var = float(np.clip(abs(rssi - prev_rssi) + rng.exponential(1.2), 0.3, 8.5))
                loss = float(np.clip(rng.beta(1.2, 24.0) + 0.015 * busy_hour, 0.0, 0.28))
                latency = float(np.clip(rng.normal(78.0 + 18.0 * busy_hour, 32.0), 18.0, 320.0))
                retries = int(rng.choice([0, 1, 2], p=[0.78, 0.18, 0.04]))
                queue_depth = int(np.clip(queue_depth + rng.choice([-1, 0, 1], p=[0.45, 0.42, 0.13]), 0, 5))
                status = "CONNECTED"
                latent_label = "GOOD"
            elif state == 1:  # Latent MODERATE
                target_rssi = rng.normal(-73.0 - 1.5 * busy_hour, 4.0)
                rssi = float(np.clip(0.50 * prev_rssi + 0.50 * target_rssi, -86.0, -60.0))
                rssi_var = float(np.clip(abs(rssi - prev_rssi) + rng.exponential(2.4), 0.8, 13.0))
                loss = float(np.clip(rng.beta(2.2, 12.0) + 0.02 * busy_hour, 0.01, 0.45))
                latency = float(np.clip(rng.normal(235.0 + 30.0 * busy_hour, 68.0), 55.0, 620.0))
                retries = int(rng.choice([0, 1, 2, 3], p=[0.22, 0.44, 0.26, 0.08]))
                queue_depth = int(np.clip(queue_depth + rng.choice([-1, 0, 1, 2], p=[0.20, 0.35, 0.33, 0.12]), 0, 11))
                status = "CONNECTED"
                latent_label = "MODERATE"
            elif state == 2:  # Latent POOR (connected but severely degraded)
                target_rssi = rng.normal(-83.5 - 1.0 * busy_hour, 4.5)
                rssi = float(np.clip(0.50 * prev_rssi + 0.50 * target_rssi, -98.0, -71.0))
                rssi_var = float(np.clip(abs(rssi - prev_rssi) + rng.exponential(3.8), 1.8, 18.0))
                loss = float(np.clip(rng.beta(4.0, 6.5) + 0.03 * busy_hour, 0.08, 0.92))
                latency = float(np.clip(rng.normal(540.0 + 50.0 * busy_hour, 145.0), 190.0, 1650.0))
                retries = int(rng.choice([1, 2, 3, 4, 5], p=[0.10, 0.25, 0.33, 0.22, 0.10]))
                queue_depth = int(np.clip(queue_depth + rng.choice([-1, 0, 1, 2], p=[0.10, 0.25, 0.38, 0.27]), 1, 24))
                status = "CONNECTED"
                latent_label = "POOR"
            else:  # Latent DISCONNECTED (link down -> classified POOR)
                rssi = float(np.clip(rng.normal(-102.0, 5.5), -115.0, -88.0))
                rssi_var = float(np.clip(abs(rssi - prev_rssi) * 0.4 + rng.exponential(2.5), 0.5, 22.0))
                loss = float(np.clip(rng.uniform(0.75, 1.0), 0.5, 1.0))
                latency = float(np.clip(rng.normal(1350.0, 180.0), 750.0, 2200.0))
                retries = int(rng.choice([2, 3, 4, 5], p=[0.15, 0.40, 0.28, 0.17]))
                queue_depth = int(np.clip(queue_depth + rng.choice([0, 1, 2], p=[0.20, 0.45, 0.35]), 2, 30))
                status = "DISCONNECTED"
                latent_label = "POOR"

            # Add realistic overlap / label boundary ambiguity in borderline RF zones (no single threshold!)
            quality_score = (
                (-rssi - 55.0) * 0.85
                + loss * 75.0
                + (latency / 20.0)
                + retries * 6.5
                + queue_depth * 1.1
                + rng.normal(0.0, 4.5)
            )
            if status == "DISCONNECTED":
                quality_label = "POOR"
            elif latent_label == "GOOD" and quality_score > 34.0:
                quality_label = "MODERATE"
            elif latent_label == "MODERATE" and quality_score < 21.0:
                quality_label = "GOOD"
            elif latent_label == "MODERATE" and quality_score > 52.0:
                quality_label = "POOR"
            elif latent_label == "POOR" and quality_score < 39.0:
                quality_label = "MODERATE"
            else:
                quality_label = latent_label

            # Causal tracking of link status history & duration (strictly <= t)
            if status != prev_status:
                state_started_at = t_cur
                prev_status = status
            connection_duration = round(max(0.0, (t_cur - state_started_at).total_seconds()), 1)

            status_history.append(1 if status == "CONNECTED" else 0)
            recent_window = status_history[-20:]
            wifi_avail_hist = round(sum(recent_window) / len(recent_window), 3)

            rows.append(
                {
                    "session_id": session_tag,
                    "session_num": session_idx,
                    "session_regime": regime,
                    "step_idx": step,
                    "link_hop": TARGET_LINK,
                    "data_source": DATA_SOURCE,
                    "dataset_version": DATASET_VERSION,
                    "recorded_at": t_cur.isoformat(),
                    "timestamp_sec": t_cur.timestamp(),
                    "node2_to_node3_status": status,
                    "rssi": round(rssi, 2),
                    "rssi_variation": round(rssi_var, 2),
                    "packet_loss_ratio": round(loss, 4),
                    "ack_latency_ms": round(latency, 1),
                    "retry_count": retries,
                    "queue_depth": queue_depth,
                    "wifi_availability_history": wifi_avail_hist,
                    "connection_duration": connection_duration,
                    "hour": hour,
                    "day_of_week": day_of_week,
                    "quality_label": quality_label,
                }
            )
            prev_rssi = rssi

    df = pd.DataFrame(rows)
    return _compute_scheduling_targets(df)


def _compute_scheduling_targets(df: pd.DataFrame) -> pd.DataFrame:
    """Compute actual_waiting_time_seconds and observation_censored per session without cross-session or future leakage."""
    horizon = float(SUITABLE_OPPORTUNITY_SPEC["censoring_horizon_seconds"])
    min_consec = int(SUITABLE_OPPORTUNITY_SPEC["min_consecutive_healthy_samples"])

    df = df.copy()
    df["actual_waiting_time_seconds"] = np.nan
    df["observation_censored"] = 0
    df["censoring_horizon_seconds"] = horizon
    df["suitable_opportunity_observed"] = 0

    for _, group in df.groupby("session_id", sort=False):
        idxs = group.index.to_list()
        records = group.to_dict("records")
        healthy = [_is_healthy_sample(r) for r in records]
        n = len(records)

        # A suitable opportunity starts at j if healthy[j : j + min_consec] are all True
        opp_start = [
            (j + min_consec <= n) and all(healthy[j : j + min_consec])
            for j in range(n)
        ]

        for i in range(n):
            t_i = records[i]["timestamp_sec"]
            found_idx = None
            for j in range(i, n):
                dt = records[j]["timestamp_sec"] - t_i
                if dt > horizon:
                    break
                if opp_start[j]:
                    found_idx = j
                    break

            row_idx = idxs[i]
            if found_idx is not None:
                wait_sec = round(max(0.0, records[found_idx]["timestamp_sec"] - t_i), 2)
                df.at[row_idx, "actual_waiting_time_seconds"] = wait_sec
                df.at[row_idx, "observation_censored"] = 0
                df.at[row_idx, "suitable_opportunity_observed"] = 1
            else:
                # Never fabricate waiting time when horizon or session ends before an opportunity occurs
                df.at[row_idx, "actual_waiting_time_seconds"] = np.nan
                df.at[row_idx, "observation_censored"] = 1
                df.at[row_idx, "suitable_opportunity_observed"] = 0

    return df


def save_synthetic_datasets(output_dir: str | Path | None = None, seed: int = DEFAULT_SEED) -> dict:
    base_dir = Path(output_dir) if output_dir else Path(__file__).resolve().parent / "data"
    base_dir.mkdir(parents=True, exist_ok=True)

    full_df = generate_synthetic_sessions(n_sessions=40, seed=seed)

    clf_cols = [
        "session_id",
        "session_num",
        "session_regime",
        "step_idx",
        "link_hop",
        "data_source",
        "dataset_version",
        "recorded_at",
        *CLASSIFICATION_FEATURES,
        "quality_label",
    ]
    sch_cols = [
        "session_id",
        "session_num",
        "session_regime",
        "step_idx",
        "link_hop",
        "data_source",
        "dataset_version",
        "recorded_at",
        "node2_to_node3_status",
        *SCHEDULING_FEATURES,
        "actual_waiting_time_seconds",
        "observation_censored",
        "censoring_horizon_seconds",
        "suitable_opportunity_observed",
    ]

    clf_path = base_dir / "synthetic_classification_node2_wifi.csv"
    sch_path = base_dir / "synthetic_scheduling_node2_wifi.csv"

    full_df[clf_cols].to_csv(clf_path, index=False)
    full_df[sch_cols].to_csv(sch_path, index=False)

    censored_count = int(full_df["observation_censored"].sum())
    uncensored_count = int((full_df["observation_censored"] == 0).sum())

    manifest = {
        "dataset_version": DATASET_VERSION,
        "data_source": DATA_SOURCE,
        "target_link": TARGET_LINK,
        "seed": seed,
        "total_sessions": int(full_df["session_num"].nunique()),
        "classification_rows": int(len(full_df)),
        "classification_class_counts": {
            k: int(v) for k, v in full_df["quality_label"].value_counts().to_dict().items()
        },
        "scheduling_total_rows": int(len(full_df)),
        "scheduling_uncensored_rows": uncensored_count,
        "scheduling_censored_rows": censored_count,
        "suitable_opportunity_definition": SUITABLE_OPPORTUNITY_SPEC,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "files": {
            "classification_csv": str(clf_path.name),
            "scheduling_csv": str(sch_path.name),
        },
        "notice": (
            "Synthetic multi-session dataset generated strictly for Phase 5 development and "
            "integration readiness. Does NOT represent real ESP32 hardware performance."
        ),
    }
    manifest_path = base_dir / "dataset_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


if __name__ == "__main__":
    info = save_synthetic_datasets()
    print(json.dumps(info, indent=2))
