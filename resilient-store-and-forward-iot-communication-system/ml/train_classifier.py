"""Phase 5 Model A: Network Quality Classification (Random Forest Classifier) for NODE2_NODE3_WIFI.

Implements EDA, data cleaning, label validation, session-grouped cross-validation,
hyperparameter tuning (prioritizing Macro F1 & POOR recall), rule-based baseline comparison,
and reproducible joblib + JSON artifact persistence.
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
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
    make_scorer,
    recall_score,
)
from sklearn.model_selection import GroupKFold, GridSearchCV
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from schema import (
    CLASSIFICATION_CLASSES,
    CLASSIFICATION_FEATURES,
    TARGET_LINK,
    rule_based_classification_baseline,
)
from synthetic_data import DATA_SOURCE, DATASET_VERSION, save_synthetic_datasets

MODEL_VERSION = "rf-clf-sim-v1.0.0"
SEED = 42


def _poor_recall_weighted_score(y_true, y_pred) -> float:
    macro = f1_score(y_true, y_pred, labels=CLASSIFICATION_CLASSES, average="macro", zero_division=0)
    poor_rec = recall_score(
        y_true, y_pred, labels=["POOR"], average=None, zero_division=0
    )[0]
    return float(0.6 * macro + 0.4 * poor_rec)


def load_and_clean_dataset(csv_path: Path) -> tuple[pd.DataFrame, dict]:
    if not csv_path.exists():
        save_synthetic_datasets(csv_path.parent, seed=SEED)

    raw_df = pd.read_csv(csv_path)
    initial_rows = len(raw_df)

    # Enforce strict link scope and provenance
    df = raw_df[
        (raw_df["link_hop"] == TARGET_LINK)
        & (raw_df["data_source"] == DATA_SOURCE)
        & (raw_df["quality_label"].isin(CLASSIFICATION_CLASSES))
    ].copy()

    # Deduplicate same-session timestamps if any
    df = df.drop_duplicates(subset=["session_id", "recorded_at"]).reset_index(drop=True)

    # Validate bounds cleanly
    for col in CLASSIFICATION_FEATURES:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=CLASSIFICATION_FEATURES + ["quality_label", "session_num"]).reset_index(drop=True)
    df = df[
        (df["packet_loss_ratio"] >= 0.0)
        & (df["packet_loss_ratio"] <= 1.0)
        & (df["rssi_variation"] >= 0.0)
        & (df["ack_latency_ms"] >= 0.0)
        & (df["retry_count"] >= 0)
        & (df["queue_depth"] >= 0)
    ].reset_index(drop=True)

    cleaning_summary = {
        "initial_rows": int(initial_rows),
        "cleaned_rows": int(len(df)),
        "dropped_rows": int(initial_rows - len(df)),
        "sessions": int(df["session_num"].nunique()),
        "target_link": TARGET_LINK,
        "data_source": DATA_SOURCE,
    }
    return df, cleaning_summary


def run_eda(df: pd.DataFrame, reports_dir: Path) -> dict:
    reports_dir.mkdir(parents=True, exist_ok=True)
    class_counts = {c: int((df["quality_label"] == c).sum()) for c in CLASSIFICATION_CLASSES}
    per_class_stats: dict[str, dict] = {}
    for cls in CLASSIFICATION_CLASSES:
        sub = df[df["quality_label"] == cls]
        per_class_stats[cls] = {
            feat: {
                "mean": round(float(sub[feat].mean()), 3),
                "std": round(float(sub[feat].std()), 3),
                "p10": round(float(sub[feat].quantile(0.10)), 3),
                "median": round(float(sub[feat].median()), 3),
                "p90": round(float(sub[feat].quantile(0.90)), 3),
            }
            for feat in CLASSIFICATION_FEATURES
        }

    eda = {
        "row_count": int(len(df)),
        "session_count": int(df["session_num"].nunique()),
        "class_counts": class_counts,
        "class_proportions": {c: round(v / max(1, len(df)), 4) for c, v in class_counts.items()},
        "per_class_feature_summary": per_class_stats,
    }
    (reports_dir / "classifier_eda.json").write_text(json.dumps(eda, indent=2), encoding="utf-8")

    # Plot overlapping feature distributions
    fig, axes = plt.subplots(2, 3, figsize=(13, 7.5))
    colors = {"GOOD": "#10B981", "MODERATE": "#F59E0B", "POOR": "#F43F5E"}
    for ax, feat in zip(axes.flat, CLASSIFICATION_FEATURES):
        for cls in CLASSIFICATION_CLASSES:
            vals = df.loc[df["quality_label"] == cls, feat].values
            ax.hist(vals, bins=24, alpha=0.45, density=True, label=cls, color=colors[cls])
        ax.set_title(feat)
        ax.grid(alpha=0.2)
    axes.flat[0].legend(loc="upper left", fontsize=8)
    fig.suptitle("Model A (SIMULATED) Feature Overlap Across GOOD / MODERATE / POOR", fontsize=11)
    fig.tight_layout()
    fig.savefig(reports_dir / "classifier_eda_overlap.png", dpi=140)
    plt.close(fig)
    return eda


def train_and_evaluate() -> dict:
    ml_dir = Path(__file__).resolve().parent
    data_csv = ml_dir / "data" / "synthetic_classification_node2_wifi.csv"
    artifacts_dir = ml_dir / "artifacts" / "network_quality"
    reports_dir = ml_dir / "reports"
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    reports_dir.mkdir(parents=True, exist_ok=True)

    df, cleaning_summary = load_and_clean_dataset(data_csv)
    eda_summary = run_eda(df, reports_dir)

    # Strict session-grouped split: sessions 1..30 for CV tuning + train, sessions 31..40 (unseen, 2 per regime) for test
    train_df = df[df["session_num"] <= 30].copy().reset_index(drop=True)
    test_df = df[df["session_num"] > 30].copy().reset_index(drop=True)

    X_train = train_df[CLASSIFICATION_FEATURES]
    y_train = train_df["quality_label"]
    groups_train = train_df["session_num"]

    X_test = test_df[CLASSIFICATION_FEATURES]
    y_test = test_df["quality_label"]

    pipeline = Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="median")),
            ("scaler", StandardScaler()),
            (
                "clf",
                RandomForestClassifier(
                    random_state=SEED,
                    n_jobs=1,
                ),
            ),
        ]
    )

    param_grid = {
        "clf__n_estimators": [120, 200],
        "clf__max_depth": [8, 14, None],
        "clf__min_samples_leaf": [2, 5],
        "clf__class_weight": [
            "balanced_subsample",
            {"GOOD": 1.0, "MODERATE": 1.25, "POOR": 1.65},
        ],
    }

    gkf = GroupKFold(n_splits=5)
    scorer = make_scorer(_poor_recall_weighted_score)
    search = GridSearchCV(
        estimator=pipeline,
        param_grid=param_grid,
        cv=gkf,
        scoring=scorer,
        n_jobs=2,
        refit=True,
    )
    search.fit(X_train, y_train, groups=groups_train)
    best_pipeline: Pipeline = search.best_estimator_

    # Evaluate on unseen test sessions
    y_pred = best_pipeline.predict(X_test)
    cm = confusion_matrix(y_test, y_pred, labels=CLASSIFICATION_CLASSES)
    acc = float(accuracy_score(y_test, y_pred))
    macro_f1 = float(f1_score(y_test, y_pred, labels=CLASSIFICATION_CLASSES, average="macro"))
    weighted_f1 = float(f1_score(y_test, y_pred, labels=CLASSIFICATION_CLASSES, average="weighted"))
    report_dict = classification_report(
        y_test, y_pred, labels=CLASSIFICATION_CLASSES, output_dict=True, zero_division=0
    )

    per_class = {
        cls: {
            "precision": round(float(report_dict[cls]["precision"]), 4),
            "recall": round(float(report_dict[cls]["recall"]), 4),
            "f1": round(float(report_dict[cls]["f1-score"]), 4),
            "support": int(report_dict[cls]["support"]),
        }
        for cls in CLASSIFICATION_CLASSES
    }

    # Baseline comparison on exact same unseen test sessions
    baseline_preds = [
        rule_based_classification_baseline(row)
        for row in test_df[CLASSIFICATION_FEATURES].to_dict("records")
    ]
    base_cm = confusion_matrix(y_test, baseline_preds, labels=CLASSIFICATION_CLASSES)
    base_acc = float(accuracy_score(y_test, baseline_preds))
    base_macro_f1 = float(f1_score(y_test, baseline_preds, labels=CLASSIFICATION_CLASSES, average="macro"))
    base_report = classification_report(
        y_test, baseline_preds, labels=CLASSIFICATION_CLASSES, output_dict=True, zero_division=0
    )
    base_poor_recall = float(base_report["POOR"]["recall"])

    rf_clf: RandomForestClassifier = best_pipeline.named_steps["clf"]
    feature_importances = [
        {"feature": feat, "importance": round(float(imp), 4)}
        for feat, imp in sorted(
            zip(CLASSIFICATION_FEATURES, rf_clf.feature_importances_),
            key=lambda x: x[1],
            reverse=True,
        )
    ]

    # Plot Confusion Matrix (RF vs Baseline)
    fig, axes = plt.subplots(1, 2, figsize=(10.5, 4.4))
    for ax, mat, title in [
        (axes[0], cm, f"Random Forest (Acc={acc:.3f}, POOR Rec={per_class['POOR']['recall']:.3f})"),
        (axes[1], base_cm, f"Rule Baseline (Acc={base_acc:.3f}, POOR Rec={base_poor_recall:.3f})"),
    ]:
        im = ax.imshow(mat, cmap="Blues")
        ax.set_xticks(range(3), CLASSIFICATION_CLASSES)
        ax.set_yticks(range(3), CLASSIFICATION_CLASSES)
        ax.set_xlabel("Predicted")
        ax.set_ylabel("Actual")
        ax.set_title(title, fontsize=10)
        for r in range(3):
            for c in range(3):
                ax.text(c, r, str(mat[r, c]), ha="center", va="center", color="black" if mat[r, c] < mat.max() * 0.6 else "white")
    fig.suptitle("Model A Unseen-Session Confusion Matrix (SIMULATED Data Only)", fontsize=11)
    fig.tight_layout()
    fig.savefig(reports_dir / "classifier_confusion_matrix.png", dpi=140)
    plt.close(fig)

    evaluated_at = datetime.now(timezone.utc).isoformat()
    split_method = "Session-grouped holdout (Sessions 1-30 GroupKFold-5 CV / Sessions 31-40 unseen test)"

    metadata = {
        "model_type": "NETWORK_QUALITY",
        "algorithm": "RandomForestClassifier",
        "model_version": MODEL_VERSION,
        "target_link": TARGET_LINK,
        "data_source": DATA_SOURCE,
        "dataset_version": DATASET_VERSION,
        "feature_names": CLASSIFICATION_FEATURES,
        "classes": CLASSIFICATION_CLASSES,
        "cleaning_summary": cleaning_summary,
        "eda_summary": {
            "class_counts": eda_summary["class_counts"],
            "class_proportions": eda_summary["class_proportions"],
        },
        "training_config": {
            "seed": SEED,
            "cv_strategy": "GroupKFold(n_splits=5) by session_num",
            "best_params": search.best_params_,
            "best_cv_weighted_score": round(float(search.best_score_), 4),
            "train_rows": int(len(train_df)),
            "train_sessions": int(train_df["session_num"].nunique()),
            "test_rows": int(len(test_df)),
            "test_sessions": int(test_df["session_num"].nunique()),
        },
        "evaluation": {
            "model_type": "NETWORK_QUALITY",
            "link_hop": TARGET_LINK,
            "data_source": DATA_SOURCE,
            "model_version": MODEL_VERSION,
            "accuracy": round(acc, 4),
            "macro_f1": round(macro_f1, 4),
            "weighted_f1": round(weighted_f1, 4),
            "confusion_matrix": {
                "labels": CLASSIFICATION_CLASSES,
                "matrix": cm.tolist(),
            },
            "per_class": per_class,
            "sample_count": int(len(test_df)),
            "split_method": split_method,
            "evaluated_at": evaluated_at,
            "note": (
                "Evaluated strictly on unseen SIMULATED test sessions (31-40). "
                "Does NOT represent real ESP32 hardware performance."
            ),
        },
        "baseline_comparison": {
            "baseline_name": "Deterministic Rule-Based Threshold Heuristic",
            "accuracy": round(base_acc, 4),
            "macro_f1": round(base_macro_f1, 4),
            "poor_recall": round(base_poor_recall, 4),
            "confusion_matrix": base_cm.tolist(),
            "rf_minus_baseline_accuracy": round(acc - base_acc, 4),
            "rf_minus_baseline_macro_f1": round(macro_f1 - base_macro_f1, 4),
            "rf_minus_baseline_poor_recall": round(per_class["POOR"]["recall"] - base_poor_recall, 4),
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
        "baseline_comparison": result["baseline_comparison"],
        "feature_importances": result["feature_importances"],
    }, indent=2))
