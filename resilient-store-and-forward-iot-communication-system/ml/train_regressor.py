"""Phase 5 Model B: Predictive Transmission Scheduling (Random Forest Regressor) for NODE2_NODE3_WIFI.

Predicts advisory estimated wait time (seconds) until the next suitable Node 2 -> Node 3 Wi-Fi
transmission opportunity using strictly causal <= t features.
Handles right-censored observations explicitly without fabricating waiting-time targets.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import joblib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import mean_absolute_error, median_absolute_error, r2_score, root_mean_squared_error
from sklearn.model_selection import GroupKFold, GridSearchCV
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from schema import SCHEDULING_FEATURES, SUITABLE_OPPORTUNITY_SPEC, TARGET_LINK
from synthetic_data import DATA_SOURCE, DATASET_VERSION, save_synthetic_datasets

MODEL_VERSION = "rf-reg-sim-v1.0.0"
SEED = 42


def load_and_validate_scheduling_data(csv_path: Path) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    if not csv_path.exists():
        save_synthetic_datasets(csv_path.parent, seed=SEED)

    raw_df = pd.read_csv(csv_path)
    initial_rows = len(raw_df)

    df = raw_df[
        (raw_df["link_hop"] == TARGET_LINK)
        & (raw_df["data_source"] == DATA_SOURCE)
    ].copy()
    df = df.drop_duplicates(subset=["session_id", "recorded_at"]).reset_index(drop=True)

    for col in SCHEDULING_FEATURES + ["actual_waiting_time_seconds"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.dropna(subset=SCHEDULING_FEATURES + ["session_num", "observation_censored"]).reset_index(drop=True)

    # Validate censoring invariant: censored rows MUST NOT have fabricated targets
    censored_df = df[df["observation_censored"] == 1].copy().reset_index(drop=True)
    uncensored_df = df[
        (df["observation_censored"] == 0)
        & df["actual_waiting_time_seconds"].notna()
        & (df["actual_waiting_time_seconds"] >= 0.0)
    ].copy().reset_index(drop=True)

    summary = {
        "initial_rows": int(initial_rows),
        "valid_rows": int(len(df)),
        "uncensored_rows": int(len(uncensored_df)),
        "censored_rows": int(len(censored_df)),
        "censored_rate": round(float(len(censored_df) / max(1, len(df))), 4),
        "sessions_total": int(df["session_num"].nunique()),
        "sessions_uncensored": int(uncensored_df["session_num"].nunique()),
        "target_stats_uncensored": {
            "mean": round(float(uncensored_df["actual_waiting_time_seconds"].mean()), 3),
            "median": round(float(uncensored_df["actual_waiting_time_seconds"].median()), 3),
            "p90": round(float(uncensored_df["actual_waiting_time_seconds"].quantile(0.90)), 3),
            "max": round(float(uncensored_df["actual_waiting_time_seconds"].max()), 3),
        },
    }
    return uncensored_df, censored_df, summary


def train_and_evaluate() -> dict:
    ml_dir = Path(__file__).resolve().parent
    data_csv = ml_dir / "data" / "synthetic_scheduling_node2_wifi.csv"
    artifacts_dir = ml_dir / "artifacts" / "transmission_scheduling"
    reports_dir = ml_dir / "reports"
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    reports_dir.mkdir(parents=True, exist_ok=True)

    uncensored_df, censored_df, data_summary = load_and_validate_scheduling_data(data_csv)

    # Strict session-grouped split (Sessions 1-30 train/CV vs Sessions 31-40 unseen test)
    train_df = uncensored_df[uncensored_df["session_num"] <= 30].copy().reset_index(drop=True)
    test_df = uncensored_df[uncensored_df["session_num"] > 30].copy().reset_index(drop=True)
    test_censored_df = censored_df[censored_df["session_num"] > 30].copy().reset_index(drop=True)

    X_train = train_df[SCHEDULING_FEATURES]
    y_train = train_df["actual_waiting_time_seconds"]
    groups_train = train_df["session_num"]

    X_test = test_df[SCHEDULING_FEATURES]
    y_test = test_df["actual_waiting_time_seconds"]

    pipeline = Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="median")),
            ("scaler", StandardScaler()),
            (
                "reg",
                RandomForestRegressor(
                    random_state=SEED,
                    n_jobs=1,
                ),
            ),
        ]
    )

    param_grid = {
        "reg__n_estimators": [120, 200],
        "reg__max_depth": [8, 12, 16],
        "reg__min_samples_leaf": [3, 6],
        "reg__max_features": ["sqrt", 0.7],
    }

    gkf = GroupKFold(n_splits=5)
    search = GridSearchCV(
        estimator=pipeline,
        param_grid=param_grid,
        cv=gkf,
        scoring="neg_mean_absolute_error",
        n_jobs=2,
        refit=True,
    )
    search.fit(X_train, y_train, groups=groups_train)
    best_pipeline: Pipeline = search.best_estimator_

    raw_preds = best_pipeline.predict(X_test)
    # Physical wait time cannot be negative
    y_pred = np.clip(raw_preds, 0.0, float(SUITABLE_OPPORTUNITY_SPEC["censoring_horizon_seconds"]))

    mae = float(mean_absolute_error(y_test, y_pred))
    rmse = float(root_mean_squared_error(y_test, y_pred))
    med_ae = float(median_absolute_error(y_test, y_pred))
    r2 = float(r2_score(y_test, y_pred))
    abs_errors = np.abs(y_test.values - y_pred)
    p90_err = float(np.percentile(abs_errors, 90))

    # Simple Baseline: Conditional median wait time per current link status (fit ONLY on training set!)
    cond_medians = train_df.groupby("node2_to_node3_status")["actual_waiting_time_seconds"].median().to_dict()
    global_median = float(y_train.median())
    baseline_preds = np.array([
        cond_medians.get(st, global_median) for st in test_df["node2_to_node3_status"]
    ])
    base_mae = float(mean_absolute_error(y_test, baseline_preds))
    base_rmse = float(root_mean_squared_error(y_test, baseline_preds))
    base_r2 = float(r2_score(y_test, baseline_preds))

    # Error analysis breakdown
    test_eval_df = test_df.copy()
    test_eval_df["predicted_wait"] = y_pred
    test_eval_df["abs_error"] = abs_errors
    test_eval_df["residual"] = y_pred - y_test.values

    by_status = {}
    for status, grp in test_eval_df.groupby("node2_to_node3_status"):
        by_status[str(status)] = {
            "count": int(len(grp)),
            "mae": round(float(grp["abs_error"].mean()), 3),
            "rmse": round(float(np.sqrt(np.mean((grp["predicted_wait"] - grp["actual_waiting_time_seconds"]) ** 2))), 3),
        }

    rf_reg: RandomForestRegressor = best_pipeline.named_steps["reg"]
    feature_importances = [
        {"feature": feat, "importance": round(float(imp), 4)}
        for feat, imp in sorted(
            zip(SCHEDULING_FEATURES, rf_reg.feature_importances_),
            key=lambda x: x[1],
            reverse=True,
        )
    ]

    # Plots: Actual vs Predicted and Residuals
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.5))
    axes[0].scatter(y_test, y_pred, alpha=0.45, s=16, color="#38BDF8", label="RF Predictions")
    max_val = max(float(y_test.max()), float(y_pred.max()), 10.0)
    axes[0].plot([0, max_val], [0, max_val], "r--", linewidth=1.2, label="Ideal (y = x)")
    axes[0].set_xlabel("Actual Waiting Time (s)")
    axes[0].set_ylabel("Predicted Waiting Time (s)")
    axes[0].set_title(f"Actual vs Predicted (MAE={mae:.2f}s, RMSE={rmse:.2f}s)")
    axes[0].legend(fontsize=8)
    axes[0].grid(alpha=0.2)

    axes[1].hist(test_eval_df["residual"], bins=30, color="#10B981", alpha=0.75, edgecolor="#0F172A")
    axes[1].axvline(0.0, color="red", linestyle="--", linewidth=1.2)
    axes[1].set_xlabel("Prediction Error (Predicted - Actual) [s]")
    axes[1].set_ylabel("Count")
    axes[1].set_title(f"Residual Distribution (Median AE={med_ae:.2f}s, P90 AE={p90_err:.2f}s)")
    axes[1].grid(alpha=0.2)

    fig.suptitle("Model B Unseen-Session Scheduling Evaluation (SIMULATED Uncensored Test Set)", fontsize=11)
    fig.tight_layout()
    fig.savefig(reports_dir / "scheduling_actual_vs_predicted.png", dpi=140)
    plt.close(fig)

    evaluated_at = datetime.now(timezone.utc).isoformat()
    split_method = "Session-grouped holdout (Sessions 1-30 GroupKFold-5 CV / Sessions 31-40 unseen test; uncensored targets only)"

    metadata = {
        "model_type": "TRANSMISSION_SCHEDULING",
        "algorithm": "RandomForestRegressor",
        "model_version": MODEL_VERSION,
        "target_link": TARGET_LINK,
        "data_source": DATA_SOURCE,
        "dataset_version": DATASET_VERSION,
        "feature_names": SCHEDULING_FEATURES,
        "suitable_opportunity_definition": SUITABLE_OPPORTUNITY_SPEC,
        "data_summary": data_summary,
        "training_config": {
            "seed": SEED,
            "cv_strategy": "GroupKFold(n_splits=5) by session_num (uncensored rows only)",
            "best_params": search.best_params_,
            "best_cv_mae": round(float(-search.best_score_), 3),
            "train_uncensored_rows": int(len(train_df)),
            "test_uncensored_rows": int(len(test_df)),
            "test_censored_rows_excluded_from_mae": int(len(test_censored_df)),
        },
        "evaluation": {
            "model_type": "TRANSMISSION_SCHEDULING",
            "link_hop": TARGET_LINK,
            "data_source": DATA_SOURCE,
            "model_version": MODEL_VERSION,
            "mae": round(mae, 3),
            "rmse": round(rmse, 3),
            "r2": round(r2, 4),
            "sample_count": int(len(test_df)),
            "censored_count": int(len(test_censored_df)),
            "split_method": split_method,
            "evaluated_at": evaluated_at,
            "note": (
                "Evaluated strictly on unseen uncensored SIMULATED test observations. "
                "Censored rows were excluded rather than fabricated. Advisory only."
            ),
        },
        "error_analysis": {
            "median_abs_error_s": round(med_ae, 3),
            "p90_abs_error_s": round(p90_err, 3),
            "by_link_status": by_status,
        },
        "baseline_comparison": {
            "baseline_name": "Training-Set Conditional Median by Link Status (CONNECTED/DISCONNECTED)",
            "cond_medians_fit_on_train": {str(k): round(float(v), 3) for k, v in cond_medians.items()},
            "mae": round(base_mae, 3),
            "rmse": round(base_rmse, 3),
            "r2": round(base_r2, 4),
            "mae_improvement_s": round(base_mae - mae, 3),
            "rmse_improvement_s": round(base_rmse - rmse, 3),
        },
        "feature_importances": feature_importances,
        "trained_at": evaluated_at,
    }

    joblib.dump(best_pipeline, artifacts_dir / "model_pipeline.joblib")
    (artifacts_dir / "model_metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


if __name__ == "__main__":
    result = train_and_evaluate()
    print(json.dumps({
        "model_version": result["model_version"],
        "evaluation": result["evaluation"],
        "error_analysis": result["error_analysis"],
        "baseline_comparison": result["baseline_comparison"],
        "feature_importances": result["feature_importances"],
    }, indent=2))
