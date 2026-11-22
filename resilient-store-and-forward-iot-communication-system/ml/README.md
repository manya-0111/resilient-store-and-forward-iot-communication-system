# Phase 5 — Python Random Forest ML Pipeline (`NODE2_NODE3_WIFI`)

Strictly scoped to **`NODE2_NODE3_WIFI`** (Node 2 Gateway → Node 3 Receiver Wi-Fi).
Advisory only: core Wi-Fi/LoRa fallback, AES-128-GCM authenticated encryption, hop-by-hop ACKs, retries, and LittleFS/microSD queues operate deterministically regardless of ML service state.

## Important Provenance Notice
Physical ESP32 hardware data is not yet available. All current datasets, model training runs, evaluation metrics, and live dashboard syncs are strictly labeled **`data_source = SIMULATED`** (`dataset_version = v1.0.0-sim`). Never represent simulated benchmarks as real ESP32 hardware performance.

## Directory Layout
- `schema.py`: Shared feature definitions, `NODE2_NODE3_WIFI` scope guard, `SUITABLE_OPPORTUNITY_SPEC`, and rule-based classifier baseline.
- `synthetic_data.py`: Reproducible 40-session synthetic generator with realistic noise, overlapping class distributions, outages, recoveries, and right-censored scheduling rows.
- `train_classifier.py`: Model A (`RandomForestClassifier`) with EDA, session-grouped `GroupKFold(5)` CV, POOR-recall-weighted tuning, confusion matrix, and baseline comparison.
- `train_regressor.py`: Model B (`RandomForestRegressor`) with censored-observation filtering, session-grouped `GroupKFold(5)` CV, MAE/RMSE/R², and conditional-median baseline comparison.
- `inference_service.py`: Loads persisted `joblib` pipelines and serves validated `GET /health`, `POST /predict/classification`, `POST /predict/scheduling` (`127.0.0.1:5055`). Refuses non-`NODE2_NODE3_WIFI` links, handles `UNAVAILABLE`, `STALE`, `INSUFFICIENT_DATA`, `CENSORED`, and refuses serving `SIMULATED` artifacts as `ESP32_HARDWARE`.
- `express_bridge.py`: HTTP-only bridge calling Express `/api/ml/*` routes on `http://127.0.0.1:3000`.

## Running
```bash
/opt/ml_venv/bin/python ml/synthetic_data.py
/opt/ml_venv/bin/python ml/train_classifier.py
/opt/ml_venv/bin/python ml/train_regressor.py
/opt/ml_venv/bin/python ml/express_bridge.py --verify
```
