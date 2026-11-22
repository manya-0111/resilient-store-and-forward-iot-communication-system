"""Sensor Anomaly Detection ML Module using scikit-learn IsolationForest (PDF Section 9B)."""
import numpy as np
from sklearn.ensemble import IsolationForest


class SensorAnomalyModel:
    def __init__(self) -> None:
        self.threshold = 0.62
        self.model_status = "DEMO / SIMULATED MODEL (Isolation Forest — Synthetic Baseline)"
        self.model = IsolationForest(n_estimators=100, contamination=0.05, random_state=42)
        self._fit_synthetic_normal_baseline()

    def _fit_synthetic_normal_baseline(self) -> None:
        rng = np.random.default_rng(123)
        X = np.column_stack([
            rng.uniform(21.0, 35.0, 300),
            rng.uniform(42.0, 84.0, 300),
            rng.uniform(100.0, 720.0, 300),
            rng.uniform(0.0, 1.5, 300),
            rng.uniform(0.0, 4.0, 300),
            rng.uniform(0.0, 120.0, 300),
            rng.uniform(2.5, 8.0, 300),
        ])
        self.model.fit(X)

    def evaluate(
        self,
        temperature: float,
        humidity: float,
        rain_raw: int,
        delta_temp: float,
        delta_humidity: float,
        delta_rain: float,
        dt_seconds: float,
    ) -> dict:
        vec = np.array([[temperature, humidity, rain_raw, abs(delta_temp), abs(delta_humidity), abs(delta_rain), dt_seconds]])
        pred = int(self.model.predict(vec)[0])
        raw_decision = float(self.model.decision_function(vec)[0])
        score = round(max(0.0, min(1.0, 0.5 - raw_decision)), 3)
        reasons = []
        if temperature < 10 or temperature > 45:
            reasons.append(f"Temperature outside normal range ({temperature:.1f}°C)")
        if humidity < 15 or humidity > 96:
            reasons.append(f"Humidity outside normal range ({humidity:.1f}%)")
        if abs(delta_temp) >= 5.0:
            reasons.append(f"Abrupt temperature step ({delta_temp:+.1f}°C)")
        if abs(delta_humidity) >= 18.0:
            reasons.append(f"Abrupt humidity jump ({delta_humidity:+.1f}%)")
        is_anomaly = pred == -1 or score >= self.threshold or len(reasons) > 0
        final_score = min(0.95, round(self.threshold + 0.08, 3)) if (reasons and score < self.threshold) else score
        return {
            "status": "ANOMALY / NEEDS CHECK" if is_anomaly else "NORMAL",
            "is_anomaly": bool(is_anomaly),
            "anomaly_score": final_score,
            "threshold": self.threshold,
            "reason": (
                f"{'; '.join(reasons)}. Original reading preserved for human verification."
                if reasons
                else (
                    "Isolation Forest flagged unusual multi-sensor feature combination. Original reading preserved."
                    if is_anomaly
                    else "Reading within expected multi-sensor distribution."
                )
            ),
            "preserved": True,
            "is_synthetic_baseline": True,
            "model_status": self.model_status,
        }
