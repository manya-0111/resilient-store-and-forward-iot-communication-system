import {
  db,
  getJsonSetting,
  getSettings,
  setJsonSetting,
  type OperatingMode,
} from './database.ts';

export const ML_TARGET_LINK = 'NODE2_NODE3_WIFI' as const;
export const ML_CLASSIFICATION_CLASSES = ['GOOD', 'MODERATE', 'POOR'] as const;
export const ML_DATA_SOURCES = ['SIMULATED', 'ESP32_HARDWARE', 'CSV_IMPORT'] as const;
export const ML_CLASSIFICATION_STATUSES = [
  'READY',
  'UNAVAILABLE',
  'STALE',
  'INSUFFICIENT_DATA',
] as const;
export const ML_SCHEDULING_STATUSES = [
  'READY',
  'UNAVAILABLE',
  'STALE',
  'INSUFFICIENT_DATA',
  'CENSORED',
] as const;

export const PREDICTION_STALE_SECONDS = 60;
export const HEARTBEAT_STALE_SECONDS = 90;
export const SCHEDULING_MIN_SAMPLES = 5;

export type NetworkQualityClass = (typeof ML_CLASSIFICATION_CLASSES)[number];
export type MLDataSource = (typeof ML_DATA_SOURCES)[number];
export type ClassificationStatus = (typeof ML_CLASSIFICATION_STATUSES)[number];
export type SchedulingStatus = (typeof ML_SCHEDULING_STATUSES)[number];
export type ModelAvailabilityState =
  | 'AVAILABLE'
  | 'STALE'
  | 'UNAVAILABLE'
  | 'INSUFFICIENT_DATA'
  | 'CENSORED'
  | 'DISABLED';

export interface ClassificationFeatures {
  rssi: number;
  rssi_variation: number;
  packet_loss_ratio: number;
  ack_latency_ms: number;
  retry_count: number;
  queue_depth: number;
}

export interface SchedulingFeatures extends ClassificationFeatures {
  wifi_availability_history: number; // 0.0 to 1.0 rolling availability ratio on NODE2_NODE3_WIFI
  connection_duration: number; // seconds in current CONNECTED/DISCONNECTED state
  hour: number; // 0..23 UTC
  day_of_week: number; // 0..6 (Monday=0 .. Sunday=6)
}

export interface ClassificationPredictionRecord {
  id: number;
  mode: OperatingMode;
  link_hop: typeof ML_TARGET_LINK;
  model_type: 'NETWORK_QUALITY';
  predicted_class: NetworkQualityClass | null;
  probabilities: Record<NetworkQualityClass, number> | null;
  confidence: number | null;
  model_version: string;
  prediction_timestamp: string;
  data_source: MLDataSource;
  prediction_status: ClassificationStatus;
  features: Partial<ClassificationFeatures>;
  metric_id: number | null;
  created_at: string;
}

export interface SchedulingPredictionRecord {
  id: number;
  mode: OperatingMode;
  link_hop: typeof ML_TARGET_LINK;
  model_type: 'TRANSMISSION_SCHEDULING';
  predicted_wait_seconds: number | null;
  actual_wait_seconds: number | null;
  observation_censored: boolean;
  model_version: string;
  prediction_timestamp: string;
  data_source: MLDataSource;
  prediction_status: SchedulingStatus;
  advisory_only: true;
  recommended_action: string | null;
  features: Partial<SchedulingFeatures>;
  metric_id: number | null;
  created_at: string;
}

export interface ClassificationEvaluationMetrics {
  model_type: 'NETWORK_QUALITY';
  link_hop: typeof ML_TARGET_LINK;
  data_source: MLDataSource;
  model_version: string;
  accuracy: number;
  macro_f1: number;
  weighted_f1?: number;
  confusion_matrix: {
    labels: ['GOOD', 'MODERATE', 'POOR'];
    matrix: number[][];
  };
  per_class?: Record<
    NetworkQualityClass,
    { precision: number; recall: number; f1: number; support: number }
  >;
  sample_count: number;
  split_method: string;
  evaluated_at: string;
  note?: string;
}

export interface SchedulingEvaluationMetrics {
  model_type: 'TRANSMISSION_SCHEDULING';
  link_hop: typeof ML_TARGET_LINK;
  data_source: MLDataSource;
  model_version: string;
  mae: number;
  rmse: number;
  r2?: number;
  sample_count: number;
  censored_count?: number;
  split_method: string;
  evaluated_at: string;
  note?: string;
}

export interface ExternalModelHeartbeat {
  model_type: 'NETWORK_QUALITY' | 'TRANSMISSION_SCHEDULING';
  link_hop: typeof ML_TARGET_LINK;
  status: 'AVAILABLE' | 'OFFLINE' | 'DEGRADED';
  model_version: string;
  last_heartbeat_at: string;
  service_name?: string;
  note?: string;
}

export class MLValidationError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isFiniteNum(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val);
}

function parseIsoTimestamp(raw: unknown, fieldName: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new MLValidationError(
      'INVALID_TIMESTAMP',
      `${fieldName} must be a non-empty ISO 8601 timestamp string.`
    );
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new MLValidationError(
      'INVALID_TIMESTAMP',
      `${fieldName} is not a valid ISO 8601 timestamp.`
    );
  }
  return new Date(ms).toISOString();
}

export function validateTargetLink(rawLinkHop: unknown): typeof ML_TARGET_LINK {
  const link = typeof rawLinkHop === 'string' ? rawLinkHop.trim().toUpperCase() : '';
  if (link !== ML_TARGET_LINK) {
    throw new MLValidationError(
      'ML_LINK_SCOPE_VIOLATION',
      `ML models operate exclusively on '${ML_TARGET_LINK}'. Received link_hop='${rawLinkHop ?? ''}'. Do not mix NODE1_NODE3_WIFI or NODE1_NODE2_LORA metrics with ML.`,
      400
    );
  }
  return ML_TARGET_LINK;
}

export function validateDataSourceAndMode(
  rawDataSource: unknown,
  rawMode?: unknown
): { dataSource: MLDataSource; mode: OperatingMode } {
  const ds = typeof rawDataSource === 'string' ? rawDataSource.trim().toUpperCase() : '';
  if (ds !== 'SIMULATED' && ds !== 'ESP32_HARDWARE' && ds !== 'CSV_IMPORT') {
    throw new MLValidationError(
      'INVALID_DATA_SOURCE',
      `data_source must be 'SIMULATED', 'ESP32_HARDWARE', or 'CSV_IMPORT'. Received '${String(rawDataSource ?? '')}'.`
    );
  }
  const derivedMode: OperatingMode = ds === 'SIMULATED' ? 'simulation' : 'hardware';
  if (rawMode !== undefined && rawMode !== null && rawMode !== '') {
    const modeStr = String(rawMode).trim().toLowerCase();
    if (modeStr !== 'simulation' && modeStr !== 'hardware') {
      throw new MLValidationError('INVALID_MODE', `mode must be 'simulation' or 'hardware'.`);
    }
    if (modeStr !== derivedMode) {
      throw new MLValidationError(
        'DATA_SOURCE_MODE_MISMATCH',
        `data_source '${ds}' requires mode='${derivedMode}', got mode='${modeStr}'. Synthetic, hardware, and CSV data must remain strictly separated.`
      );
    }
  }
  return { dataSource: ds, mode: derivedMode };
}

function parseClassificationFeatures(
  raw: unknown,
  requireAll: boolean
): Partial<ClassificationFeatures> {
  if (!raw || typeof raw !== 'object') {
    if (requireAll) {
      throw new MLValidationError(
        'MISSING_FEATURES',
        'features object with rssi, rssi_variation, packet_loss_ratio, ack_latency_ms, retry_count, and queue_depth is required.'
      );
    }
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const keys: Array<keyof ClassificationFeatures> = [
    'rssi',
    'rssi_variation',
    'packet_loss_ratio',
    'ack_latency_ms',
    'retry_count',
    'queue_depth',
  ];
  const out: Partial<ClassificationFeatures> = {};
  for (const k of keys) {
    if (obj[k] === undefined || obj[k] === null) {
      if (requireAll) {
        throw new MLValidationError('MISSING_FEATURE', `Missing required classification feature '${k}'.`);
      }
      continue;
    }
    const n = Number(obj[k]);
    if (!Number.isFinite(n)) {
      throw new MLValidationError('INVALID_FEATURE', `Feature '${k}' must be a finite number.`);
    }
    if (k === 'packet_loss_ratio' && (n < 0 || n > 1)) {
      throw new MLValidationError('INVALID_FEATURE', 'packet_loss_ratio must be between 0 and 1.');
    }
    if ((k === 'rssi_variation' || k === 'ack_latency_ms' || k === 'retry_count' || k === 'queue_depth') && n < 0) {
      throw new MLValidationError('INVALID_FEATURE', `Feature '${k}' cannot be negative.`);
    }
    out[k] = n;
  }
  return out;
}

function parseSchedulingFeatures(
  raw: unknown,
  requireAll: boolean
): Partial<SchedulingFeatures> {
  const base = parseClassificationFeatures(raw, requireAll);
  if (!raw || typeof raw !== 'object') return base;
  const obj = raw as Record<string, unknown>;
  const out: Partial<SchedulingFeatures> = { ...base };

  const extraKeys: Array<keyof Omit<SchedulingFeatures, keyof ClassificationFeatures>> = [
    'wifi_availability_history',
    'connection_duration',
    'hour',
    'day_of_week',
  ];

  for (const k of extraKeys) {
    if (obj[k] === undefined || obj[k] === null) {
      if (requireAll) {
        throw new MLValidationError('MISSING_FEATURE', `Missing required scheduling feature '${k}'.`);
      }
      continue;
    }
    const n = Number(obj[k]);
    if (!Number.isFinite(n)) {
      throw new MLValidationError('INVALID_FEATURE', `Feature '${k}' must be a finite number.`);
    }
    if (k === 'wifi_availability_history' && (n < 0 || n > 1)) {
      throw new MLValidationError('INVALID_FEATURE', 'wifi_availability_history must be between 0 and 1.');
    }
    if (k === 'connection_duration' && n < 0) {
      throw new MLValidationError('INVALID_FEATURE', 'connection_duration cannot be negative.');
    }
    if (k === 'hour' && (!Number.isInteger(n) || n < 0 || n > 23)) {
      throw new MLValidationError('INVALID_FEATURE', 'hour must be an integer between 0 and 23.');
    }
    if (k === 'day_of_week' && (!Number.isInteger(n) || n < 0 || n > 6)) {
      throw new MLValidationError('INVALID_FEATURE', 'day_of_week must be an integer between 0 and 6.');
    }
    out[k] = n;
  }
  return out;
}

interface RawMetricRow {
  id: number;
  mode: OperatingMode;
  link_hop: string;
  rssi: number;
  rssi_variation: number;
  rssi_source: string;
  packet_loss_ratio: number;
  ack_latency_ms: number;
  retry_count: number;
  queue_depth: number;
  link_mode: string;
  node2_to_node3_status: string;
  data_source: string;
  ml_features_complete?: number;
  recorded_at: string;
}

interface RawPredictionRow {
  id: number;
  mode: OperatingMode;
  link_hop: string;
  model_type: string;
  predicted_class: string;
  confidence: number;
  risk_score: number;
  baseline_class: string | null;
  predicted_wait_seconds: number | null;
  recommended_action: string | null;
  model_version: string | null;
  prediction_source: string;
  probabilities_json: string | null;
  data_source: string | null;
  prediction_timestamp: string | null;
  actual_wait_seconds: number | null;
  observation_censored: number;
  metric_id: number | null;
  features_json: string;
  model_status: string;
  created_at: string;
}

export function getMLSourceCounts(): Record<MLDataSource, { total: number; ml_ready: number }> {
  const counts: Record<MLDataSource, { total: number; ml_ready: number }> = {
    SIMULATED: { total: 0, ml_ready: 0 },
    ESP32_HARDWARE: { total: 0, ml_ready: 0 },
    CSV_IMPORT: { total: 0, ml_ready: 0 },
  };
  const rows = db
    .prepare(
      `
      SELECT data_source, COUNT(*) as total, SUM(CASE WHEN ml_features_complete = 1 THEN 1 ELSE 0 END) as ml_ready
      FROM network_metrics
      WHERE link_hop = 'NODE2_NODE3_WIFI'
        AND data_source IN ('SIMULATED', 'ESP32_HARDWARE', 'CSV_IMPORT')
      GROUP BY data_source
    `
    )
    .all() as Array<{ data_source: MLDataSource; total: number; ml_ready: number }>;

  for (const r of rows) {
    if (counts[r.data_source]) {
      counts[r.data_source] = {
        total: Number(r.total || 0),
        ml_ready: Number(r.ml_ready || 0),
      };
    }
  }
  return counts;
}

export function extractNode2WifiFeatures(
  mode: OperatingMode,
  limit = 60,
  explicitDataSource?: MLDataSource
): {
  mode: OperatingMode;
  data_source: MLDataSource;
  link_hop: typeof ML_TARGET_LINK;
  sample_count: number;
  raw_sample_count: number;
  source_counts: Record<MLDataSource, { total: number; ml_ready: number }>;
  sufficient_for_classification: boolean;
  sufficient_for_scheduling: boolean;
  min_scheduling_samples: number;
  latest_metric: RawMetricRow | null;
  classification_features: ClassificationFeatures | null;
  scheduling_features: SchedulingFeatures | null;
  scheduling_context: {
    current_link_state: string | null;
    availability_window_samples: number;
    day_of_week_convention: string;
    timezone: string;
  };
  recent_metrics: RawMetricRow[];
} {
  const expectedDataSource: MLDataSource =
    explicitDataSource ?? (mode === 'hardware' ? 'ESP32_HARDWARE' : 'SIMULATED');
  const effectiveMode: OperatingMode = expectedDataSource === 'SIMULATED' ? 'simulation' : 'hardware';
  const clampedLimit = Math.max(10, Math.min(200, Math.round(limit)));
  const sourceCounts = getMLSourceCounts();
  const rawSampleCount = sourceCounts[expectedDataSource]?.total ?? 0;

  // Strictly query ONLY NODE2_NODE3_WIFI rows with complete ML features for this exact data_source
  const rowsDesc = db
    .prepare(
      `
      SELECT * FROM network_metrics
      WHERE data_source = ? AND link_hop = 'NODE2_NODE3_WIFI' AND ml_features_complete = 1
      ORDER BY recorded_at DESC, id DESC LIMIT ?
    `
    )
    .all(expectedDataSource, clampedLimit) as unknown as RawMetricRow[];

  const totalMlReadyCount = sourceCounts[expectedDataSource]?.ml_ready ?? rowsDesc.length;
  const latest = rowsDesc[0] ?? null;
  const sufficientForClassification = totalMlReadyCount >= 1 && latest !== null;
  const sufficientForScheduling = totalMlReadyCount >= SCHEDULING_MIN_SAMPLES && latest !== null;

  const classificationFeatures: ClassificationFeatures | null = latest
    ? {
        rssi: latest.rssi,
        rssi_variation: latest.rssi_variation,
        packet_loss_ratio: latest.packet_loss_ratio,
        ack_latency_ms: latest.ack_latency_ms,
        retry_count: latest.retry_count,
        queue_depth: latest.queue_depth,
      }
    : null;

  let schedulingFeatures: SchedulingFeatures | null = null;
  let availabilityWindowSamples = 0;

  if (latest) {
    const windowRows = rowsDesc.slice(0, 20);
    availabilityWindowSamples = windowRows.length;
    const connectedCount = windowRows.filter(
      (r) => String(r.node2_to_node3_status).toUpperCase() === 'CONNECTED'
    ).length;
    const wifiAvailabilityHistory = Number((connectedCount / windowRows.length).toFixed(3));

    const currentState = String(latest.node2_to_node3_status).toUpperCase();
    let oldestSameStateIso = latest.recorded_at;
    for (let i = 1; i < rowsDesc.length; i++) {
      if (String(rowsDesc[i].node2_to_node3_status).toUpperCase() === currentState) {
        oldestSameStateIso = rowsDesc[i].recorded_at;
      } else {
        break;
      }
    }
    const latestMs = Date.parse(latest.recorded_at);
    const oldestMs = Date.parse(oldestSameStateIso);
    const connectionDurationSec =
      Number.isFinite(latestMs) && Number.isFinite(oldestMs)
        ? Number(Math.max(0, (latestMs - oldestMs) / 1000).toFixed(1))
        : 0;

    const dt = Number.isFinite(latestMs) ? new Date(latestMs) : new Date();
    const hour = dt.getUTCHours();
    // 0=Monday .. 6=Sunday matching Python datetime.weekday()
    const dayOfWeek = (dt.getUTCDay() + 6) % 7;

    schedulingFeatures = {
      rssi: latest.rssi,
      rssi_variation: latest.rssi_variation,
      packet_loss_ratio: latest.packet_loss_ratio,
      ack_latency_ms: latest.ack_latency_ms,
      retry_count: latest.retry_count,
      queue_depth: latest.queue_depth,
      wifi_availability_history: wifiAvailabilityHistory,
      connection_duration: connectionDurationSec,
      hour,
      day_of_week: dayOfWeek,
    };
  }

  return {
    mode: effectiveMode,
    data_source: expectedDataSource,
    link_hop: ML_TARGET_LINK,
    sample_count: totalMlReadyCount,
    raw_sample_count: rawSampleCount,
    source_counts: sourceCounts,
    sufficient_for_classification: sufficientForClassification,
    sufficient_for_scheduling: sufficientForScheduling,
    min_scheduling_samples: SCHEDULING_MIN_SAMPLES,
    latest_metric: latest,
    classification_features: classificationFeatures,
    scheduling_features: schedulingFeatures,
    scheduling_context: {
      current_link_state: latest ? String(latest.node2_to_node3_status).toUpperCase() : null,
      availability_window_samples: availabilityWindowSamples,
      day_of_week_convention: '0=Monday..6=Sunday (Python datetime.weekday)',
      timezone: 'UTC',
    },
    recent_metrics: [...rowsDesc].reverse(),
  };
}

export function ingestClassificationPrediction(
  body: Record<string, unknown>
): ClassificationPredictionRecord {
  validateTargetLink(body.link_hop);
  const { dataSource, mode } = validateDataSourceAndMode(body.data_source, body.mode);

  const rawStatus = body.prediction_status ? String(body.prediction_status).trim().toUpperCase() : 'READY';
  if (!ML_CLASSIFICATION_STATUSES.includes(rawStatus as ClassificationStatus)) {
    throw new MLValidationError(
      'INVALID_PREDICTION_STATUS',
      `prediction_status must be one of: ${ML_CLASSIFICATION_STATUSES.join(', ')}.`
    );
  }
  const predictionStatus = rawStatus as ClassificationStatus;

  const modelVersion = typeof body.model_version === 'string' ? body.model_version.trim() : '';
  if (!modelVersion) {
    throw new MLValidationError('MISSING_MODEL_VERSION', 'model_version is required.');
  }

  const predictionTimestamp = parseIsoTimestamp(
    body.prediction_timestamp ?? body.timestamp,
    'prediction_timestamp'
  );

  let predictedClass: NetworkQualityClass | null = null;
  let probabilities: Record<NetworkQualityClass, number> | null = null;
  let confidence = 0;
  let riskScore = 0;

  if (predictionStatus === 'READY') {
    const cls = typeof body.predicted_class === 'string' ? body.predicted_class.trim().toUpperCase() : '';
    if (!ML_CLASSIFICATION_CLASSES.includes(cls as NetworkQualityClass)) {
      throw new MLValidationError(
        'INVALID_PREDICTED_CLASS',
        `predicted_class must be GOOD, MODERATE, or POOR when prediction_status is READY.`
      );
    }
    predictedClass = cls as NetworkQualityClass;

    const rawProbs = body.probabilities as Record<string, unknown> | undefined;
    if (!rawProbs || typeof rawProbs !== 'object') {
      throw new MLValidationError(
        'MISSING_PROBABILITIES',
        'probabilities object with GOOD, MODERATE, and POOR probabilities is required when prediction_status is READY.'
      );
    }
    const pGood = Number(rawProbs.GOOD);
    const pMod = Number(rawProbs.MODERATE);
    const pPoor = Number(rawProbs.POOR);
    if (
      !Number.isFinite(pGood) ||
      !Number.isFinite(pMod) ||
      !Number.isFinite(pPoor) ||
      pGood < 0 ||
      pGood > 1 ||
      pMod < 0 ||
      pMod > 1 ||
      pPoor < 0 ||
      pPoor > 1
    ) {
      throw new MLValidationError(
        'INVALID_PROBABILITIES',
        'GOOD, MODERATE, and POOR probabilities must be finite numbers in [0, 1].'
      );
    }
    const sum = pGood + pMod + pPoor;
    if (sum < 0.98 || sum > 1.02) {
      throw new MLValidationError(
        'INVALID_PROBABILITIES_SUM',
        `Class probabilities must sum to ~1.0 (received sum=${sum.toFixed(4)}).`
      );
    }
    probabilities = {
      GOOD: Number(pGood.toFixed(4)),
      MODERATE: Number(pMod.toFixed(4)),
      POOR: Number(pPoor.toFixed(4)),
    };
    confidence = probabilities[predictedClass];
    riskScore = Math.min(100, Math.max(0, Math.round(probabilities.MODERATE * 45 + probabilities.POOR * 100)));
  } else {
    if (body.predicted_class !== undefined && body.predicted_class !== null) {
      throw new MLValidationError(
        'UNEXPECTED_PREDICTION_VALUE',
        `Do not supply predicted_class when prediction_status is '${predictionStatus}'.`
      );
    }
  }

  const features = parseClassificationFeatures(body.features, predictionStatus === 'READY');
  const metricId =
    body.metric_id !== undefined && body.metric_id !== null && Number.isInteger(Number(body.metric_id))
      ? Number(body.metric_id)
      : null;

  const now = new Date().toISOString();
  const storedClassCol = predictedClass ?? predictionStatus;

  const info = db
    .prepare(
      `
      INSERT INTO ml_predictions (
        mode, link_hop, model_type, predicted_class, confidence, risk_score,
        baseline_class, predicted_wait_seconds, recommended_action, model_version,
        prediction_source, probabilities_json, data_source, prediction_timestamp,
        actual_wait_seconds, observation_censored, metric_id, features_json, model_status, created_at
      ) VALUES (
        ?, 'NODE2_NODE3_WIFI', 'NETWORK_QUALITY', ?, ?, ?,
        NULL, NULL, NULL, ?,
        'EXTERNAL_ML', ?, ?, ?,
        NULL, 0, ?, ?, ?, ?
      )
    `
    )
    .run(
      mode,
      storedClassCol,
      confidence,
      riskScore,
      modelVersion,
      probabilities ? JSON.stringify(probabilities) : null,
      dataSource,
      predictionTimestamp,
      metricId,
      JSON.stringify(features),
      predictionStatus,
      now
    );

  setJsonSetting('ml_status_network_quality', {
    model_type: 'NETWORK_QUALITY',
    link_hop: ML_TARGET_LINK,
    status: predictionStatus === 'UNAVAILABLE' ? 'OFFLINE' : 'AVAILABLE',
    model_version: modelVersion,
    last_heartbeat_at: now,
  } satisfies ExternalModelHeartbeat);

  const inserted = db
    .prepare('SELECT * FROM ml_predictions WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as unknown as RawPredictionRow;

  return mapClassificationRow(inserted);
}

export function ingestSchedulingPrediction(
  body: Record<string, unknown>
): SchedulingPredictionRecord {
  validateTargetLink(body.link_hop);
  const { dataSource, mode } = validateDataSourceAndMode(body.data_source, body.mode);

  const rawStatus = body.prediction_status ? String(body.prediction_status).trim().toUpperCase() : 'READY';
  if (!ML_SCHEDULING_STATUSES.includes(rawStatus as SchedulingStatus)) {
    throw new MLValidationError(
      'INVALID_PREDICTION_STATUS',
      `prediction_status must be one of: ${ML_SCHEDULING_STATUSES.join(', ')}.`
    );
  }
  const predictionStatus = rawStatus as SchedulingStatus;

  const modelVersion = typeof body.model_version === 'string' ? body.model_version.trim() : '';
  if (!modelVersion) {
    throw new MLValidationError('MISSING_MODEL_VERSION', 'model_version is required.');
  }

  const predictionTimestamp = parseIsoTimestamp(
    body.prediction_timestamp ?? body.timestamp,
    'prediction_timestamp'
  );

  let predictedWaitSeconds: number | null = null;
  if (predictionStatus === 'READY') {
    const w = Number(body.predicted_wait_seconds);
    if (body.predicted_wait_seconds === undefined || body.predicted_wait_seconds === null || !Number.isFinite(w) || w < 0) {
      throw new MLValidationError(
        'INVALID_PREDICTED_WAIT_SECONDS',
        'predicted_wait_seconds must be a finite non-negative number when prediction_status is READY.'
      );
    }
    predictedWaitSeconds = Number(w.toFixed(2));
  } else {
    if (body.predicted_wait_seconds !== undefined && body.predicted_wait_seconds !== null) {
      throw new MLValidationError(
        'UNEXPECTED_PREDICTION_VALUE',
        `Do not supply numeric predicted_wait_seconds when prediction_status is '${predictionStatus}' (must be null/omitted).`
      );
    }
  }

  const observationCensored =
    predictionStatus === 'CENSORED' || body.observation_censored === true ? 1 : 0;

  let actualWaitSeconds: number | null = null;
  if (body.actual_wait_seconds !== undefined && body.actual_wait_seconds !== null) {
    if (observationCensored === 1) {
      throw new MLValidationError(
        'CENSORED_ACTUAL_CONFLICT',
        'actual_wait_seconds must be null when observation_censored is true.'
      );
    }
    const a = Number(body.actual_wait_seconds);
    if (!Number.isFinite(a) || a < 0) {
      throw new MLValidationError(
        'INVALID_ACTUAL_WAIT_SECONDS',
        'actual_wait_seconds must be a finite non-negative number when provided.'
      );
    }
    actualWaitSeconds = Number(a.toFixed(2));
  }

  const features = parseSchedulingFeatures(body.features, predictionStatus === 'READY');
  const recommendedAction =
    typeof body.recommended_action === 'string' && body.recommended_action.trim()
      ? body.recommended_action.trim().slice(0, 240)
      : null;

  const metricId =
    body.metric_id !== undefined && body.metric_id !== null && Number.isInteger(Number(body.metric_id))
      ? Number(body.metric_id)
      : null;

  const now = new Date().toISOString();

  const info = db
    .prepare(
      `
      INSERT INTO ml_predictions (
        mode, link_hop, model_type, predicted_class, confidence, risk_score,
        baseline_class, predicted_wait_seconds, recommended_action, model_version,
        prediction_source, probabilities_json, data_source, prediction_timestamp,
        actual_wait_seconds, observation_censored, metric_id, features_json, model_status, created_at
      ) VALUES (
        ?, 'NODE2_NODE3_WIFI', 'TRANSMISSION_SCHEDULING', ?, 0, 0,
        NULL, ?, ?, ?,
        'EXTERNAL_ML', NULL, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `
    )
    .run(
      mode,
      predictionStatus,
      predictedWaitSeconds,
      recommendedAction,
      modelVersion,
      dataSource,
      predictionTimestamp,
      actualWaitSeconds,
      observationCensored,
      metricId,
      JSON.stringify(features),
      predictionStatus,
      now
    );

  setJsonSetting('ml_status_transmission_scheduling', {
    model_type: 'TRANSMISSION_SCHEDULING',
    link_hop: ML_TARGET_LINK,
    status: predictionStatus === 'UNAVAILABLE' ? 'OFFLINE' : 'AVAILABLE',
    model_version: modelVersion,
    last_heartbeat_at: now,
  } satisfies ExternalModelHeartbeat);

  const inserted = db
    .prepare('SELECT * FROM ml_predictions WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as unknown as RawPredictionRow;

  return mapSchedulingRow(inserted);
}

/**
 * When NODE2_NODE3_WIFI transitions from DISCONNECTED back to CONNECTED,
 * resolve open uncensored scheduling predictions that were waiting for reconnection.
 */
export function resolveSchedulingObservationsOnReconnect(
  mode: OperatingMode,
  reconnectedAtIso: string
): number {
  const reconnectedMs = Date.parse(reconnectedAtIso);
  if (!Number.isFinite(reconnectedMs)) return 0;

  const openRows = db
    .prepare(
      `
      SELECT id, prediction_timestamp, created_at
      FROM ml_predictions
      WHERE mode = ?
        AND link_hop = 'NODE2_NODE3_WIFI'
        AND model_type = 'TRANSMISSION_SCHEDULING'
        AND prediction_source = 'EXTERNAL_ML'
        AND COALESCE(data_source, '') != 'CSV_IMPORT'
        AND model_status = 'READY'
        AND predicted_wait_seconds IS NOT NULL
        AND actual_wait_seconds IS NULL
        AND observation_censored = 0
      ORDER BY id DESC
      LIMIT 30
    `
    )
    .all(mode) as Array<{ id: number; prediction_timestamp: string | null; created_at: string }>;

  if (openRows.length === 0) return 0;

  const updateStmt = db.prepare(
    'UPDATE ml_predictions SET actual_wait_seconds = ? WHERE id = ?'
  );

  let updated = 0;
  for (const row of openRows) {
    const predMs = Date.parse(row.prediction_timestamp || row.created_at);
    if (!Number.isFinite(predMs) || predMs > reconnectedMs) continue;
    const waitSec = Number(((reconnectedMs - predMs) / 1000).toFixed(2));
    if (waitSec >= 0 && waitSec <= 7200) {
      updateStmt.run(waitSec, row.id);
      updated++;
    }
  }
  return updated;
}

export function ingestEvaluationMetrics(
  body: Record<string, unknown>
): ClassificationEvaluationMetrics | SchedulingEvaluationMetrics {
  validateTargetLink(body.link_hop);
  const { dataSource } = validateDataSourceAndMode(body.data_source, body.mode);

  const modelType = typeof body.model_type === 'string' ? body.model_type.trim().toUpperCase() : '';
  const modelVersion = typeof body.model_version === 'string' ? body.model_version.trim() : '';
  if (!modelVersion) {
    throw new MLValidationError('MISSING_MODEL_VERSION', 'model_version is required.');
  }
  const evaluatedAt = parseIsoTimestamp(body.evaluated_at ?? new Date().toISOString(), 'evaluated_at');
  const splitMethod =
    typeof body.split_method === 'string' && body.split_method.trim()
      ? body.split_method.trim()
      : 'Session-grouped holdout';
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;

  if (modelType === 'NETWORK_QUALITY') {
    const accuracy = Number(body.accuracy);
    const macroF1 = Number(body.macro_f1);
    const sampleCount = Math.round(Number(body.sample_count));
    if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1) {
      throw new MLValidationError('INVALID_EVALUATION', 'accuracy must be between 0 and 1.');
    }
    if (!Number.isFinite(macroF1) || macroF1 < 0 || macroF1 > 1) {
      throw new MLValidationError('INVALID_EVALUATION', 'macro_f1 must be between 0 and 1.');
    }
    if (!Number.isInteger(sampleCount) || sampleCount < 1) {
      throw new MLValidationError('INVALID_EVALUATION', 'sample_count must be a positive integer.');
    }

    const rawCm = body.confusion_matrix as Record<string, unknown> | number[][] | undefined;
    let matrix: number[][] | undefined;
    if (Array.isArray(rawCm)) {
      matrix = rawCm as number[][];
    } else if (rawCm && typeof rawCm === 'object' && Array.isArray(rawCm.matrix)) {
      matrix = rawCm.matrix as number[][];
    }
    if (
      !matrix ||
      matrix.length !== 3 ||
      matrix.some(
        (row) =>
          !Array.isArray(row) ||
          row.length !== 3 ||
          row.some((v) => !isFiniteNum(v) || v < 0 || !Number.isInteger(v))
      )
    ) {
      throw new MLValidationError(
        'INVALID_CONFUSION_MATRIX',
        'confusion_matrix must be a 3x3 integer matrix for [GOOD, MODERATE, POOR].'
      );
    }

    let perClass: ClassificationEvaluationMetrics['per_class'];
    if (body.per_class && typeof body.per_class === 'object') {
      const rawPc = body.per_class as Record<string, Record<string, unknown>>;
      const parsed: Partial<NonNullable<ClassificationEvaluationMetrics['per_class']>> = {};
      let valid = true;
      for (const cls of ML_CLASSIFICATION_CLASSES) {
        const item = rawPc[cls];
        if (!item || typeof item !== 'object') {
          valid = false;
          break;
        }
        const precision = Number(item.precision);
        const recall = Number(item.recall);
        const f1 = Number(item.f1);
        const support = Math.round(Number(item.support));
        if (
          !Number.isFinite(precision) || precision < 0 || precision > 1 ||
          !Number.isFinite(recall) || recall < 0 || recall > 1 ||
          !Number.isFinite(f1) || f1 < 0 || f1 > 1 ||
          !Number.isInteger(support) || support < 0
        ) {
          valid = false;
          break;
        }
        parsed[cls] = {
          precision: Number(precision.toFixed(4)),
          recall: Number(recall.toFixed(4)),
          f1: Number(f1.toFixed(4)),
          support,
        };
      }
      if (valid) {
        perClass = parsed as NonNullable<ClassificationEvaluationMetrics['per_class']>;
      }
    }

    const evalObj: ClassificationEvaluationMetrics = {
      model_type: 'NETWORK_QUALITY',
      link_hop: ML_TARGET_LINK,
      data_source: dataSource,
      model_version: modelVersion,
      accuracy: Number(accuracy.toFixed(4)),
      macro_f1: Number(macroF1.toFixed(4)),
      weighted_f1:
        body.weighted_f1 !== undefined && Number.isFinite(Number(body.weighted_f1))
          ? Number(Number(body.weighted_f1).toFixed(4))
          : undefined,
      confusion_matrix: {
        labels: ['GOOD', 'MODERATE', 'POOR'],
        matrix,
      },
      per_class: perClass,
      sample_count: sampleCount,
      split_method: splitMethod,
      evaluated_at: evaluatedAt,
      note,
    };

    setJsonSetting(`ml_eval_NETWORK_QUALITY_${dataSource}`, evalObj);
    return evalObj;
  }

  if (modelType === 'TRANSMISSION_SCHEDULING') {
    const mae = Number(body.mae);
    const rmse = Number(body.rmse);
    const sampleCount = Math.round(Number(body.sample_count));
    if (!Number.isFinite(mae) || mae < 0) {
      throw new MLValidationError('INVALID_EVALUATION', 'mae must be a finite non-negative number.');
    }
    if (!Number.isFinite(rmse) || rmse < 0) {
      throw new MLValidationError('INVALID_EVALUATION', 'rmse must be a finite non-negative number.');
    }
    if (!Number.isInteger(sampleCount) || sampleCount < 1) {
      throw new MLValidationError('INVALID_EVALUATION', 'sample_count must be a positive integer.');
    }

    const evalObj: SchedulingEvaluationMetrics = {
      model_type: 'TRANSMISSION_SCHEDULING',
      link_hop: ML_TARGET_LINK,
      data_source: dataSource,
      model_version: modelVersion,
      mae: Number(mae.toFixed(3)),
      rmse: Number(rmse.toFixed(3)),
      r2:
        body.r2 !== undefined && Number.isFinite(Number(body.r2))
          ? Number(Number(body.r2).toFixed(4))
          : undefined,
      sample_count: sampleCount,
      censored_count:
        body.censored_count !== undefined && Number.isInteger(Number(body.censored_count))
          ? Number(body.censored_count)
          : undefined,
      split_method: splitMethod,
      evaluated_at: evaluatedAt,
      note,
    };

    setJsonSetting(`ml_eval_TRANSMISSION_SCHEDULING_${dataSource}`, evalObj);
    return evalObj;
  }

  throw new MLValidationError(
    'INVALID_MODEL_TYPE',
    "model_type must be 'NETWORK_QUALITY' or 'TRANSMISSION_SCHEDULING'."
  );
}

export function updateModelStatus(body: Record<string, unknown>): ExternalModelHeartbeat {
  validateTargetLink(body.link_hop);
  const modelType = typeof body.model_type === 'string' ? body.model_type.trim().toUpperCase() : '';
  if (modelType !== 'NETWORK_QUALITY' && modelType !== 'TRANSMISSION_SCHEDULING') {
    throw new MLValidationError(
      'INVALID_MODEL_TYPE',
      "model_type must be 'NETWORK_QUALITY' or 'TRANSMISSION_SCHEDULING'."
    );
  }
  const status = typeof body.status === 'string' ? body.status.trim().toUpperCase() : 'AVAILABLE';
  if (status !== 'AVAILABLE' && status !== 'OFFLINE' && status !== 'DEGRADED') {
    throw new MLValidationError('INVALID_STATUS', "status must be 'AVAILABLE', 'OFFLINE', or 'DEGRADED'.");
  }
  const modelVersion =
    typeof body.model_version === 'string' && body.model_version.trim()
      ? body.model_version.trim()
      : 'unreported';

  const heartbeat: ExternalModelHeartbeat = {
    model_type: modelType,
    link_hop: ML_TARGET_LINK,
    status,
    model_version: modelVersion,
    last_heartbeat_at: new Date().toISOString(),
    service_name: typeof body.service_name === 'string' ? body.service_name.trim() : undefined,
    note: typeof body.note === 'string' ? body.note.trim() : undefined,
  };

  const settingKey =
    modelType === 'NETWORK_QUALITY'
      ? 'ml_status_network_quality'
      : 'ml_status_transmission_scheduling';
  setJsonSetting(settingKey, heartbeat);
  return heartbeat;
}

function mapClassificationRow(row: RawPredictionRow): ClassificationPredictionRecord {
  const isReady = row.model_status === 'READY' && ML_CLASSIFICATION_CLASSES.includes(row.predicted_class as NetworkQualityClass);
  let probs: Record<NetworkQualityClass, number> | null = null;
  if (isReady && row.probabilities_json) {
    try {
      const parsed = JSON.parse(row.probabilities_json) as Record<string, number>;
      if (isFiniteNum(parsed.GOOD) && isFiniteNum(parsed.MODERATE) && isFiniteNum(parsed.POOR)) {
        probs = {
          GOOD: parsed.GOOD,
          MODERATE: parsed.MODERATE,
          POOR: parsed.POOR,
        };
      }
    } catch {
      probs = null;
    }
  }
  let features: Partial<ClassificationFeatures> = {};
  try {
    features = JSON.parse(row.features_json || '{}') as Partial<ClassificationFeatures>;
  } catch {
    features = {};
  }

  return {
    id: row.id,
    mode: row.mode,
    link_hop: ML_TARGET_LINK,
    model_type: 'NETWORK_QUALITY',
    predicted_class: isReady ? (row.predicted_class as NetworkQualityClass) : null,
    probabilities: probs,
    confidence: isReady ? row.confidence : null,
    model_version: row.model_version || 'unreported',
    prediction_timestamp: row.prediction_timestamp || row.created_at,
    data_source:
      row.data_source === 'ESP32_HARDWARE' ||
      row.data_source === 'SIMULATED' ||
      row.data_source === 'CSV_IMPORT'
        ? row.data_source
        : row.mode === 'hardware'
          ? 'ESP32_HARDWARE'
          : 'SIMULATED',
    prediction_status: (ML_CLASSIFICATION_STATUSES.includes(row.model_status as ClassificationStatus)
      ? row.model_status
      : 'UNAVAILABLE') as ClassificationStatus,
    features,
    metric_id: row.metric_id ?? null,
    created_at: row.created_at,
  };
}

function mapSchedulingRow(row: RawPredictionRow): SchedulingPredictionRecord {
  const isReady = row.model_status === 'READY' && isFiniteNum(row.predicted_wait_seconds);
  let features: Partial<SchedulingFeatures> = {};
  try {
    features = JSON.parse(row.features_json || '{}') as Partial<SchedulingFeatures>;
  } catch {
    features = {};
  }

  return {
    id: row.id,
    mode: row.mode,
    link_hop: ML_TARGET_LINK,
    model_type: 'TRANSMISSION_SCHEDULING',
    predicted_wait_seconds: isReady ? row.predicted_wait_seconds : null,
    actual_wait_seconds: isFiniteNum(row.actual_wait_seconds) ? row.actual_wait_seconds : null,
    observation_censored: Boolean(row.observation_censored) || row.model_status === 'CENSORED',
    model_version: row.model_version || 'unreported',
    prediction_timestamp: row.prediction_timestamp || row.created_at,
    data_source:
      row.data_source === 'ESP32_HARDWARE' ||
      row.data_source === 'SIMULATED' ||
      row.data_source === 'CSV_IMPORT'
        ? row.data_source
        : row.mode === 'hardware'
          ? 'ESP32_HARDWARE'
          : 'SIMULATED',
    prediction_status: (ML_SCHEDULING_STATUSES.includes(row.model_status as SchedulingStatus)
      ? row.model_status
      : 'UNAVAILABLE') as SchedulingStatus,
    advisory_only: true,
    recommended_action: row.recommended_action ?? null,
    features,
    metric_id: row.metric_id ?? null,
    created_at: row.created_at,
  };
}

function evaluateAvailability(params: {
  enabled: boolean;
  sufficientData: boolean;
  minSamples: number;
  sampleCount: number;
  rawSampleCount: number;
  dataSource: MLDataSource;
  latestPredictionTimestamp: string | null;
  latestPredictionStatus: string | null;
  censored?: boolean;
  heartbeat: ExternalModelHeartbeat | null;
}): {
  availability: ModelAvailabilityState;
  is_stale: boolean;
  stale_reason: string | null;
  age_seconds: number | null;
} {
  if (!params.enabled) {
    return {
      availability: 'DISABLED',
      is_stale: false,
      stale_reason: 'Network ML advisory layer is disabled in settings.',
      age_seconds: null,
    };
  }

  if (!params.sufficientData) {
    const partialCsvNote =
      params.rawSampleCount > 0 && params.sampleCount === 0
        ? `Found ${params.rawSampleCount} ${params.dataSource} NODE2_NODE3_WIFI row(s), but they lack complete ML features (packet_loss_ratio, ack_latency_ms, retry_count, queue_depth).`
        : `Requires at least ${params.minSamples} ML-ready NODE2_NODE3_WIFI sample(s) for ${params.dataSource}; currently ${params.sampleCount}.`;
    return {
      availability: 'INSUFFICIENT_DATA',
      is_stale: false,
      stale_reason: partialCsvNote,
      age_seconds: null,
    };
  }

  if (params.heartbeat?.status === 'OFFLINE' && params.dataSource !== 'CSV_IMPORT') {
    return {
      availability: 'UNAVAILABLE',
      is_stale: false,
      stale_reason: 'External Python ML service reported OFFLINE.',
      age_seconds: null,
    };
  }

  if (!params.latestPredictionTimestamp) {
    return {
      availability: 'UNAVAILABLE',
      is_stale: false,
      stale_reason:
        params.dataSource === 'CSV_IMPORT'
          ? 'Sufficient CSV_IMPORT features are stored; awaiting Python Random Forest inference batch for CSV_IMPORT.'
          : 'No prediction received from external Python ML service yet.',
      age_seconds: null,
    };
  }

  const predMs = Date.parse(params.latestPredictionTimestamp);
  const ageSec = Number.isFinite(predMs)
    ? Math.max(0, Math.round((Date.now() - predMs) / 1000))
    : null;

  if (params.latestPredictionStatus === 'UNAVAILABLE') {
    return {
      availability: 'UNAVAILABLE',
      is_stale: false,
      stale_reason: 'External Python ML model reported UNAVAILABLE.',
      age_seconds: ageSec,
    };
  }

  if (params.latestPredictionStatus === 'INSUFFICIENT_DATA') {
    return {
      availability: 'INSUFFICIENT_DATA',
      is_stale: false,
      stale_reason: 'External Python ML model reported insufficient data.',
      age_seconds: ageSec,
    };
  }

  if (params.latestPredictionStatus === 'CENSORED' || params.censored) {
    return {
      availability: 'CENSORED',
      is_stale: false,
      stale_reason: 'Observation window is right-censored (no closed reconnection interval observed).',
      age_seconds: ageSec,
    };
  }

  // Offline CSV batches imported from earlier hardware captures should not expire after 60s
  const isOfflineBatch = params.dataSource === 'CSV_IMPORT';
  if (
    params.latestPredictionStatus === 'STALE' ||
    (!isOfflineBatch && ageSec !== null && ageSec > PREDICTION_STALE_SECONDS)
  ) {
    return {
      availability: 'STALE',
      is_stale: true,
      stale_reason:
        ageSec !== null
          ? `Latest prediction is ${ageSec}s old (exceeds ${PREDICTION_STALE_SECONDS}s freshness threshold).`
          : 'External Python ML model marked prediction as STALE.',
      age_seconds: ageSec,
    };
  }

  return {
    availability: 'AVAILABLE',
    is_stale: false,
    stale_reason: null,
    age_seconds: ageSec,
  };
}

export function getNetworkMLDashboardState(
  mode: OperatingMode,
  limit = 60,
  explicitDataSource?: MLDataSource
) {
  const settings = getSettings();
  const dataSource: MLDataSource =
    explicitDataSource ?? (mode === 'hardware' ? 'ESP32_HARDWARE' : 'SIMULATED');
  const effectiveMode: OperatingMode = dataSource === 'SIMULATED' ? 'simulation' : 'hardware';
  const clampedLimit = Math.max(10, Math.min(200, Math.round(limit)));
  const extracted = extractNode2WifiFeatures(effectiveMode, clampedLimit, dataSource);

  // Strictly query ONLY EXTERNAL_ML rows on NODE2_NODE3_WIFI for this exact data_source
  const clfRowsDesc = db
    .prepare(
      `
      SELECT * FROM ml_predictions
      WHERE link_hop = 'NODE2_NODE3_WIFI'
        AND model_type = 'NETWORK_QUALITY'
        AND prediction_source = 'EXTERNAL_ML'
        AND COALESCE(data_source, CASE WHEN mode = 'hardware' THEN 'ESP32_HARDWARE' ELSE 'SIMULATED' END) = ?
      ORDER BY id DESC LIMIT ?
    `
    )
    .all(dataSource, clampedLimit) as unknown as RawPredictionRow[];

  const schRowsDesc = db
    .prepare(
      `
      SELECT * FROM ml_predictions
      WHERE link_hop = 'NODE2_NODE3_WIFI'
        AND model_type = 'TRANSMISSION_SCHEDULING'
        AND prediction_source = 'EXTERNAL_ML'
        AND COALESCE(data_source, CASE WHEN mode = 'hardware' THEN 'ESP32_HARDWARE' ELSE 'SIMULATED' END) = ?
      ORDER BY id DESC LIMIT ?
    `
    )
    .all(dataSource, clampedLimit) as unknown as RawPredictionRow[];

  const clfHistory = clfRowsDesc.map(mapClassificationRow).reverse();
  const schHistory = schRowsDesc.map(mapSchedulingRow).reverse();

  const latestClf = clfRowsDesc[0] ? mapClassificationRow(clfRowsDesc[0]) : null;
  const latestSch = schRowsDesc[0] ? mapSchedulingRow(schRowsDesc[0]) : null;

  const clfHeartbeat = getJsonSetting<ExternalModelHeartbeat>('ml_status_network_quality');
  const schHeartbeat = getJsonSetting<ExternalModelHeartbeat>('ml_status_transmission_scheduling');

  // Evaluations are strictly separated by data_source (SIMULATED vs ESP32_HARDWARE vs CSV_IMPORT)
  const clfEval = getJsonSetting<ClassificationEvaluationMetrics>(
    `ml_eval_NETWORK_QUALITY_${dataSource}`
  );
  const schEval = getJsonSetting<SchedulingEvaluationMetrics>(
    `ml_eval_TRANSMISSION_SCHEDULING_${dataSource}`
  );

  const clfState = evaluateAvailability({
    enabled: settings.ml_network_enabled,
    sufficientData: extracted.sufficient_for_classification,
    minSamples: 1,
    sampleCount: extracted.sample_count,
    rawSampleCount: extracted.raw_sample_count,
    dataSource,
    latestPredictionTimestamp: latestClf?.prediction_timestamp ?? null,
    latestPredictionStatus: latestClf?.prediction_status ?? null,
    heartbeat: clfHeartbeat,
  });

  const schState = evaluateAvailability({
    enabled: settings.ml_network_enabled,
    sufficientData: extracted.sufficient_for_scheduling,
    minSamples: SCHEDULING_MIN_SAMPLES,
    sampleCount: extracted.sample_count,
    rawSampleCount: extracted.raw_sample_count,
    dataSource,
    latestPredictionTimestamp: latestSch?.prediction_timestamp ?? null,
    latestPredictionStatus: latestSch?.prediction_status ?? null,
    censored: latestSch?.observation_censored ?? false,
    heartbeat: schHeartbeat,
  });

  const actualVsPredicted = schHistory
    .filter((p) => p.predicted_wait_seconds !== null && p.actual_wait_seconds !== null)
    .map((p) => ({
      id: p.id,
      timestamp: p.prediction_timestamp,
      predicted_wait_seconds: p.predicted_wait_seconds as number,
      actual_wait_seconds: p.actual_wait_seconds as number,
      error_seconds: Number(
        Math.abs((p.actual_wait_seconds as number) - (p.predicted_wait_seconds as number)).toFixed(2)
      ),
      model_version: p.model_version,
    }));

  return {
    mode: effectiveMode,
    data_source: dataSource,
    target_link: ML_TARGET_LINK,
    enabled: settings.ml_network_enabled,
    advisory_notice:
      'Both Random Forest models operate exclusively on NODE2_NODE3_WIFI and are strictly advisory. Core Wi-Fi/LoRa fallback, AES-128-GCM verification, ACKs, retries, and LittleFS/microSD queues operate deterministically even when the external Python ML service is offline.',
    latest_features: extracted.latest_metric,
    classification_features: extracted.classification_features,
    scheduling_features: extracted.scheduling_features,
    scheduling_context: extracted.scheduling_context,
    sample_count: extracted.sample_count,
    raw_sample_count: extracted.raw_sample_count,
    source_counts: extracted.source_counts,
    classification: {
      model_type: 'NETWORK_QUALITY' as const,
      link_hop: ML_TARGET_LINK,
      availability: clfState.availability,
      is_stale: clfState.is_stale,
      stale_reason: clfState.stale_reason,
      insufficient_data: !extracted.sufficient_for_classification || latestClf?.prediction_status === 'INSUFFICIENT_DATA',
      age_seconds: clfState.age_seconds,
      model_version: latestClf?.model_version ?? clfHeartbeat?.model_version ?? null,
      prediction_timestamp: latestClf?.prediction_timestamp ?? null,
      data_source: dataSource,
      latest_prediction: latestClf,
      history: clfHistory,
      evaluation: clfEval,
      heartbeat: clfHeartbeat,
    },
    scheduling: {
      model_type: 'TRANSMISSION_SCHEDULING' as const,
      link_hop: ML_TARGET_LINK,
      advisory_only: true,
      availability: schState.availability,
      is_stale: schState.is_stale,
      stale_reason: schState.stale_reason,
      insufficient_data: !extracted.sufficient_for_scheduling || latestSch?.prediction_status === 'INSUFFICIENT_DATA',
      censored: latestSch?.observation_censored ?? false,
      age_seconds: schState.age_seconds,
      model_version: latestSch?.model_version ?? schHeartbeat?.model_version ?? null,
      prediction_timestamp: latestSch?.prediction_timestamp ?? null,
      data_source: dataSource,
      latest_prediction: latestSch,
      history: schHistory,
      actual_vs_predicted: actualVsPredicted,
      evaluation: schEval,
      heartbeat: schHeartbeat,
    },
  };
}
