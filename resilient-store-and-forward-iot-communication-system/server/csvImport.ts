import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { db, getSettings, withTransaction, type LinkHopId } from './database.ts';
import {
  extractNode2WifiFeatures,
  ingestClassificationPrediction,
  ingestSchedulingPrediction,
  ML_TARGET_LINK,
} from './mlNetwork.ts';
import { classifyRain } from './simulationEngine.ts';

const execFileAsync = promisify(execFile);

export const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_CSV_ROWS = 25000;
const ALLOWED_IMPORT_HOPS = new Set<LinkHopId>([
  'NODE1_NODE3_WIFI',
  'NODE1_NODE2_LORA',
  'NODE2_NODE3_WIFI',
]);
const ALLOWED_RSSI_SOURCES = new Set([
  'AP_STATION_RSSI',
  'PEER_TO_PEER_RSSI',
  'LORA_PKT_RSSI',
  'UNSPECIFIED',
]);

export class CsvImportError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: string[];

  constructor(code: string, message: string, statusCode = 400, details?: string[]) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface CsvImportBatchRecord {
  id: number;
  filename: string;
  record_type: 'network' | 'sensors' | 'combined';
  default_link_hop: LinkHopId;
  row_count: number;
  network_rows: number;
  sensor_rows: number;
  ml_ready_n2n3_count: number;
  min_recorded_at: string | null;
  max_recorded_at: string | null;
  uploaded_at: string;
}

export interface CsvImportResult {
  ok: true;
  batch: CsvImportBatchRecord;
  ml_inference: {
    triggered: boolean;
    classification_status: string;
    scheduling_status: string;
    note: string;
  };
}

/**
 * RFC-4180 CSV parser handling UTF-8 BOM, CRLF/LF newlines, quoted cells, and escaped quotes ("").
 */
export function parseCsvMatrix(rawText: string): string[][] {
  let text = rawText;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += ch;
      }
      continue;
    }

    if (ch === '"') {
      if (currentCell.length === 0) {
        inQuotes = true;
      } else {
        currentCell += ch;
      }
    } else if (ch === ',') {
      currentRow.push(currentCell);
      currentCell = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') {
        i++;
      }
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
    } else if (ch === '\n') {
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
    } else {
      currentCell += ch;
    }
  }

  if (inQuotes) {
    throw new CsvImportError('MALFORMED_CSV', 'Unclosed double-quoted field detected in CSV.');
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  // Strip completely empty trailing/blank lines
  return rows.filter((row) => row.some((cell) => cell.trim() !== ''));
}

function unescapeExportCell(raw: string): string {
  const trimmed = raw.trim();
  // Strip spreadsheet formula neutralization prefix (e.g., '-65 -> -65 from csvSafe())
  if (trimmed.length >= 2 && trimmed[0] === "'" && /^[=+\-@\t\r]/.test(trimmed[1])) {
    return trimmed.slice(1).trim();
  }
  return trimmed;
}

function normalizeHeader(h: string): string {
  return unescapeExportCell(h)
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function parseTimestampIso(raw: string): string | null {
  const cleaned = unescapeExportCell(raw);
  if (!cleaned) return null;
  // Reject bare integers like "12345" that Date.parse accepts unexpectedly in V8
  if (/^\d+$/.test(cleaned)) {
    const epoch = Number(cleaned);
    // Accept reasonable Unix seconds (~2015..2050) or milliseconds explicitly
    if (epoch >= 1_400_000_000 && epoch <= 2_600_000_000) {
      return new Date(epoch * 1000).toISOString();
    }
    if (epoch >= 1_400_000_000_000 && epoch <= 2_600_000_000_000) {
      return new Date(epoch).toISOString();
    }
    return null;
  }
  const ms = Date.parse(cleaned);
  if (!Number.isFinite(ms)) return null;
  const year = new Date(ms).getUTCFullYear();
  if (year < 2010 || year > 2100) return null;
  return new Date(ms).toISOString();
}

function parseOptionalNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = unescapeExportCell(raw);
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : Number.NaN;
}

function parseBoolFlag(raw: string | undefined, defaultVal: number): number | null {
  if (raw === undefined) return defaultVal;
  const cleaned = unescapeExportCell(raw).toLowerCase();
  if (cleaned === '') return defaultVal;
  if (cleaned === '1' || cleaned === 'true' || cleaned === 'yes') return 1;
  if (cleaned === '0' || cleaned === 'false' || cleaned === 'no') return 0;
  return null;
}

function sanitizeFilename(raw: string): string {
  const base = path.basename(raw || 'hardware_upload.csv')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 140);
  return base || 'hardware_upload.csv';
}

interface ParsedNetworkInsert {
  link_hop: 'NODE1_NODE3_WIFI' | 'NODE1_NODE2_LORA' | 'NODE2_NODE3_WIFI';
  rssi: number;
  rssi_variation: number | null;
  rssi_source: string;
  packet_loss_ratio: number;
  ack_latency_ms: number;
  retry_count: number;
  queue_depth: number;
  link_mode: string;
  node2_to_node3_status: string;
  ml_features_complete: number;
  recorded_at: string;
}

interface ParsedSensorInsert {
  node_id: string;
  temperature: number;
  humidity: number;
  rain_raw: number;
  rain_category: 'DRY' | 'NORMAL' | 'HEAVY';
  priority: number;
  authenticated: number;
  is_anomaly: number;
  anomaly_score: number;
  recorded_at: string;
}

export function listCsvImports(limit = 30): CsvImportBatchRecord[] {
  const clamped = Math.max(1, Math.min(100, Math.round(limit)));
  return db
    .prepare(
      `
      SELECT id, filename, record_type, default_link_hop, row_count, network_rows,
             sensor_rows, ml_ready_n2n3_count, min_recorded_at, max_recorded_at, uploaded_at
      FROM csv_imports
      ORDER BY id DESC
      LIMIT ?
    `
    )
    .all(clamped) as unknown as CsvImportBatchRecord[];
}

function resolveInferenceServiceOrigin(): string | null {
  const raw = (process.env.ML_INFERENCE_SERVICE_URL || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    ) {
      return parsed.origin;
    }
  } catch {
    return null;
  }
  return null;
}

async function callPythonInferenceNonBlocking(): Promise<CsvImportResult['ml_inference']> {
  const settings = getSettings();
  if (!settings.ml_network_enabled) {
    return {
      triggered: false,
      classification_status: 'DISABLED',
      scheduling_status: 'DISABLED',
      note: 'Network ML is turned off in settings; imported CSV rows stored without ML execution.',
    };
  }

  const extracted = extractNode2WifiFeatures('hardware', 60, 'CSV_IMPORT');
  if (!extracted.sufficient_for_classification || !extracted.latest_metric) {
    const msg =
      extracted.raw_sample_count > 0
        ? `Imported ${extracted.raw_sample_count} NODE2_NODE3_WIFI row(s), but required ML features (packet_loss_ratio, ack_latency_ms, retry_count, queue_depth) were missing.`
        : 'No ML-ready NODE2_NODE3_WIFI features found in CSV_IMPORT dataset.';
    return {
      triggered: false,
      classification_status: 'INSUFFICIENT_DATA',
      scheduling_status: 'INSUFFICIENT_DATA',
      note: msg,
    };
  }

  const latestMetricId = extracted.latest_metric.id;
  const recordedAt = extracted.latest_metric.recorded_at;
  const clfPayload = {
    link_hop: ML_TARGET_LINK,
    data_source: 'CSV_IMPORT',
    sample_count: extracted.sample_count,
    feature_timestamp: recordedAt,
    offline_batch: true,
    features: extracted.classification_features,
  };
  const schPayload = {
    link_hop: ML_TARGET_LINK,
    data_source: 'CSV_IMPORT',
    sample_count: extracted.sample_count,
    feature_timestamp: recordedAt,
    offline_batch: true,
    current_link_state: extracted.scheduling_context.current_link_state,
    features: extracted.scheduling_features,
  };

  let clfResp: Record<string, unknown> | null = null;
  let schResp: Record<string, unknown> | null = null;

  const serviceOrigin = resolveInferenceServiceOrigin();
  if (serviceOrigin) {
    try {
      const cRes = await fetch(`${serviceOrigin}/predict/classification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clfPayload),
        signal: AbortSignal.timeout(4000),
      });
      if (cRes.ok) {
        clfResp = (await cRes.json()) as Record<string, unknown>;
      }
      if (extracted.sufficient_for_scheduling) {
        const sRes = await fetch(`${serviceOrigin}/predict/scheduling`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(schPayload),
          signal: AbortSignal.timeout(4000),
        });
        if (sRes.ok) {
          schResp = (await sRes.json()) as Record<string, unknown>;
        }
      }
    } catch {
      clfResp = null;
      schResp = null;
    }
  }

  // Fallback to local /opt/ml_venv Python artifacts if present (dev/integrated hosts); skip cleanly if unavailable in Node-only production containers.
  if (!clfResp) {
    const venvPython = '/opt/ml_venv/bin/python';
    const serviceScript = path.resolve(process.cwd(), 'ml', 'inference_service.py');
    const clfArtifact = path.resolve(process.cwd(), 'ml', 'artifacts', 'network_quality', 'model_pipeline.joblib');

    if (fs.existsSync(venvPython) && fs.existsSync(serviceScript) && fs.existsSync(clfArtifact)) {
      try {
        const inlineRunner = [
          'import json, sys',
          `sys.path.insert(0, ${JSON.stringify(path.resolve(process.cwd(), 'ml'))})`,
          'from inference_service import NetworkMLInferenceService',
          'svc = NetworkMLInferenceService()',
          `clf_req = json.loads(${JSON.stringify(JSON.stringify(clfPayload))})`,
          `sch_req = json.loads(${JSON.stringify(JSON.stringify(schPayload))})`,
          'out = {"clf": svc.predict_classification(clf_req), "sch": svc.predict_scheduling(sch_req) if sch_req.get("sample_count", 0) >= 5 else None}',
          'print(json.dumps(out))',
        ].join('; ');

        const { stdout } = await execFileAsync(venvPython, ['-c', inlineRunner], {
          timeout: 8000,
          maxBuffer: 1024 * 1024,
        });
        const parsed = JSON.parse(stdout.trim()) as {
          clf?: Record<string, unknown>;
          sch?: Record<string, unknown> | null;
        };
        if (parsed.clf) clfResp = parsed.clf;
        if (parsed.sch) schResp = parsed.sch;
      } catch {
        clfResp = null;
        schResp = null;
      }
    }
  }

  if (!clfResp) {
    return {
      triggered: false,
      classification_status: 'UNAVAILABLE',
      scheduling_status: extracted.sufficient_for_scheduling ? 'UNAVAILABLE' : 'INSUFFICIENT_DATA',
      note: 'CSV features imported; Python RF inference service is offline/not present in this container (no fabricated predictions generated).',
    };
  }

  let savedClfStatus = String(clfResp.prediction_status || 'UNAVAILABLE');
  let savedSchStatus = extracted.sufficient_for_scheduling ? 'UNAVAILABLE' : 'INSUFFICIENT_DATA';

  try {
    const clfRecord = ingestClassificationPrediction({
      link_hop: ML_TARGET_LINK,
      mode: 'hardware',
      data_source: 'CSV_IMPORT',
      prediction_status: clfResp.prediction_status,
      predicted_class: clfResp.predicted_class,
      probabilities: clfResp.probabilities,
      model_version: clfResp.model_version,
      prediction_timestamp: clfResp.prediction_timestamp,
      metric_id: latestMetricId,
      features: clfResp.features ?? extracted.classification_features,
    });
    savedClfStatus = clfRecord.prediction_status;
  } catch {
    savedClfStatus = 'UNAVAILABLE';
  }

  if (schResp) {
    try {
      const schRecord = ingestSchedulingPrediction({
        link_hop: ML_TARGET_LINK,
        mode: 'hardware',
        data_source: 'CSV_IMPORT',
        prediction_status: schResp.prediction_status,
        predicted_wait_seconds: schResp.predicted_wait_seconds,
        observation_censored: schResp.observation_censored,
        recommended_action: schResp.recommended_action,
        model_version: schResp.model_version,
        prediction_timestamp: schResp.prediction_timestamp,
        metric_id: latestMetricId,
        features: schResp.features ?? extracted.scheduling_features,
      });
      savedSchStatus = schRecord.prediction_status;
    } catch {
      savedSchStatus = 'UNAVAILABLE';
    }
  }

  return {
    triggered: true,
    classification_status: savedClfStatus,
    scheduling_status: savedSchStatus,
    note: `Python Random Forest inference completed for CSV_IMPORT (CLF=${savedClfStatus}, SCH=${savedSchStatus}).`,
  };
}

export async function importHardwareCsv(params: {
  filename: unknown;
  csvText: unknown;
  defaultLinkHop?: unknown;
}): Promise<CsvImportResult> {
  if (typeof params.csvText !== 'string' || !params.csvText.trim()) {
    throw new CsvImportError('EMPTY_CSV', 'Uploaded CSV content cannot be empty.');
  }

  if (params.csvText.includes('\0')) {
    throw new CsvImportError('BINARY_NOT_ALLOWED', 'Binary or NUL-byte content is not a valid CSV file.');
  }

  const byteLen = Buffer.byteLength(params.csvText, 'utf8');
  if (byteLen > MAX_CSV_BYTES) {
    throw new CsvImportError(
      'CSV_TOO_LARGE',
      `CSV payload (${(byteLen / (1024 * 1024)).toFixed(2)} MB) exceeds the 5 MB limit.`
    );
  }

  const filename = sanitizeFilename(typeof params.filename === 'string' ? params.filename : 'hardware_upload.csv');
  const rawDefaultHop =
    typeof params.defaultLinkHop === 'string' && params.defaultLinkHop.trim()
      ? params.defaultLinkHop.trim().toUpperCase()
      : 'NODE2_NODE3_WIFI';

  if (!ALLOWED_IMPORT_HOPS.has(rawDefaultHop as LinkHopId)) {
    throw new CsvImportError(
      'INVALID_DEFAULT_LINK_HOP',
      `default_link_hop must be NODE1_NODE3_WIFI, NODE1_NODE2_LORA, or NODE2_NODE3_WIFI. Received '${rawDefaultHop}'.`
    );
  }
  const defaultLinkHop = rawDefaultHop as 'NODE1_NODE3_WIFI' | 'NODE1_NODE2_LORA' | 'NODE2_NODE3_WIFI';

  const matrix = parseCsvMatrix(params.csvText);
  if (matrix.length < 2) {
    throw new CsvImportError(
      'MISSING_ROWS',
      'CSV must include a header row and at least one data row.'
    );
  }

  const rawHeaders = matrix[0];
  const headers = rawHeaders.map(normalizeHeader);
  const dataRows = matrix.slice(1);

  if (dataRows.length > MAX_CSV_ROWS) {
    throw new CsvImportError(
      'TOO_MANY_ROWS',
      `CSV contains ${dataRows.length} rows, exceeding the maximum of ${MAX_CSV_ROWS} rows per import.`
    );
  }

  const colIndex = new Map<string, number>();
  headers.forEach((h, idx) => {
    if (h && !colIndex.has(h)) {
      colIndex.set(h, idx);
    }
  });

  const tsHeader = ['recorded_at', 'timestamp', 'created_at', 'time'].find((k) => colIndex.has(k));
  if (!tsHeader) {
    throw new CsvImportError(
      'MISSING_TIMESTAMP_COLUMN',
      'CSV must contain a timestamp column (recorded_at, timestamp, created_at, or time).'
    );
  }

  const hasNetworkCols = colIndex.has('rssi');
  const hasSensorCols =
    colIndex.has('temperature') && colIndex.has('humidity') && colIndex.has('rain_raw');
  const partialSensorAttempt =
    (colIndex.has('temperature') || colIndex.has('humidity') || colIndex.has('rain_raw')) &&
    !hasSensorCols;

  if (partialSensorAttempt && !hasNetworkCols) {
    throw new CsvImportError(
      'INCOMPLETE_SENSOR_HEADERS',
      'Sensor CSV requires temperature, humidity, rain_raw, and recorded_at/timestamp columns.'
    );
  }

  if (!hasNetworkCols && !hasSensorCols) {
    throw new CsvImportError(
      'UNRECOGNIZED_CSV_SCHEMA',
      'CSV must contain Network columns (rssi + timestamp) and/or Sensor columns (temperature, humidity, rain_raw + timestamp).'
    );
  }

  const normalizedHash = crypto
    .createHash('sha256')
    .update(params.csvText.replace(/\r\n/g, '\n').trim())
    .update(`|${defaultLinkHop}`)
    .digest('hex');

  const existingBatch = db
    .prepare('SELECT id, filename, uploaded_at FROM csv_imports WHERE file_sha256 = ?')
    .get(normalizedHash) as { id: number; filename: string; uploaded_at: string } | undefined;

  if (existingBatch) {
    throw new CsvImportError(
      'DUPLICATE_CSV_BATCH',
      `This exact CSV dataset was already imported as batch #${existingBatch.id} (${existingBatch.filename}).`
    );
  }

  const settings = getSettings();
  const networkInserts: ParsedNetworkInsert[] = [];
  const sensorInserts: ParsedSensorInsert[] = [];
  const errors: string[] = [];

  for (let i = 0; i < dataRows.length; i++) {
    const lineNum = i + 2; // 1-indexed including header
    const row = dataRows[i];

    const getCell = (key: string): string | undefined => {
      const idx = colIndex.get(key);
      return idx !== undefined ? row[idx] : undefined;
    };

    const rawTs = getCell(tsHeader) ?? '';
    const recordedAt = parseTimestampIso(rawTs);
    if (!recordedAt) {
      errors.push(`Row ${lineNum}: invalid or missing timestamp '${rawTs}'.`);
      if (errors.length >= 12) break;
      continue;
    }

    if (hasNetworkCols) {
      const rssi = parseOptionalNumber(getCell('rssi'));
      if (rssi === null || Number.isNaN(rssi) || rssi < -130 || rssi > 0) {
        errors.push(`Row ${lineNum}: rssi must be a finite number between -130 and 0 dBm.`);
        if (errors.length >= 12) break;
        continue;
      }

      const rawHopCell = unescapeExportCell(getCell('link_hop') ?? '');
      const linkHop = (rawHopCell ? rawHopCell.toUpperCase() : defaultLinkHop) as string;
      if (!ALLOWED_IMPORT_HOPS.has(linkHop as LinkHopId)) {
        errors.push(
          `Row ${lineNum}: invalid link_hop '${linkHop}' (allowed: NODE1_NODE3_WIFI, NODE1_NODE2_LORA, NODE2_NODE3_WIFI).`
        );
        if (errors.length >= 12) break;
        continue;
      }

      const rssiVar = parseOptionalNumber(getCell('rssi_variation'));
      if (rssiVar !== null && (Number.isNaN(rssiVar) || rssiVar < 0 || rssiVar > 100)) {
        errors.push(`Row ${lineNum}: rssi_variation must be between 0 and 100 dB.`);
        if (errors.length >= 12) break;
        continue;
      }

      const lossRatio = parseOptionalNumber(getCell('packet_loss_ratio'));
      if (lossRatio !== null && (Number.isNaN(lossRatio) || lossRatio < 0 || lossRatio > 1)) {
        errors.push(`Row ${lineNum}: packet_loss_ratio must be between 0 and 1.`);
        if (errors.length >= 12) break;
        continue;
      }

      const ackLatency = parseOptionalNumber(getCell('ack_latency_ms'));
      if (ackLatency !== null && (Number.isNaN(ackLatency) || ackLatency < 0 || ackLatency > 60000)) {
        errors.push(`Row ${lineNum}: ack_latency_ms must be between 0 and 60000 ms.`);
        if (errors.length >= 12) break;
        continue;
      }

      const retryCount = parseOptionalNumber(getCell('retry_count'));
      if (
        retryCount !== null &&
        (Number.isNaN(retryCount) || !Number.isInteger(retryCount) || retryCount < 0 || retryCount > 100)
      ) {
        errors.push(`Row ${lineNum}: retry_count must be an integer between 0 and 100.`);
        if (errors.length >= 12) break;
        continue;
      }

      const queueDepth = parseOptionalNumber(getCell('queue_depth'));
      if (
        queueDepth !== null &&
        (Number.isNaN(queueDepth) || !Number.isInteger(queueDepth) || queueDepth < 0 || queueDepth > 10000)
      ) {
        errors.push(`Row ${lineNum}: queue_depth must be an integer between 0 and 10000.`);
        if (errors.length >= 12) break;
        continue;
      }

      const rawRssiSource = unescapeExportCell(getCell('rssi_source') ?? '').toUpperCase();
      const rssiSource = rawRssiSource
        ? ALLOWED_RSSI_SOURCES.has(rawRssiSource)
          ? rawRssiSource
          : linkHop === 'NODE1_NODE2_LORA'
            ? 'LORA_PKT_RSSI'
            : 'UNSPECIFIED'
        : linkHop === 'NODE1_NODE2_LORA'
          ? 'LORA_PKT_RSSI'
          : 'UNSPECIFIED';

      const rawLinkMode = unescapeExportCell(getCell('link_mode') ?? '').toUpperCase();
      const linkMode =
        rawLinkMode === 'WIFI' || rawLinkMode === 'LORA' || rawLinkMode === 'OFFLINE'
          ? rawLinkMode
          : linkHop === 'NODE1_NODE2_LORA'
            ? 'LORA'
            : 'WIFI';

      const rawN2N3 = unescapeExportCell(getCell('node2_to_node3_status') ?? '').toUpperCase();
      const node2To3Status =
        rawN2N3 === 'CONNECTED' || rawN2N3 === 'DISCONNECTED' || rawN2N3 === 'RETRYING'
          ? rawN2N3
          : 'CONNECTED';

      // All 4 non-RSSI ML features must be explicitly present to treat row as ML-ready
      const mlComplete =
        lossRatio !== null && ackLatency !== null && retryCount !== null && queueDepth !== null
          ? 1
          : 0;

      networkInserts.push({
        link_hop: linkHop as 'NODE1_NODE3_WIFI' | 'NODE1_NODE2_LORA' | 'NODE2_NODE3_WIFI',
        rssi: Number(rssi.toFixed(2)),
        rssi_variation: rssiVar !== null ? Number(rssiVar.toFixed(2)) : null,
        rssi_source: rssiSource,
        packet_loss_ratio: lossRatio !== null ? Number(lossRatio.toFixed(4)) : 0,
        ack_latency_ms: ackLatency !== null ? Number(ackLatency.toFixed(2)) : 0,
        retry_count: retryCount ?? 0,
        queue_depth: queueDepth ?? 0,
        link_mode: linkMode,
        node2_to_node3_status: node2To3Status,
        ml_features_complete: mlComplete,
        recorded_at: recordedAt,
      });
    }

    if (hasSensorCols) {
      const temperature = parseOptionalNumber(getCell('temperature'));
      const humidity = parseOptionalNumber(getCell('humidity'));
      const rainRaw = parseOptionalNumber(getCell('rain_raw'));

      if (temperature === null || Number.isNaN(temperature) || temperature < -40 || temperature > 125) {
        errors.push(`Row ${lineNum}: temperature must be a finite number between -40 and 125 °C.`);
        if (errors.length >= 12) break;
        continue;
      }
      if (humidity === null || Number.isNaN(humidity) || humidity < 0 || humidity > 100) {
        errors.push(`Row ${lineNum}: humidity must be a finite number between 0 and 100 %.`);
        if (errors.length >= 12) break;
        continue;
      }
      if (
        rainRaw === null ||
        Number.isNaN(rainRaw) ||
        !Number.isInteger(rainRaw) ||
        rainRaw < 0 ||
        rainRaw > 4095
      ) {
        errors.push(`Row ${lineNum}: rain_raw must be an integer ADC reading between 0 and 4095.`);
        if (errors.length >= 12) break;
        continue;
      }

      const rawNodeId = unescapeExportCell(getCell('node_id') ?? '');
      const nodeId =
        rawNodeId && /^[A-Za-z0-9_-]{1,32}$/.test(rawNodeId) ? rawNodeId : 'NODE_3';

      const derived = classifyRain(
        rainRaw,
        settings.rain_normal_threshold,
        settings.rain_heavy_threshold
      );
      const rawCat = unescapeExportCell(getCell('rain_category') ?? '').toUpperCase();
      const rainCategory: 'DRY' | 'NORMAL' | 'HEAVY' =
        rawCat === 'DRY' || rawCat === 'NORMAL' || rawCat === 'HEAVY'
          ? rawCat
          : derived.category;

      const parsedPrio = parseOptionalNumber(getCell('priority'));
      const priority =
        parsedPrio !== null && Number.isInteger(parsedPrio) && parsedPrio >= 1 && parsedPrio <= 3
          ? parsedPrio
          : derived.priority;

      const authenticated = parseBoolFlag(getCell('authenticated'), 1);
      const isAnomaly = parseBoolFlag(getCell('is_anomaly'), 0);
      if (authenticated === null || isAnomaly === null) {
        errors.push(`Row ${lineNum}: authenticated / is_anomaly flags must be 0/1 or true/false.`);
        if (errors.length >= 12) break;
        continue;
      }

      const anomalyScore = parseOptionalNumber(getCell('anomaly_score'));
      if (anomalyScore !== null && (Number.isNaN(anomalyScore) || anomalyScore < 0)) {
        errors.push(`Row ${lineNum}: anomaly_score must be a non-negative finite number.`);
        if (errors.length >= 12) break;
        continue;
      }

      sensorInserts.push({
        node_id: nodeId,
        temperature: Number(temperature.toFixed(2)),
        humidity: Number(humidity.toFixed(2)),
        rain_raw: rainRaw,
        rain_category: rainCategory,
        priority,
        authenticated,
        is_anomaly: isAnomaly,
        anomaly_score: anomalyScore ?? 0,
        recorded_at: recordedAt,
      });
    }
  }

  if (errors.length > 0) {
    throw new CsvImportError(
      'CSV_VALIDATION_FAILED',
      `CSV validation failed (${errors.length} error${errors.length > 1 ? 's' : ''}): ${errors[0]}`,
      400,
      errors
    );
  }

  // Chronological sort within each series so lag-based rssi_variation & time charts are accurate
  networkInserts.sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
  sensorInserts.sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));

  const prevRssiByHop = new Map<string, number>();
  for (const item of networkInserts) {
    if (item.rssi_variation === null) {
      const prev = prevRssiByHop.get(item.link_hop);
      item.rssi_variation = prev !== undefined ? Number(Math.abs(item.rssi - prev).toFixed(2)) : 0;
    }
    prevRssiByHop.set(item.link_hop, item.rssi);
  }

  const allTimestamps = [
    ...networkInserts.map((r) => r.recorded_at),
    ...sensorInserts.map((r) => r.recorded_at),
  ].sort((a, b) => Date.parse(a) - Date.parse(b));

  const minRecordedAt = allTimestamps[0] ?? null;
  const maxRecordedAt = allTimestamps[allTimestamps.length - 1] ?? null;
  const mlReadyN2N3Count = networkInserts.filter(
    (r) => r.link_hop === 'NODE2_NODE3_WIFI' && r.ml_features_complete === 1
  ).length;

  const recordType: CsvImportBatchRecord['record_type'] =
    hasNetworkCols && hasSensorCols ? 'combined' : hasNetworkCols ? 'network' : 'sensors';

  const uploadedAt = new Date().toISOString();

  const batch = withTransaction(() => {
    const batchInfo = db
      .prepare(
        `
        INSERT INTO csv_imports (
          filename, record_type, default_link_hop, row_count, network_rows,
          sensor_rows, ml_ready_n2n3_count, file_sha256, min_recorded_at, max_recorded_at, uploaded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        filename,
        recordType,
        defaultLinkHop,
        dataRows.length,
        networkInserts.length,
        sensorInserts.length,
        mlReadyN2N3Count,
        normalizedHash,
        minRecordedAt,
        maxRecordedAt,
        uploadedAt
      );

    const batchId = Number(batchInfo.lastInsertRowid);

    const insertNet = db.prepare(
      `
      INSERT INTO network_metrics (
        mode, link_hop, rssi, rssi_variation, rssi_source, packet_loss_ratio, ack_latency_ms,
        retry_count, queue_depth, link_mode, node2_to_node3_status, data_source,
        import_batch_id, ml_features_complete, recorded_at
      ) VALUES ('hardware', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CSV_IMPORT', ?, ?, ?)
    `
    );

    for (const row of networkInserts) {
      insertNet.run(
        row.link_hop,
        row.rssi,
        row.rssi_variation ?? 0,
        row.rssi_source,
        row.packet_loss_ratio,
        row.ack_latency_ms,
        row.retry_count,
        row.queue_depth,
        row.link_mode,
        row.node2_to_node3_status,
        batchId,
        row.ml_features_complete,
        row.recorded_at
      );
    }

    const insertSensor = db.prepare(
      `
      INSERT INTO sensor_readings (
        mode, packet_id, node_id, temperature, humidity, rain_raw, rain_category,
        priority, authenticated, is_anomaly, anomaly_score, data_source, import_batch_id, recorded_at
      ) VALUES ('hardware', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CSV_IMPORT', ?, ?)
    `
    );

    for (const row of sensorInserts) {
      insertSensor.run(
        row.node_id,
        row.temperature,
        row.humidity,
        row.rain_raw,
        row.rain_category,
        row.priority,
        row.authenticated,
        row.is_anomaly,
        row.anomaly_score,
        batchId,
        row.recorded_at
      );
    }

    return {
      id: batchId,
      filename,
      record_type: recordType,
      default_link_hop: defaultLinkHop,
      row_count: dataRows.length,
      network_rows: networkInserts.length,
      sensor_rows: sensorInserts.length,
      ml_ready_n2n3_count: mlReadyN2N3Count,
      min_recorded_at: minRecordedAt,
      max_recorded_at: maxRecordedAt,
      uploaded_at: uploadedAt,
    } satisfies CsvImportBatchRecord;
  });

  // Ensure imported data is flushed to main database file for durability across restarts/redeploys
  try {
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } catch {
    // Non-fatal; WAL commits remain durable in -wal
  }

  const mlInference = await callPythonInferenceNonBlocking();

  return {
    ok: true,
    batch,
    ml_inference: mlInference,
  };
}
