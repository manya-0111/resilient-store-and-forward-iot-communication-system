"""Network Quality ML Module using scikit-learn RandomForestClassifier with session-grouped evaluation (PDF Section 9A)."""
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, f1_score

CLASSES = ["GOOD", "MODERATE", "POOR"]
FEATURE_SPECS = [
    ("rssi", "Wi-Fi RSSI (dBm)"),
    ("rssi_variation", "RSSI Variation (dB)"),
    ("packet_loss_ratio", "Packet Loss Ratio"),
    ("ack_latency_ms", "ACK Latency (ms)"),
    ("retry_count", "Retry Count"),
    ("queue_depth", "Queue Depth"),
]
FEATURE_KEYS = [k for k, _ in FEATURE_SPECS]


def rule_based_baseline(f: dict) -> str:
    if f["rssi"] <= -80 or f["packet_loss_ratio"] >= 0.28 or f["ack_latency_ms"] >= 500 or f["retry_count"] >= 3 or f["queue_depth"] >= 8:
        return "POOR"
    if f["rssi"] <= -70 or f["rssi_variation"] >= 6 or f["packet_loss_ratio"] >= 0.1 or f["ack_latency_ms"] >= 220 or f["retry_count"] >= 1 or f["queue_depth"] >= 3:
        return "MODERATE"
    return "GOOD"


class NetworkQualityModel:
    def __init__(self) -> None:
        self.model = RandomForestClassifier(n_estimators=80, max_depth=6, random_state=42)
        self.model_status = "DEMO / SIMULATED MODEL (Synthetic Multi-Session Baseline)"
        self.evaluation = self._train_synthetic_sessions()

    def _train_synthetic_sessions(self) -> dict:
        rng = np.random.default_rng(42)
        X, y, sessions = [], [], []
        for sid in range(1, 13):
            regime = (sid - 1) % 3
            for _ in range(30):
                if regime == 0:
                    row = [rng.uniform(-68, -52), rng.uniform(0.5, 4.0), rng.uniform(0.0, 0.08), rng.uniform(45, 180), int(rng.random() > 0.85), int(rng.integers(0, 3))]
                elif regime == 1:
                    row = [rng.uniform(-79, -69), rng.uniform(3.5, 9.5), rng.uniform(0.08, 0.28), rng.uniform(180, 480), int(rng.integers(1, 3)), int(rng.integers(2, 8))]
                else:
                    row = [rng.uniform(-96, -79), rng.uniform(6.0, 15.0), rng.uniform(0.26, 0.78), rng.uniform(420, 1250), int(rng.integers(2, 6)), int(rng.integers(5, 16))]
                X.append(row)
                y.append(regime)
                sessions.append(sid)

        X_arr, y_arr, s_arr = np.array(X), np.array(y), np.array(sessions)
        train_mask = s_arr <= 9
        test_mask = s_arr >= 10
        self.model.fit(X_arr[train_mask], y_arr[train_mask])
        rf_preds = self.model.predict(X_arr[test_mask])
        base_preds = np.array([
            CLASSES.index(rule_based_baseline(dict(zip(FEATURE_KEYS, r))))
            for r in X_arr[test_mask]
        ])
        return {
            "split_method": "Session-grouped holdout (9 train sessions / 3 unseen test sessions)",
            "training_sessions": 9,
            "test_sessions": 3,
            "rf_holdout_accuracy": round(float(accuracy_score(y_arr[test_mask], rf_preds)), 3),
            "baseline_holdout_accuracy": round(float(accuracy_score(y_arr[test_mask], base_preds)), 3),
            "rf_macro_f1": round(float(f1_score(y_arr[test_mask], rf_preds, average="macro")), 3),
            "baseline_macro_f1": round(float(f1_score(y_arr[test_mask], base_preds, average="macro")), 3),
            "model_status": self.model_status,
            "note": "Synthetic multi-session demonstration benchmark. Collect labelled real ESP32 sessions before claiming field accuracy.",
        }

    def get_feature_importance(self) -> list[dict]:
        items = [
            {"feature": key, "label": label, "importance": round(float(imp), 3)}
            for (key, label), imp in zip(FEATURE_SPECS, self.model.feature_importances_)
        ]
        items.sort(key=lambda x: x["importance"], reverse=True)
        return items

    def get_reference_info(self) -> dict:
        return {
            "feature_importance": self.get_feature_importance(),
            "evaluation": self.evaluation,
            "model_status": self.model_status,
        }

    def predict(self, features: dict) -> dict:
        vec = np.array([[float(features.get(k, 0.0)) for k in FEATURE_KEYS]])
        probs = self.model.predict_proba(vec)[0]
        idx = int(np.argmax(probs))
        predicted = CLASSES[idx]
        baseline = rule_based_baseline({k: float(features.get(k, 0.0)) for k in FEATURE_KEYS})
        risk = int(round(probs[1] * 45 + probs[2] * 100))
        return {
            "predicted_class": predicted,
            "probabilities": {c: round(float(probs[i]), 3) for i, c in enumerate(CLASSES)},
            "confidence": round(float(probs[idx]), 3),
            "risk_score": max(0, min(100, risk)),
            "baseline_class": baseline,
            "baseline_agreement": predicted == baseline,
            "model_status": self.model_status,
            "is_synthetic_baseline": True,
            "feature_importance": self.get_feature_importance(),
            "evaluation": self.evaluation,
        }
