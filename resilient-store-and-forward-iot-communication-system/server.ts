import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  db,
  DB_FILE_PATH,
  initializeDatabase,
  withTransaction,
  getSettings,
  updateSettings,
  getEffectiveMode,
  createAlert,
  logCommEvent,
  logSecurityEvent,
  canTransitionPacketStatus,
  getAllPersistedNonces,
  VALID_LINK_HOPS,
  VALID_ROUTE_PATHS,
  VALID_RSSI_SOURCES,
  VALID_DATA_SOURCES,
  type OperatingMode,
  type LinkHopId,
  type RssiSource,
  type DataSourceType,
} from './server/database.ts';
import { securityManager } from './server/securityManager.ts';
import {
  ML_DATA_SOURCES,
  MLValidationError,
  extractNode2WifiFeatures,
  getNetworkMLDashboardState,
  ingestClassificationPrediction,
  ingestEvaluationMetrics,
  ingestSchedulingPrediction,
  resolveSchedulingObservationsOnReconnect,
  updateModelStatus,
  type MLDataSource,
} from './server/mlNetwork.ts';
import {
  CsvImportError,
  importHardwareCsv,
  listCsvImports,
} from './server/csvImport.ts';
import { simulationEngine, classifyRain, PACKET_LOSS_WINDOW_SIZE } from './server/simulationEngine.ts';
import {
  ensureTestDefinitionsSeeded,
  getTestResults,
  runSystemTest,
  runAllSystemTests,
  resetTests,
} from './server/testManager.ts';

// Initialize SQLite schema, rehydrate persisted 96-bit nonces, seed tests, and start simulation loop
initializeDatabase();
securityManager.hydrateUsedNonces(getAllPersistedNonces());
ensureTestDefinitionsSeeded();
simulationEngine.startLoopIfRunning();

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Larger JSON parser exclusively for hardware CSV imports (up to 5 MB CSV payload)
app.post('/api/csv/upload', express.json({ limit: '6mb' }), async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await importHardwareCsv({
      filename: body.filename,
      csvText: body.csv_text ?? body.csvText ?? body.content,
      defaultLinkHop: body.default_link_hop ?? body.defaultLinkHop,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof CsvImportError) {
      res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        details: err.details,
      });
      return;
    }
    console.error('[CSV Import] Unexpected failure:', err);
    res.status(500).json({ error: 'Internal server error during CSV import.' });
  }
});

app.use(express.json({ limit: '1mb' }));

// Optional safe localhost-only proxy to standalone Python Flask backend (when FLASK_BACKEND_URL is explicitly configured to 127.0.0.1 / localhost)
const FLASK_URL_RAW = (process.env.FLASK_BACKEND_URL || '').trim();
let validatedFlaskOrigin: string | null = null;
if (FLASK_URL_RAW) {
  try {
    const parsed = new URL(FLASK_URL_RAW);
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    ) {
      validatedFlaskOrigin = parsed.origin;
    }
  } catch {
    validatedFlaskOrigin = null;
  }
}

if (validatedFlaskOrigin) {
  app.use('/api', async (req, res, next) => {
    try {
      const targetUrl = `${validatedFlaskOrigin}${req.originalUrl}`;
      const fetchInit: RequestInit = {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        fetchInit.body = JSON.stringify(req.body ?? {});
      }
      const upstream = await fetch(targetUrl, fetchInit);
      const contentType = upstream.headers.get('content-type') || 'application/json';
      const bodyText = await upstream.text();
      res.status(upstream.status).setHeader('Content-Type', contentType).send(bodyText);
    } catch {
      // Fallback to integrated local Express/SQLite server if standalone Flask isn't reachable
      next();
    }
  });
}

// Handle malformed JSON request bodies with HTTP 400
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Malformed JSON payload.' });
    return;
  }
  next(err);
});

// Safe strict-host CORS headers for ESP32 / local development / preview host
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      const isAllowedScheme = parsed.protocol === 'http:' || parsed.protocol === 'https:';
      const isAllowedHost =
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname.endsWith('.run.app');
      if (isAllowedScheme && isAllowedHost) {
        res.setHeader('Access-Control-Allow-Origin', parsed.origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Device-Id');
      }
    } catch {
      // ignore malformed Origin header
    }
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// CSV cell sanitization to prevent spreadsheet formula injection
function csvSafe(val: unknown): string {
  const raw = val === null || val === undefined ? '' : String(val);
  const neutralized = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

function toCsv(rows: Array<Record<string, unknown>>, headers: string[]): string {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvSafe(row[h])).join(','));
  }
  return lines.join('\n');
}

function computeHardwareNodeStatus(lastHeartbeat: string | null): 'ONLINE' | 'STALE_DATA' | 'OFFLINE' | 'NOT_CONNECTED' {
  if (!lastHeartbeat) return 'NOT_CONNECTED';
  const ageSec = (Date.now() - new Date(lastHeartbeat).getTime()) / 1000;
  if (ageSec <= 25) return 'ONLINE';
  if (ageSec <= 90) return 'STALE_DATA';
  return 'OFFLINE';
}

function safeNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const HARDWARE_LINK_HOPS = new Set<string>(['NODE1_NODE3_WIFI', 'NODE1_NODE2_LORA', 'NODE2_NODE3_WIFI']);
const HARDWARE_RSSI_SOURCES = new Set<string>(['AP_STATION_RSSI', 'PEER_TO_PEER_RSSI', 'LORA_PKT_RSSI', 'UNSPECIFIED']);

function buildMeasurementSpec(settings: ReturnType<typeof getSettings>) {
  return {
    target_ml_link: 'NODE2_NODE3_WIFI',
    links: ['NODE1_NODE3_WIFI', 'NODE1_NODE2_LORA', 'NODE2_NODE3_WIFI'],
    rssi_policy: {
      AP_STATION_RSSI:
        'WiFi.RSSI() reported by ESP32 STA connected through an external Wi-Fi Access Point / router. Reflects Node-to-AP RF signal, NOT peer-to-peer Node 2 <-> Node 3 RF.',
      PEER_TO_PEER_RSSI:
        'Direct peer RF RSSI measured ONLY when Node 2 communicates directly with Node 3 (e.g., ESP-NOW or SoftAP direct station RSSI). Never inferred from AP_STATION_RSSI.',
      LORA_PKT_RSSI: 'Packet-level LoRa radio RSSI measured on SX127x/RA-02 transceiver during Node 1 <-> Node 2 exchange.',
      SIMULATED_LINK_RSSI: 'Synthetic link RSSI generated exclusively in simulation mode.',
      UNSPECIFIED: 'Hardware metric submitted without an explicit rssi_source tag; never assumed to be peer-to-peer.',
    },
    rssi_variation_definition:
      'Absolute delta |RSSI_t - RSSI_{t-1}| (dB) or rolling window std-dev computed strictly within the same link_hop.',
    packet_loss_window_attempts: PACKET_LOSS_WINDOW_SIZE,
    packet_loss_formula:
      'failed_or_timed_out_attempts / min(total_attempts, 20) over the last 20 transmission attempts on that specific link_hop.',
    ack_timeout_ms: settings.ack_timeout_ms,
    retry_limit: settings.retry_limit,
    retry_counting_rule:
      'Monotonic per-packet retransmission counter incremented only on timeout/ACK-loss retries while retransmitting identical ciphertext, nonce, tag, and AAD.',
    matching_ack_latency_rule:
      't_ack_verified - t_tx_start (ms) recorded ONLY when ACK packet_id, sender_node, and receiver_node match the transmitted packet (NODE1_NODE3: 3->1; NODE1_NODE2: 2->1; NODE2_NODE3: 3->2). Mismatched ACKs are rejected.',
    queue_depth_definition:
      'Unacknowledged pending packets queued for that specific link (NODE2_NODE3_WIFI: Node 2 microSD node3_pending.log count; NODE1_NODE3_WIFI / NODE1_NODE2_LORA: Node 1 LittleFS pending count).',
  };
}

const DELIVERED_SQL_CLAUSE =
  "destination_status = 'DELIVERED' AND ((route_path = 'DIRECT_WIFI' AND node1_acked = 1) OR (route_path != 'DIRECT_WIFI' AND node2_acked = 1))";

// ============================================================================
// CORE HEALTH, STATUS, SETTINGS & NODES ENDPOINTS
// ============================================================================

app.get('/api/health', (_req, res) => {
  try {
    const row = db.prepare('SELECT 1 as ok').get() as { ok: number };
    const settings = getSettings();
    const mlState = getNetworkMLDashboardState(settings.active_mode, 10);
    res.json({
      status: 'HEALTHY',
      database: row.ok === 1 ? 'CONNECTED' : 'ERROR',
      database_file: path.basename(DB_FILE_PATH),
      active_mode: settings.active_mode,
      ml_network_status: mlState.classification.availability,
      ml_network_quality_status: mlState.classification.availability,
      ml_scheduling_status: mlState.scheduling.availability,
      security_algorithm: 'AES-128-GCM',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Health] Database check error:', err);
    res.status(500).json({ status: 'ERROR', error: 'Database health check failed.' });
  }
});

app.get('/api/settings', (_req, res) => {
  res.json({
    settings: getSettings(),
    security: securityManager.getPublicKeyMetadata(),
    hardware_ack_note:
      'Threshold settings update backend evaluation and simulation immediately. Physical ESP32 nodes apply changes only after firmware acknowledges configuration sync.',
  });
});

app.post('/api/settings', (req, res) => {
  const body = req.body as Record<string, unknown>;
  const updates: Record<string, unknown> = {};

  if (body.active_mode === 'simulation' || body.active_mode === 'hardware') {
    updates.active_mode = body.active_mode;
  }
  if (body.ack_timeout_ms !== undefined) {
    updates.ack_timeout_ms = Math.max(300, Math.min(15000, safeNumber(body.ack_timeout_ms, 1500)));
  }
  if (body.retry_limit !== undefined) {
    updates.retry_limit = Math.max(1, Math.min(10, Math.round(safeNumber(body.retry_limit, 3))));
  }
  if (body.hysteresis_good_samples !== undefined) {
    updates.hysteresis_good_samples = Math.max(1, Math.min(10, Math.round(safeNumber(body.hysteresis_good_samples, 3))));
  }
  if (body.hysteresis_bad_samples !== undefined) {
    updates.hysteresis_bad_samples = Math.max(1, Math.min(10, Math.round(safeNumber(body.hysteresis_bad_samples, 2))));
  }
  if (body.wifi_rssi_poor_threshold !== undefined) {
    updates.wifi_rssi_poor_threshold = Math.max(-105, Math.min(-45, safeNumber(body.wifi_rssi_poor_threshold, -78)));
  }
  if (body.wifi_loss_poor_threshold !== undefined) {
    updates.wifi_loss_poor_threshold = Math.max(0.05, Math.min(0.9, safeNumber(body.wifi_loss_poor_threshold, 0.25)));
  }
  if (body.wifi_latency_poor_threshold !== undefined) {
    updates.wifi_latency_poor_threshold = Math.max(50, Math.min(5000, safeNumber(body.wifi_latency_poor_threshold, 450)));
  }
  if (body.sampling_interval_ms !== undefined) {
    const val = Math.max(1200, Math.min(15000, Math.round(safeNumber(body.sampling_interval_ms, 3500))));
    updates.sampling_interval_ms = val;
    simulationEngine.setSpeed(val);
  }
  if (body.rain_normal_threshold !== undefined) {
    updates.rain_normal_threshold = Math.max(50, Math.min(800, Math.round(safeNumber(body.rain_normal_threshold, 350))));
  }
  if (body.rain_heavy_threshold !== undefined) {
    updates.rain_heavy_threshold = Math.max(200, Math.min(1000, Math.round(safeNumber(body.rain_heavy_threshold, 700))));
  }
  if (typeof body.ml_network_enabled === 'boolean') {
    updates.ml_network_enabled = body.ml_network_enabled;
  }

  const saved = updateSettings(updates);
  res.json({ ok: true, settings: saved });
});

app.get('/api/status', (req, res) => {
  const mode: OperatingMode = getEffectiveMode(req.query.mode);
  const settings = getSettings();

  const totalCreated = (
    db.prepare('SELECT COUNT(*) as c FROM packets WHERE mode = ?').get(mode) as { c: number }
  ).c;
  const receivedByNode2 = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM packets WHERE mode = ? AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')"
      )
      .get(mode) as { c: number }
  ).c;
  const deliveredToNode3 = (
    db
      .prepare(`SELECT COUNT(*) as c FROM packets WHERE mode = ? AND ${DELIVERED_SQL_CLAUSE}`)
      .get(mode) as { c: number }
  ).c;
  const deliveredDirectWifi = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM packets WHERE mode = ? AND route_path = 'DIRECT_WIFI' AND destination_status = 'DELIVERED' AND node1_acked = 1"
      )
      .get(mode) as { c: number }
  ).c;
  const deliveredViaGateway = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM packets WHERE mode = ? AND route_path != 'DIRECT_WIFI' AND destination_status = 'DELIVERED' AND node2_acked = 1"
      )
      .get(mode) as { c: number }
  ).c;
  const pendingNode1 = (
    db
      .prepare("SELECT COUNT(*) as c FROM packets WHERE mode = ? AND node1_acked = 0 AND destination_status != 'REJECTED'")
      .get(mode) as {
        c: number;
      }
  ).c;
  const pendingNode3 = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM packets WHERE mode = ? AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED') AND node2_acked = 0 AND destination_status != 'REJECTED'"
      )
      .get(mode) as { c: number }
  ).c;
  const duplicateCount = (
    db.prepare('SELECT COUNT(*) as c FROM packets WHERE mode = ? AND is_duplicate = 1').get(mode) as {
      c: number;
    }
  ).c;
  const failedAuthCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM packets WHERE mode = ? AND encryption_status = 'AUTH_FAILED'")
      .get(mode) as { c: number }
  ).c;
  const unreadAlerts = (
    db.prepare('SELECT COUNT(*) as c FROM system_alerts WHERE mode = ? AND is_read = 0').get(mode) as {
      c: number;
    }
  ).c;

  const nodesRaw = db
    .prepare('SELECT * FROM nodes WHERE mode = ? ORDER BY node_id ASC')
    .all(mode) as Array<{
    id: number;
    node_id: string;
    mode: string;
    name: string;
    role: string;
    status: string;
    link_mode: string;
    rssi: number | null;
    queue_count: number;
    storage_status: string;
    lcd_status: string | null;
    last_heartbeat: string | null;
    metadata_json: string;
    updated_at: string;
  }>;

  const nodes = nodesRaw.map((n) => {
    const computedStatus =
      mode === 'hardware'
        ? computeHardwareNodeStatus(n.last_heartbeat)
        : n.status;
    return {
      ...n,
      status: computedStatus,
      metadata: JSON.parse(String(n.metadata_json || '{}')) as Record<string, unknown>,
    };
  });

  const node1 = nodes.find((n) => n.node_id === 'NODE_1');
  const node2 = nodes.find((n) => n.node_id === 'NODE_2');
  const node3 = nodes.find((n) => n.node_id === 'NODE_3');

  const activeCommMode =
    mode === 'hardware' && node1?.status === 'NOT_CONNECTED'
      ? 'NOT_CONNECTED'
      : String(node1?.link_mode || 'OFFLINE');

  const node2To3Status =
    mode === 'hardware' && node3?.status === 'NOT_CONNECTED' && node2?.status === 'NOT_CONNECTED'
      ? 'NOT_CONNECTED'
      : String(node2?.metadata?.node3_link || 'DISCONNECTED');

  const simState = mode === 'simulation' ? simulationEngine.getState() : null;

  const latestByLink = (hop: LinkHopId) =>
    (db
      .prepare(
        "SELECT * FROM network_metrics WHERE mode = ? AND link_hop = ? AND data_source != 'CSV_IMPORT' ORDER BY id DESC LIMIT 1"
      )
      .get(mode, hop) as Record<string, unknown> | undefined) || null;

  const latestLink13 = latestByLink('NODE1_NODE3_WIFI');
  const latestLink12 = latestByLink('NODE1_NODE2_LORA');
  const latestLink23 = latestByLink('NODE2_NODE3_WIFI');

  const links = {
    node1_node3_wifi: {
      link_hop: 'NODE1_NODE3_WIFI',
      label: 'Node 1 → Node 3 (Direct Wi-Fi)',
      active: mode === 'simulation' ? Boolean(simState?.node1_wifi_on && simState?.wifi_healthy) : activeCommMode === 'WIFI',
      status:
        mode === 'simulation'
          ? simState?.node1_wifi_on
            ? simState.wifi_healthy
              ? 'CONNECTED'
              : 'DEGRADED'
            : 'OFFLINE'
          : node1?.status === 'NOT_CONNECTED'
            ? 'NOT_CONNECTED'
            : activeCommMode === 'WIFI'
              ? 'CONNECTED'
              : 'OFFLINE',
      latest_metric: latestLink13,
    },
    node1_node2_lora: {
      link_hop: 'NODE1_NODE2_LORA',
      label: 'Node 1 → Node 2 (LoRa Fallback)',
      active: mode === 'simulation' ? Boolean(!simState?.wifi_healthy && simState?.node1_lora_on) : activeCommMode === 'LORA',
      status:
        mode === 'simulation'
          ? simState?.node1_lora_on
            ? simState.node1_wifi_on && simState.wifi_healthy
              ? 'STANDBY'
              : 'ACTIVE_FALLBACK'
            : 'OFFLINE'
          : node1?.status === 'NOT_CONNECTED'
            ? 'NOT_CONNECTED'
            : activeCommMode === 'LORA'
              ? 'ACTIVE_FALLBACK'
              : 'STANDBY',
      latest_metric: latestLink12,
    },
    node2_node3_wifi: {
      link_hop: 'NODE2_NODE3_WIFI',
      label: 'Node 2 → Node 3 (Gateway Wi-Fi — ML Target)',
      active: mode === 'simulation' ? Boolean(simState?.node2_node3_wifi_on) : node2To3Status === 'CONNECTED',
      status:
        mode === 'simulation'
          ? simState?.node2_node3_wifi_on
            ? pendingNode3 > 0
              ? 'RETRYING'
              : 'CONNECTED'
            : 'DISCONNECTED'
          : node2To3Status,
      queue_depth: pendingNode3,
      latest_metric: latestLink23,
    },
  };

  let overallStatus = 'NOMINAL';
  if (mode === 'hardware' && nodes.every((n) => n.status === 'NOT_CONNECTED')) {
    overallStatus = 'AWAITING_HARDWARE';
  } else if (activeCommMode === 'OFFLINE' || (activeCommMode === 'LORA' && node2To3Status === 'DISCONNECTED')) {
    overallStatus = 'DEGRADED_STORE_AND_FORWARD';
  } else if (activeCommMode === 'LORA' || pendingNode1 + pendingNode3 > 0 || node2To3Status === 'DISCONNECTED') {
    overallStatus = 'FALLBACK_ACTIVE';
  }

  const latestMetric =
    latestLink23 ||
    (db
      .prepare(
        "SELECT * FROM network_metrics WHERE mode = ? AND data_source != 'CSV_IMPORT' ORDER BY id DESC LIMIT 1"
      )
      .get(mode) as Record<string, unknown> | undefined) ||
    null;

  const latestSensor = db
    .prepare(
      "SELECT * FROM sensor_readings WHERE mode = ? AND authenticated = 1 AND data_source != 'CSV_IMPORT' ORDER BY id DESC LIMIT 1"
    )
    .get(mode) as Record<string, unknown> | undefined;

  const prevSensor = db
    .prepare(
      "SELECT * FROM sensor_readings WHERE mode = ? AND authenticated = 1 AND data_source != 'CSV_IMPORT' ORDER BY id DESC LIMIT 1 OFFSET 1"
    )
    .get(mode) as Record<string, unknown> | undefined;

  res.json({
    mode,
    is_demo_mode: mode === 'simulation',
    timestamp: new Date().toISOString(),
    overall_status: overallStatus,
    active_comm_mode: activeCommMode,
    node2_to_node3_status: node2To3Status,
    links,
    summary: {
      total_created: totalCreated,
      received_by_node2: receivedByNode2,
      delivered_to_node3: deliveredToNode3,
      delivered_direct_wifi: deliveredDirectWifi,
      delivered_via_gateway: deliveredViaGateway,
      pending_packets: pendingNode1 + pendingNode3,
      pending_node1_littlefs: pendingNode1,
      pending_node2_microsd: pendingNode3,
      duplicate_packets: duplicateCount,
      failed_auth_count: failedAuthCount,
      unread_alerts: unreadAlerts,
    },
    nodes,
    latest_sensor: latestSensor || null,
    previous_sensor: prevSensor || null,
    latest_metric: latestMetric,
    simulation: simState,
    settings,
  });
});

app.get('/api/nodes', (req, res) => {
  const mode = getEffectiveMode(req.query.mode);
  const rows = db
    .prepare('SELECT * FROM nodes WHERE mode = ? ORDER BY node_id ASC')
    .all(mode) as Array<Record<string, unknown>>;

  const nodes = rows.map((n) => ({
    ...n,
    status:
      mode === 'hardware'
        ? computeHardwareNodeStatus(n.last_heartbeat as string | null)
        : n.status,
    metadata: JSON.parse(String(n.metadata_json || '{}')),
  }));

  res.json({ mode, nodes });
});

// ============================================================================
// SENSORS ENDPOINTS
// ============================================================================

app.get('/api/sensors/latest', (req, res) => {
  const mode = getEffectiveMode(req.query.mode);
  const latest = db
    .prepare(
      "SELECT * FROM sensor_readings WHERE mode = ? AND authenticated = 1 AND data_source != 'CSV_IMPORT' ORDER BY id DESC LIMIT 1"
    )
    .get(mode);
  const previous = db
    .prepare(
      "SELECT * FROM sensor_readings WHERE mode = ? AND authenticated = 1 AND data_source != 'CSV_IMPORT' ORDER BY id DESC LIMIT 1 OFFSET 1"
    )
    .get(mode);
  res.json({ mode, latest: latest || null, previous: previous || null });
});

app.get('/api/sensors/history', (req, res) => {
  const mode = getEffectiveMode(req.query.mode);
  const limit = Math.max(10, Math.min(500, safeNumber(req.query.limit, 100)));
  const rows = db
    .prepare(
      "SELECT * FROM sensor_readings WHERE mode = ? AND authenticated = 1 AND data_source != 'CSV_IMPORT' ORDER BY id DESC LIMIT ?"
    )
    .all(mode, limit) as Array<Record<string, unknown>>;
  res.json({ mode, readings: rows.reverse() });
});

// ============================================================================
// ESP32 LIVE HARDWARE INGESTION ENDPOINTS (Strict 'hardware' mode persistence)
// ============================================================================

app.post('/api/node1/sensor-data', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const now = new Date().toISOString();
  const rssi = b.rssi !== undefined ? safeNumber(b.rssi, -70) : null;
  const commMode = String(b.comm_mode || 'WIFI').toUpperCase();
  const queueCount = Math.max(0, Math.round(safeNumber(b.littlefs_queue_count, 0)));
  const retryCount = Math.max(0, Math.round(safeNumber(b.retry_count, 0)));

  db.prepare(`
    UPDATE nodes SET
      status = 'ONLINE', link_mode = ?, rssi = ?, queue_count = ?,
      storage_status = ?, last_heartbeat = ?, metadata_json = ?, updated_at = ?
    WHERE node_id = 'NODE_1' AND mode = 'hardware'
  `).run(
    commMode,
    rssi,
    queueCount,
    String(b.littlefs_status || 'MOUNTED'),
    now,
    JSON.stringify({
      board: String(b.board || 'ESP32 Node 1'),
      sensors: { dht11: 'REPORTED', raindrop: 'REPORTED' },
      wifi_status: String(b.wifi_status || (commMode === 'WIFI' ? 'CONNECTED' : 'DEGRADED')),
      lora_status: String(b.lora_status || (commMode === 'LORA' ? 'ACTIVE' : 'READY')),
      littlefs_status: String(b.littlefs_status || 'MOUNTED'),
      retry_count: retryCount,
      last_priority: b.priority ?? null,
    }),
    now
  );

  db.prepare(`
    UPDATE storage_status SET
      status = ?, pending_count = ?, sequence_counter = ?, storage_errors = ?, updated_at = ?
    WHERE mode = 'hardware' AND node_id = 'NODE_1'
  `).run(
    String(b.littlefs_status || 'MOUNTED'),
    queueCount,
    Math.max(0, Math.round(safeNumber(b.sequence_counter, 0))),
    Math.max(0, Math.round(safeNumber(b.storage_errors, 0))),
    now
  );

  res.status(201).json({ ok: true, mode: 'hardware', node: 'NODE_1', received_at: now });
});

function syncHardwareQueueCounts(now: string): void {
  const n1Pending = (
    db
      .prepare("SELECT COUNT(*) as c FROM packets WHERE mode = 'hardware' AND node1_acked = 0 AND destination_status != 'REJECTED'")
      .get() as { c: number }
  ).c;
  const n2Stored = (
    db
      .prepare("SELECT COUNT(*) as c FROM packets WHERE mode = 'hardware' AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')")
      .get() as { c: number }
  ).c;
  const n2Pending = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM packets WHERE mode = 'hardware' AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED') AND node2_acked = 0 AND destination_status != 'REJECTED'"
      )
      .get() as { c: number }
  ).c;
  const n3Stored = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM sensor_readings WHERE mode = 'hardware' AND authenticated = 1 AND data_source != 'CSV_IMPORT'"
      )
      .get() as { c: number }
  ).c;
  const n3MaxSeq = (
    db
      .prepare(
        "SELECT COALESCE(MAX(packet_id), 0) as m FROM sensor_readings WHERE mode = 'hardware' AND authenticated = 1 AND data_source != 'CSV_IMPORT'"
      )
      .get() as { m: number }
  ).m;
  const maxSeq = (
    db.prepare("SELECT COALESCE(MAX(sequence_number), 0) as m FROM packets WHERE mode = 'hardware'").get() as {
      m: number;
    }
  ).m;

  db.prepare("UPDATE nodes SET queue_count = ?, updated_at = ? WHERE node_id = 'NODE_1' AND mode = 'hardware'").run(
    n1Pending,
    now
  );
  db.prepare(
    "UPDATE storage_status SET pending_count = ?, stored_count = ?, sequence_counter = MAX(sequence_counter, ?), updated_at = ? WHERE mode = 'hardware' AND node_id = 'NODE_1'"
  ).run(n1Pending, n1Pending, maxSeq, now);

  db.prepare("UPDATE nodes SET queue_count = ?, updated_at = ? WHERE node_id = 'NODE_2' AND mode = 'hardware'").run(
    n2Pending,
    now
  );
  db.prepare(
    "UPDATE storage_status SET pending_count = ?, stored_count = ?, sequence_counter = MAX(sequence_counter, ?), updated_at = ? WHERE mode = 'hardware' AND node_id = 'NODE_2'"
  ).run(n2Pending, n2Stored, maxSeq, now);

  db.prepare(
    "UPDATE storage_status SET stored_count = MAX(stored_count, ?), sequence_counter = MAX(sequence_counter, ?), updated_at = ? WHERE mode = 'hardware' AND node_id = 'NODE_3'"
  ).run(n3Stored, n3MaxSeq, now);
}

app.post('/api/node1/packet', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const packetId = Math.round(safeNumber(b.packet_id, -1));
  if (!Number.isInteger(packetId) || packetId < 1 || !b.nonce || !b.ciphertext || !b.tag) {
    res.status(400).json({ error: 'Positive integer packet_id, nonce, ciphertext, and tag are required.' });
    return;
  }

  const version = Math.round(safeNumber(b.version, 1));
  const source = Math.round(safeNumber(b.source, 1));
  const destination = Math.round(safeNumber(b.destination, 3));
  const priority = Math.round(safeNumber(b.priority, 2));
  const seq = Math.round(safeNumber(b.sequence_number ?? packetId, packetId));

  if (priority !== 1 && priority !== 2) {
    res.status(400).json({ error: 'priority must be 1 (Heavy Rain) or 2 (Routine).' });
    return;
  }
  if (seq < 1 || source !== 1 || destination !== 3) {
    res.status(400).json({ error: 'Invalid packet routing metadata (expected source=1, destination=3, sequence_number>=1).' });
    return;
  }

  const nonceHex = String(b.nonce).trim().toLowerCase();
  const ciphertextHex = String(b.ciphertext).trim().toLowerCase();
  const tagHex = String(b.tag).trim().toLowerCase();
  const aad = String(b.aad || securityManager.buildAad(version, source, destination, packetId, priority));
  const keyVersion = String(b.key_version || 'v1');
  const commMode = String(b.comm_mode || 'WIFI').toUpperCase();
  const requestedRoute = b.route_path ? String(b.route_path).toUpperCase() : '';
  const routePath = (
    VALID_ROUTE_PATHS.includes(requestedRoute as (typeof VALID_ROUTE_PATHS)[number])
      ? requestedRoute
      : commMode === 'WIFI'
        ? 'DIRECT_WIFI'
        : commMode === 'LORA'
          ? 'LORA_GATEWAY'
          : 'LOCAL_QUEUE'
  );
  const initialGatewayStatus = routePath === 'DIRECT_WIFI' ? 'BYPASSED' : 'PENDING';
  const eventLinkHop = routePath === 'DIRECT_WIFI' ? 'NODE1_NODE3' : 'NODE1_NODE2';

  const formatCheck = securityManager.validateEnvelopeFormat({
    nonce: nonceHex,
    ciphertext: ciphertextHex,
    tag: tagHex,
    aad,
    version,
    source,
    destination,
    packet_id: packetId,
    priority,
  });
  if (!formatCheck.valid) {
    res.status(400).json({ error: `Invalid AES-128-GCM envelope format: ${formatCheck.error}` });
    return;
  }

  const now = new Date().toISOString();

  // Check for existing packet_id (retransmission vs illegal re-encryption)
  const existingById = db
    .prepare(
      "SELECT id, nonce, ciphertext, auth_tag, aad, retry_count FROM packets WHERE mode = 'hardware' AND packet_id = ?"
    )
    .get(packetId) as
    | { id: number; nonce: string; ciphertext: string; auth_tag: string; aad: string; retry_count: number }
    | undefined;

  if (existingById) {
    const identicalBytes =
      existingById.nonce.toLowerCase() === nonceHex &&
      existingById.ciphertext.toLowerCase() === ciphertextHex &&
      existingById.auth_tag.toLowerCase() === tagHex &&
      existingById.aad === aad;

    if (!identicalBytes) {
      withTransaction(() => {
        logSecurityEvent(
          'hardware',
          packetId,
          'ILLEGAL_REENCRYPTION',
          'NODE_1',
          'REJECTED',
          nonceHex,
          keyVersion,
          `Blocked illegal re-encryption of packet #${packetId}: retries must retransmit identical ciphertext, nonce, tag, and AAD.`
        );
        createAlert(
          'hardware',
          'CRITICAL',
          'PROTOCOL_VIOLATION',
          `Node 1 attempted to re-encrypt existing packet #${packetId} with altered bytes. Rejected to preserve AES-GCM retry invariants.`,
          'NODE_1'
        );
      });
      res.status(409).json({
        error: 'ILLEGAL_REENCRYPTION_DETECTED: Retries must retransmit the exact same encrypted packet bytes.',
      });
      return;
    }

    withTransaction(() => {
      db.prepare(`
        UPDATE packets SET
          comm_mode = ?,
          route_path = ?,
          gateway_status = CASE WHEN ? = 'DIRECT_WIFI' AND gateway_status = 'PENDING' THEN 'BYPASSED' ELSE gateway_status END,
          retry_count = retry_count + 1,
          overall_status = CASE WHEN overall_status IN ('DELIVERED', 'REJECTED') THEN overall_status ELSE 'RETRYING' END,
          updated_at = ?
        WHERE id = ?
      `).run(commMode, routePath, routePath, now, existingById.id);
      logCommEvent(
        'hardware',
        'RETRANSMISSION',
        eventLinkHop,
        commMode,
        packetId,
        `ESP32 Node 1 retransmitted identical ciphertext bytes for packet #${packetId} over ${routePath} (retry #${existingById.retry_count + 1}).`
      );
    });
    res.status(200).json({ ok: true, packet_id: packetId, mode: 'hardware', route_path: routePath, retransmission: true });
    return;
  }

  // Enforce global 96-bit nonce uniqueness across distinct packets in hardware mode
  const existingNonceOwner = db
    .prepare("SELECT packet_id FROM packets WHERE mode = 'hardware' AND LOWER(nonce) = ? LIMIT 1")
    .get(nonceHex) as { packet_id: number } | undefined;

  if (existingNonceOwner) {
    withTransaction(() => {
      logSecurityEvent(
        'hardware',
        packetId,
        'NONCE_REUSE_REJECTED',
        'NODE_1',
        'REJECTED',
        nonceHex,
        keyVersion,
        `Rejected packet #${packetId}: 96-bit AES-GCM nonce was already used by packet #${existingNonceOwner.packet_id}.`
      );
      createAlert(
        'hardware',
        'CRITICAL',
        'NONCE_COLLISION',
        `CRITICAL: Nonce reuse detected on packet #${packetId} (collides with packet #${existingNonceOwner.packet_id}). Packet rejected.`,
        'NODE_1'
      );
    });
    res.status(409).json({
      error: `NONCE_REUSE_DETECTED: 96-bit nonce already used by packet #${existingNonceOwner.packet_id}.`,
    });
    return;
  }

  withTransaction(() => {
    db.prepare(`
      INSERT INTO packets (
        mode, packet_id, sequence_number, protocol_version, source_node, destination_node,
        priority, comm_mode, route_path, encryption_status, gateway_status, destination_status,
        overall_status, retry_count, nonce, ciphertext, auth_tag, aad, key_version,
        is_duplicate, tampered, node1_acked, node2_acked, payload_preview_json, created_at, updated_at
      ) VALUES (
        'hardware', ?, ?, ?, ?, ?,
        ?, ?, ?, 'ENCRYPTED', ?, 'PENDING',
        ?, ?, ?, ?, ?, ?, ?,
        0, 0, 0, 0, NULL, ?, ?
      )
    `).run(
      packetId,
      seq,
      version,
      source,
      destination,
      priority,
      commMode,
      routePath,
      initialGatewayStatus,
      commMode === 'OFFLINE' ? 'PENDING' : 'TRANSMITTED',
      Math.max(0, Math.round(safeNumber(b.retry_count, 0))),
      nonceHex,
      ciphertextHex,
      tagHex,
      aad,
      keyVersion,
      now,
      now
    );

    securityManager.recordExternalNonce(nonceHex);

    db.prepare(`
      UPDATE nodes SET status = 'ONLINE', link_mode = ?, last_heartbeat = ?, updated_at = ?
      WHERE node_id = 'NODE_1' AND mode = 'hardware'
    `).run(commMode, now, now);

    syncHardwareQueueCounts(now);

    logCommEvent(
      'hardware',
      'PACKET_CREATED',
      eventLinkHop,
      commMode,
      packetId,
      routePath === 'DIRECT_WIFI'
        ? `ESP32 Node 1 created encrypted direct Wi-Fi packet #${packetId} (Node 2 bypassed; retained in LittleFS until direct Node 3 ACK).`
        : `ESP32 Node 1 created encrypted packet #${packetId} via ${routePath} (retained in LittleFS until matching ACK).`
    );
    logSecurityEvent('hardware', packetId, 'ENCRYPT', 'NODE_1', 'SUCCESS', nonceHex, keyVersion, `Node 1 reported AES-128-GCM encrypted packet #${packetId} with unique 96-bit nonce.`);
  });

  res.status(201).json({
    ok: true,
    packet_id: packetId,
    mode: 'hardware',
    route_path: routePath,
    gateway_status: initialGatewayStatus,
    node1_acked: 0,
  });
});

app.post('/api/node1/ack', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const packetId = Math.round(safeNumber(b.packet_id, -1));
  if (!Number.isInteger(packetId) || packetId < 1) {
    res.status(400).json({ error: 'Positive integer packet_id is required.' });
    return;
  }

  const pkt = db
    .prepare(
      "SELECT id, packet_id, route_path, comm_mode, encryption_status, gateway_status, destination_status, overall_status, node1_acked FROM packets WHERE mode = 'hardware' AND packet_id = ?"
    )
    .get(packetId) as
    | {
        id: number;
        packet_id: number;
        route_path: string;
        comm_mode: string;
        encryption_status: string;
        gateway_status: string;
        destination_status: string;
        overall_status: string;
        node1_acked: number;
      }
    | undefined;

  if (!pkt) {
    res.status(404).json({ error: `Cannot process Node 1 ACK: packet #${packetId} does not exist in hardware mode.` });
    return;
  }

  const now = new Date().toISOString();
  const requestedHop = b.link_hop ? String(b.link_hop).toUpperCase() : '';
  const isDirectWifi =
    requestedHop === 'NODE1_NODE3' ||
    (requestedHop === '' && (pkt.route_path === 'DIRECT_WIFI' || pkt.gateway_status === 'BYPASSED'));
  const expectedSender = isDirectWifi ? 3 : 2;
  const linkHop = isDirectWifi ? 'NODE1_NODE3' : 'NODE1_NODE2';
  const status = String(b.status || (isDirectWifi ? 'ACK_DELIVERED' : 'ACK_STORED')).toUpperCase();

  // Strict ACK mismatch verification (packet_id & sender_node)
  const ackPacketId = b.ack_packet_id !== undefined ? Math.round(safeNumber(b.ack_packet_id, -1)) : packetId;
  const senderNode = b.sender_node !== undefined ? Math.round(safeNumber(b.sender_node, expectedSender)) : expectedSender;
  if (ackPacketId !== packetId || senderNode !== expectedSender) {
    withTransaction(() => {
      db.prepare(`
        INSERT INTO acknowledgements (
          mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
        ) VALUES ('hardware', ?, ?, ?, 1, 'ACK_MISMATCH', ?, ?, 0, ?)
      `).run(
        packetId,
        linkHop,
        senderNode,
        `EXPECTED_PKT_${packetId}_FROM_NODE_${expectedSender}_GOT_PKT_${ackPacketId}_FROM_NODE_${senderNode}`,
        safeNumber(b.latency_ms, 0),
        now
      );
      logCommEvent(
        'hardware',
        'ACK_MISMATCH',
        linkHop,
        isDirectWifi ? 'WIFI' : 'LORA',
        packetId,
        `Rejected mismatched ACK at Node 1 for packet #${packetId}: got ack_packet_id=${ackPacketId}, sender_node=${senderNode} (expected packet #${packetId} from Node ${expectedSender}). Retained in LittleFS (node1_acked=0).`
      );
    });
    res.status(409).json({
      error: `ACK_MISMATCH: Expected ACK for packet #${packetId} from Node ${expectedSender}, received packet #${ackPacketId} from Node ${senderNode}.`,
      node1_acked: 0,
    });
    return;
  }

  const isSuccessAck =
    status === 'ACK_STORED' ||
    status === 'ACK_RECEIVED' ||
    status === 'ACK_DUPLICATE_RESENT' ||
    status === 'ACK_DELIVERED';

  if (isSuccessAck) {
    if (isDirectWifi) {
      if (pkt.encryption_status !== 'AUTHENTICATED' || pkt.overall_status === 'REJECTED') {
        res.status(409).json({
          error: `CANNOT_RETIRE_UNAUTHENTICATED_DIRECT_PACKET: Direct Wi-Fi packet #${packetId} has not been authenticated by Node 3 (encryption_status=${pkt.encryption_status}).`,
        });
        return;
      }
    } else if (pkt.gateway_status !== 'STORED' && pkt.gateway_status !== 'DUPLICATE_SUPPRESSED') {
      res.status(409).json({
        error: `CANNOT_RETIRE_UNSTORED_PACKET: LoRa fallback packet #${packetId} is not yet durably stored on Node 2 microSD (gateway_status=${pkt.gateway_status}).`,
      });
      return;
    }
  }

  withTransaction(() => {
    db.prepare(`
      INSERT INTO acknowledgements (
        mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
      ) VALUES ('hardware', ?, ?, ?, 1, ?, ?, ?, 1, ?)
    `).run(packetId, linkHop, expectedSender, status, b.error_code ? String(b.error_code) : null, safeNumber(b.latency_ms, 0), now);

    if (isSuccessAck) {
      if (isDirectWifi) {
        db.prepare(`
          UPDATE packets SET
            route_path = 'DIRECT_WIFI',
            gateway_status = 'BYPASSED',
            destination_status = 'DELIVERED',
            overall_status = 'DELIVERED',
            node1_acked = 1,
            node2_acked = 0,
            updated_at = ?
          WHERE id = ?
        `).run(now, pkt.id);
        logCommEvent(
          'hardware',
          'DELIVERED',
          'NODE1_NODE3',
          'WIFI',
          packetId,
          `Node 1 verified matching direct Node 3 ACK (${status}) for packet #${packetId} and retired LittleFS copy (Node 2 bypassed).`
        );
      } else {
        db.prepare(`
          UPDATE packets SET node1_acked = 1, updated_at = ?
          WHERE id = ?
        `).run(now, pkt.id);
        logCommEvent(
          'hardware',
          'ACK_RECEIVED',
          'NODE1_NODE2',
          'LORA',
          packetId,
          `Node 1 verified matching Stage-1 Node 2 gateway ACK (${status}) for packet #${packetId} and retired LittleFS copy.`
        );
      }
    } else {
      db.prepare(`
        UPDATE packets SET
          node1_acked = 0,
          retry_count = retry_count + 1,
          overall_status = CASE WHEN overall_status IN ('DELIVERED', 'REJECTED') THEN overall_status ELSE 'RETRYING' END,
          updated_at = ?
        WHERE id = ?
      `).run(now, pkt.id);
      logCommEvent(
        'hardware',
        'ACK_LOST',
        linkHop,
        isDirectWifi ? 'WIFI' : 'LORA',
        packetId,
        `ACK failure (${status}) on ${linkHop} for packet #${packetId}. Retained in Node 1 LittleFS (node1_acked=0).`
      );
    }

    db.prepare(`
      UPDATE nodes SET status = 'ONLINE', last_heartbeat = ?, updated_at = ?
      WHERE node_id = 'NODE_1' AND mode = 'hardware'
    `).run(now, now);

    syncHardwareQueueCounts(now);
  });

  res.status(201).json({ ok: true, packet_id: packetId, link_hop: linkHop, status, node1_acked: isSuccessAck ? 1 : 0 });
});

app.post('/api/node2/packet-received', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const packetId = Math.round(safeNumber(b.packet_id, -1));
  if (!Number.isInteger(packetId) || packetId < 1) {
    res.status(400).json({ error: 'Positive integer packet_id is required.' });
    return;
  }

  // Strict end-to-end encryption boundary: Node 2 Gateway NEVER decrypts or handles plaintext sensor readings
  if (
    b.temperature !== undefined ||
    b.humidity !== undefined ||
    b.rain_raw !== undefined ||
    b.plaintext !== undefined ||
    b.payload_preview_json !== undefined
  ) {
    res.status(400).json({
      error: 'NODE2_NO_DECRYPTION_POLICY: Node 2 gateway must only store & forward opaque AES-128-GCM ciphertext, never plaintext sensor readings.',
    });
    return;
  }

  const now = new Date().toISOString();
  const commMode = String(b.comm_mode || 'LORA').toUpperCase();
  const existing = db
    .prepare(
      "SELECT id, route_path, gateway_status, overall_status, nonce, ciphertext, auth_tag, aad FROM packets WHERE mode = 'hardware' AND packet_id = ?"
    )
    .get(packetId) as
    | {
        id: number;
        route_path: string;
        gateway_status: string;
        overall_status: string;
        nonce: string;
        ciphertext: string;
        auth_tag: string;
        aad: string;
      }
    | undefined;

  // Scenario A enforcement: Node 2 must NEVER receive, store, or forward direct Wi-Fi packets!
  if (existing && (existing.route_path === 'DIRECT_WIFI' || existing.gateway_status === 'BYPASSED')) {
    res.status(409).json({
      error: `DIRECT_WIFI_BYPASS_VIOLATION: Packet #${packetId} is a direct Node 1 → Node 3 Wi-Fi packet and must bypass Node 2 completely.`,
    });
    return;
  }

  // If Node 2 reports cryptographic envelope bytes for an existing packet, verify identical ciphertext retransmission
  if (existing && (b.nonce !== undefined || b.ciphertext !== undefined || b.tag !== undefined)) {
    const mismatch =
      (b.nonce !== undefined && String(b.nonce).trim().toLowerCase() !== existing.nonce.toLowerCase()) ||
      (b.ciphertext !== undefined && String(b.ciphertext).trim().toLowerCase() !== existing.ciphertext.toLowerCase()) ||
      (b.tag !== undefined && String(b.tag).trim().toLowerCase() !== existing.auth_tag.toLowerCase());
    if (mismatch) {
      res.status(409).json({
        error: `CIPHERTEXT_MISMATCH: Retransmitted packet #${packetId} at Node 2 does not match originally stored ciphertext/nonce/tag.`,
      });
      return;
    }
  }

  // If creating a new packet record directly from Node 2, require valid hex AES-128-GCM fields
  if (!existing) {
    const priority = Math.round(safeNumber(b.priority, 2));
    const version = Math.round(safeNumber(b.version, 1));
    const nonceHex = String(b.nonce || '').trim().toLowerCase();
    const ciphertextHex = String(b.ciphertext || '').trim().toLowerCase();
    const tagHex = String(b.tag || '').trim().toLowerCase();
    const aad = String(b.aad || securityManager.buildAad(version, 1, 3, packetId, priority));
    const formatCheck = securityManager.validateEnvelopeFormat({
      nonce: nonceHex,
      ciphertext: ciphertextHex,
      tag: tagHex,
      aad,
      version,
      source: 1,
      destination: 3,
      packet_id: packetId,
      priority,
    });
    if (!formatCheck.valid) {
      res.status(400).json({
        error: `Invalid or missing AES-128-GCM ciphertext envelope at Node 2: ${formatCheck.error}`,
      });
      return;
    }
    const nonceCollision = db
      .prepare("SELECT packet_id FROM packets WHERE mode = 'hardware' AND LOWER(nonce) = ? LIMIT 1")
      .get(nonceHex) as { packet_id: number } | undefined;
    if (nonceCollision) {
      res.status(409).json({
        error: `NONCE_REUSE_DETECTED: 96-bit nonce already used by packet #${nonceCollision.packet_id}.`,
      });
      return;
    }
  }

  let isDuplicate = false;
  withTransaction(() => {
    if (existing && (existing.gateway_status === 'STORED' || existing.gateway_status === 'DUPLICATE_SUPPRESSED')) {
      isDuplicate = true;
      db.prepare(`
        UPDATE packets SET route_path = 'LORA_GATEWAY', gateway_status = 'DUPLICATE_SUPPRESSED', is_duplicate = 1, retry_count = retry_count + 1, updated_at = ?
        WHERE id = ?
      `).run(now, existing.id);
      db.prepare(`
        INSERT INTO acknowledgements (
          mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
        ) VALUES ('hardware', ?, 'NODE1_NODE2', 2, 1, 'ACK_DUPLICATE_RESENT', NULL, ?, 1, ?)
      `).run(packetId, safeNumber(b.latency_ms, 0), now);
      logCommEvent('hardware', 'DUPLICATE_SUPPRESSED', 'NODE1_NODE2', commMode, packetId, `Node 2 detected duplicate LoRa packet #${packetId} on microSD; suppressed duplicate storage and emitted Stage-1 ACK_DUPLICATE_RESENT.`);
    } else if (existing) {
      db.prepare(`
        UPDATE packets SET comm_mode = ?, route_path = 'LORA_GATEWAY', gateway_status = 'STORED', overall_status = 'GATEWAY_STORED', updated_at = ?
        WHERE id = ?
      `).run(commMode, now, existing.id);
      logCommEvent('hardware', 'GATEWAY_STORED', 'NODE1_NODE2', commMode, packetId, `Node 2 durably stored opaque ciphertext #${packetId} on microSD via LoRa fallback (awaiting Node 1 ACK confirmation & Stage-2 forwarding).`);
    } else {
      const priority = Math.round(safeNumber(b.priority, 2));
      const version = Math.round(safeNumber(b.version, 1));
      const nonceHex = String(b.nonce).trim().toLowerCase();
      const ciphertextHex = String(b.ciphertext).trim().toLowerCase();
      const tagHex = String(b.tag).trim().toLowerCase();
      const aad = String(b.aad || securityManager.buildAad(version, 1, 3, packetId, priority));
      db.prepare(`
        INSERT INTO packets (
          mode, packet_id, sequence_number, protocol_version, source_node, destination_node,
          priority, comm_mode, route_path, encryption_status, gateway_status, destination_status,
          overall_status, retry_count, nonce, ciphertext, auth_tag, aad, key_version,
          is_duplicate, tampered, node1_acked, node2_acked, payload_preview_json, created_at, updated_at
        ) VALUES (
          'hardware', ?, ?, ?, 1, 3,
          ?, ?, 'LORA_GATEWAY', 'ENCRYPTED', 'STORED', 'PENDING',
          'GATEWAY_STORED', 0, ?, ?, ?, ?, ?,
          0, 0, 0, 0, NULL, ?, ?
        )
      `).run(
        packetId,
        Math.round(safeNumber(b.sequence_number ?? packetId, packetId)),
        version,
        priority,
        commMode,
        nonceHex,
        ciphertextHex,
        tagHex,
        aad,
        String(b.key_version || 'v1'),
        now,
        now
      );
      securityManager.recordExternalNonce(nonceHex);
      logCommEvent('hardware', 'GATEWAY_STORED', 'NODE1_NODE2', commMode, packetId, `Node 2 received LoRa fallback packet #${packetId} and stored opaque ciphertext on microSD (never decrypted).`);
    }

    db.prepare(`
      UPDATE nodes SET status = 'ONLINE', link_mode = 'LORA_FALLBACK', last_heartbeat = ?, updated_at = ?
      WHERE node_id = 'NODE_2' AND mode = 'hardware'
    `).run(now, now);

    syncHardwareQueueCounts(now);
  });

  res.status(201).json({
    ok: true,
    packet_id: packetId,
    route_path: 'LORA_GATEWAY',
    duplicate_suppressed: isDuplicate,
    gateway_ack_status: isDuplicate ? 'ACK_DUPLICATE_RESENT' : 'ACK_STORED',
  });
});

function ingestLinkMetric(
  linkHop: 'NODE1_NODE3_WIFI' | 'NODE1_NODE2_LORA' | 'NODE2_NODE3_WIFI',
  b: Record<string, unknown>,
  targetMode: OperatingMode = 'hardware',
  dataSource: 'ESP32_HARDWARE' | 'SIMULATED' = 'ESP32_HARDWARE'
): {
  ok: true;
  id: number;
  mode: OperatingMode;
  link_hop: string;
  rssi_source: string;
  data_source: 'ESP32_HARDWARE' | 'SIMULATED';
} {
  const now = new Date().toISOString();
  const rssi = safeNumber(b.rssi, linkHop === 'NODE1_NODE2_LORA' ? -95 : -70);
  const rssiVar = Math.max(0, safeNumber(b.rssi_variation, 0));
  const loss = Math.max(0, Math.min(1, safeNumber(b.packet_loss_ratio, 0)));
  const latency = Math.max(0, safeNumber(b.ack_latency_ms, 0));
  const retries = Math.max(0, Math.round(safeNumber(b.retry_count, 0)));
  const queueDepth = Math.max(0, Math.round(safeNumber(b.queue_depth, 0)));
  const linkMode = String(b.link_mode || (linkHop === 'NODE1_NODE2_LORA' ? 'LORA' : 'WIFI')).toUpperCase();
  const node2To3 = String(b.node2_to_node3_status || 'CONNECTED').toUpperCase();

  // Strictly distinguish AP_STATION_RSSI vs PEER_TO_PEER_RSSI vs LORA_PKT_RSSI; never fabricate PEER_TO_PEER_RSSI
  const rawRssiSource = b.rssi_source ? String(b.rssi_source).toUpperCase() : '';
  const rssiSource: RssiSource =
    dataSource === 'SIMULATED' && rawRssiSource === 'SIMULATED_LINK_RSSI'
      ? 'SIMULATED_LINK_RSSI'
      : HARDWARE_RSSI_SOURCES.has(rawRssiSource)
        ? (rawRssiSource as RssiSource)
        : linkHop === 'NODE1_NODE2_LORA'
          ? 'LORA_PKT_RSSI'
          : dataSource === 'SIMULATED'
            ? 'SIMULATED_LINK_RSSI'
            : 'UNSPECIFIED';

  const prevNode2Metric =
    linkHop === 'NODE2_NODE3_WIFI'
      ? (db
          .prepare(
            "SELECT node2_to_node3_status FROM network_metrics WHERE mode = ? AND link_hop = 'NODE2_NODE3_WIFI' ORDER BY id DESC LIMIT 1"
          )
          .get(targetMode) as { node2_to_node3_status: string } | undefined)
      : undefined;

  const insertInfo = db.prepare(`
    INSERT INTO network_metrics (
      mode, link_hop, rssi, rssi_variation, rssi_source, packet_loss_ratio, ack_latency_ms,
      retry_count, queue_depth, link_mode, node2_to_node3_status, data_source, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(targetMode, linkHop, rssi, rssiVar, rssiSource, loss, latency, retries, queueDepth, linkMode, node2To3, dataSource, now);

  if (linkHop === 'NODE2_NODE3_WIFI') {
    db.prepare(`
      UPDATE nodes SET status = 'ONLINE', rssi = ?, queue_count = ?, last_heartbeat = ?, updated_at = ?
      WHERE node_id = 'NODE_2' AND mode = ?
    `).run(rssi, queueDepth, now, now, targetMode);

    if (
      prevNode2Metric?.node2_to_node3_status === 'DISCONNECTED' &&
      node2To3 === 'CONNECTED'
    ) {
      resolveSchedulingObservationsOnReconnect(targetMode, now);
    }
  } else {
    db.prepare(`
      UPDATE nodes SET status = 'ONLINE', link_mode = ?, rssi = ?, last_heartbeat = ?, updated_at = ?
      WHERE node_id = 'NODE_1' AND mode = ?
    `).run(linkMode, rssi, now, now, targetMode);
  }

  return {
    ok: true,
    id: Number(insertInfo.lastInsertRowid),
    mode: targetMode,
    link_hop: linkHop,
    rssi_source: rssiSource,
    data_source: dataSource,
  };
}

app.post('/api/node2/network-metrics', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const requestedHop = b.link_hop ? String(b.link_hop).toUpperCase() : 'NODE2_NODE3_WIFI';
  if (requestedHop !== 'NODE2_NODE3_WIFI') {
    res.status(400).json({
      error: `LINK_SEPARATION_VIOLATION: /api/node2/network-metrics accepts ONLY link_hop='NODE2_NODE3_WIFI'. Use POST /api/network-metrics for '${requestedHop}'.`,
    });
    return;
  }
  const rawRssiSource = b.rssi_source ? String(b.rssi_source).toUpperCase() : '';
  if (rawRssiSource && !HARDWARE_RSSI_SOURCES.has(rawRssiSource)) {
    res.status(400).json({
      error: `Invalid rssi_source '${rawRssiSource}'. Allowed hardware values: AP_STATION_RSSI, PEER_TO_PEER_RSSI, LORA_PKT_RSSI, UNSPECIFIED.`,
    });
    return;
  }
  const result = ingestLinkMetric('NODE2_NODE3_WIFI', b, 'hardware', 'ESP32_HARDWARE');
  res.status(201).json(result);
});

app.post('/api/network-metrics', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const linkHop = String(b.link_hop || '').toUpperCase();
  if (!HARDWARE_LINK_HOPS.has(linkHop)) {
    res.status(400).json({
      error: `Valid link_hop is required: NODE1_NODE3_WIFI, NODE1_NODE2_LORA, or NODE2_NODE3_WIFI.`,
    });
    return;
  }
  const targetMode: OperatingMode =
    b.mode === 'simulation' ? 'simulation' : 'hardware';
  const rawDs = b.data_source ? String(b.data_source).trim().toUpperCase() : '';
  const expectedDs = targetMode === 'simulation' ? 'SIMULATED' : 'ESP32_HARDWARE';
  if (rawDs && rawDs !== expectedDs) {
    res.status(400).json({
      error: `DATA_SOURCE_MODE_MISMATCH: mode='${targetMode}' requires data_source='${expectedDs}', got '${rawDs}'.`,
    });
    return;
  }
  const rawRssiSource = b.rssi_source ? String(b.rssi_source).toUpperCase() : '';
  if (
    rawRssiSource &&
    !HARDWARE_RSSI_SOURCES.has(rawRssiSource) &&
    !(targetMode === 'simulation' && rawRssiSource === 'SIMULATED_LINK_RSSI')
  ) {
    res.status(400).json({
      error: `Invalid rssi_source '${rawRssiSource}'.`,
    });
    return;
  }
  const result = ingestLinkMetric(
    linkHop as 'NODE1_NODE3_WIFI' | 'NODE1_NODE2_LORA' | 'NODE2_NODE3_WIFI',
    b,
    targetMode,
    expectedDs
  );
  res.status(201).json(result);
});

app.post('/api/node2/storage-status', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const now = new Date().toISOString();
  const status = String(b.status || 'MOUNTED');
  const pending = Math.max(0, Math.round(safeNumber(b.pending_count, 0)));
  const stored = Math.max(0, Math.round(safeNumber(b.stored_count, 0)));
  const errors = Math.max(0, Math.round(safeNumber(b.storage_errors, 0)));

  db.prepare(`
    UPDATE storage_status SET
      status = ?, capacity_gb = ?, pending_count = ?, stored_count = ?, storage_errors = ?, updated_at = ?
    WHERE mode = 'hardware' AND node_id = 'NODE_2'
  `).run(status, safeNumber(b.capacity_gb, 16.0), pending, stored, errors, now);

  db.prepare(`
    UPDATE nodes SET status = 'ONLINE', storage_status = ?, queue_count = ?, last_heartbeat = ?, updated_at = ?
    WHERE node_id = 'NODE_2' AND mode = 'hardware'
  `).run(status, pending, now, now);

  if (errors > 0 || status === 'ERROR') {
    createAlert('hardware', 'CRITICAL', 'STORAGE_ERROR', `Node 2 microSD reported storage error (status=${status}, errors=${errors}).`, 'NODE_2');
  }

  res.status(201).json({ ok: true, mode: 'hardware', node: 'NODE_2', status });
});

app.post('/api/node3/storage-status', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const now = new Date().toISOString();
  const status = String(b.status || 'MOUNTED');
  const pending = Math.max(0, Math.round(safeNumber(b.pending_count, 0)));
  const stored = Math.max(0, Math.round(safeNumber(b.stored_count, 0)));
  const seqCounter = Math.max(0, Math.round(safeNumber(b.sequence_counter, 0)));
  const errors = Math.max(0, Math.round(safeNumber(b.storage_errors, 0)));
  const files = Array.isArray(b.files) ? b.files.map((f) => String(f)).slice(0, 50) : null;

  db.prepare(`
    UPDATE storage_status SET
      status = ?,
      capacity_gb = ?,
      pending_count = ?,
      stored_count = ?,
      sequence_counter = MAX(sequence_counter, ?),
      storage_errors = ?,
      files_json = COALESCE(?, files_json),
      updated_at = ?
    WHERE mode = 'hardware' AND node_id = 'NODE_3'
  `).run(
    status,
    safeNumber(b.capacity_gb, 0.004),
    pending,
    stored,
    seqCounter,
    errors,
    files ? JSON.stringify(files) : null,
    now
  );

  db.prepare(`
    UPDATE nodes SET status = 'ONLINE', storage_status = ?, last_heartbeat = ?, updated_at = ?
    WHERE node_id = 'NODE_3' AND mode = 'hardware'
  `).run(status, now, now);

  if (errors > 0 || status === 'ERROR') {
    createAlert('hardware', 'CRITICAL', 'STORAGE_ERROR', `Node 3 LittleFS reported storage error (status=${status}, errors=${errors}).`, 'NODE_3');
  }

  res.status(201).json({ ok: true, mode: 'hardware', node: 'NODE_3', storage_type: 'LittleFS', status });
});

app.post('/api/node2/forward', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const packetId = Math.round(safeNumber(b.packet_id, -1));
  if (!Number.isInteger(packetId) || packetId < 1) {
    res.status(400).json({ error: 'Positive integer packet_id is required.' });
    return;
  }
  const now = new Date().toISOString();
  const status = String(b.status || 'FORWARDED').toUpperCase();
  const targetOverall = status === 'FORWARDED' ? 'FORWARDED' : status === 'RETRYING' ? 'RETRYING' : 'GATEWAY_STORED';

  const existing = db
    .prepare("SELECT overall_status, gateway_status FROM packets WHERE mode = 'hardware' AND packet_id = ?")
    .get(packetId) as { overall_status: string; gateway_status: string } | undefined;

  if (!existing) {
    res.status(404).json({ error: `Packet #${packetId} not found in hardware mode.` });
    return;
  }

  if (existing.gateway_status !== 'STORED' && existing.gateway_status !== 'DUPLICATE_SUPPRESSED') {
    res.status(409).json({
      error: `Packet #${packetId} cannot be forwarded before durable microSD storage (gateway_status=${existing.gateway_status}).`,
    });
    return;
  }

  if (!canTransitionPacketStatus(existing.overall_status, targetOverall)) {
    res.status(409).json({
      error: `Invalid packet state transition from ${existing.overall_status} to ${targetOverall}.`,
    });
    return;
  }

  db.prepare(`
    UPDATE packets SET destination_status = ?, overall_status = ?, updated_at = ?
    WHERE mode = 'hardware' AND packet_id = ? AND destination_status NOT IN ('DELIVERED', 'REJECTED')
  `).run(status, targetOverall, now, packetId);

  logCommEvent('hardware', 'FORWARD_ATTEMPT', 'NODE2_NODE3', 'WIFI', packetId, `Node 2 forwarded opaque ciphertext #${packetId} to Node 3 (status=${status}; awaiting Node 3 ACK).`);
  res.status(201).json({ ok: true, packet_id: packetId, status, overall_status: targetOverall, node2_acked: 0 });
});

app.post('/api/node3/packet-received', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const packetId = Math.round(safeNumber(b.packet_id, -1));
  const now = new Date().toISOString();
  let authenticated = Boolean(b.authenticated);

  if (!Number.isInteger(packetId) || packetId < 1) {
    res.status(400).json({ error: 'Positive integer packet_id is required.' });
    return;
  }

  const existing = db
    .prepare(
      "SELECT id, protocol_version, source_node, destination_node, priority, route_path, gateway_status, overall_status, encryption_status, nonce, ciphertext, auth_tag, aad, key_version FROM packets WHERE mode = 'hardware' AND packet_id = ?"
    )
    .get(packetId) as
    | {
        id: number;
        protocol_version: number;
        source_node: number;
        destination_node: number;
        priority: number;
        route_path: string;
        gateway_status: string;
        overall_status: string;
        encryption_status: string;
        nonce: string;
        ciphertext: string;
        auth_tag: string;
        aad: string;
        key_version: string;
      }
    | undefined;

  if (existing && existing.overall_status === 'REJECTED') {
    res.status(409).json({ error: `Packet #${packetId} was already cryptographically REJECTED and cannot be accepted.` });
    return;
  }

  const isDirectWifi =
    String(b.route_path || '').toUpperCase() === 'DIRECT_WIFI' ||
    existing?.route_path === 'DIRECT_WIFI' ||
    existing?.gateway_status === 'BYPASSED';
  const rxLinkHop = isDirectWifi ? 'NODE1_NODE3' : 'NODE2_NODE3';
  const rxAckTargetNode = isDirectWifi ? 1 : 2;

  let decryptedOverride: { temperature: number; humidity: number; rain_raw: number } | null = null;
  let verifyError: string | null = null;

  // If cryptographic envelope bytes are supplied to Node 3 endpoint, perform real server-side AES-128-GCM tag verification
  if (b.nonce && b.ciphertext && b.tag) {
    const ver = securityManager.verifyAndDecryptAtNode3({
      nonce: String(b.nonce),
      ciphertext: String(b.ciphertext),
      tag: String(b.tag),
      aad: String(b.aad || existing?.aad || securityManager.buildAad(1, 1, 3, packetId, existing?.priority ?? 2)),
      version: existing?.protocol_version ?? Math.round(safeNumber(b.version, 1)),
      source: existing?.source_node ?? 1,
      destination: existing?.destination_node ?? 3,
      packet_id: packetId,
      priority: existing?.priority ?? Math.round(safeNumber(b.priority, 2)),
    });
    authenticated = ver.authenticated;
    verifyError = ver.error;
    if (ver.authenticated && ver.plaintext) {
      decryptedOverride = {
        temperature: ver.plaintext.temperature,
        humidity: ver.plaintext.humidity,
        rain_raw: ver.plaintext.rain_raw,
      };
    }
  }

  const settings = getSettings();

  if (!authenticated) {
    withTransaction(() => {
      if (existing) {
        db.prepare(`
          UPDATE packets SET
            encryption_status = 'AUTH_FAILED',
            destination_status = 'REJECTED',
            overall_status = 'REJECTED',
            tampered = 1,
            node1_acked = CASE WHEN ? = 1 THEN 0 ELSE node1_acked END,
            node2_acked = 0,
            updated_at = ?
          WHERE mode = 'hardware' AND packet_id = ?
        `).run(isDirectWifi ? 1 : 0, now, packetId);
      } else {
        const version = Math.round(safeNumber(b.version, 1));
        const priority = Math.round(safeNumber(b.priority, 2)) === 1 ? 1 : 2;
        const seq = Math.max(1, Math.round(safeNumber(b.sequence_number ?? packetId, packetId)));
        const nonceHex = b.nonce ? String(b.nonce).trim().toLowerCase() : `rejected_${packetId}`;
        const ciphertextHex = b.ciphertext ? String(b.ciphertext).trim().toLowerCase() : '';
        const tagHex = b.tag ? String(b.tag).trim().toLowerCase() : '';
        const aad = String(b.aad || securityManager.buildAad(version, 1, 3, packetId, priority));
        db.prepare(`
          INSERT INTO packets (
            mode, packet_id, sequence_number, protocol_version, source_node, destination_node,
            priority, comm_mode, route_path, encryption_status, gateway_status, destination_status,
            overall_status, retry_count, nonce, ciphertext, auth_tag, aad, key_version,
            is_duplicate, tampered, node1_acked, node2_acked, payload_preview_json, created_at, updated_at
          ) VALUES (
            'hardware', ?, ?, ?, 1, 3,
            ?, ?, ?, 'AUTH_FAILED', ?, 'REJECTED',
            'REJECTED', 0, ?, ?, ?, ?, ?,
            0, 1, 0, 0, NULL, ?, ?
          )
        `).run(
          packetId,
          seq,
          version,
          priority,
          isDirectWifi ? 'WIFI' : 'LORA',
          isDirectWifi ? 'DIRECT_WIFI' : 'LORA_GATEWAY',
          isDirectWifi ? 'BYPASSED' : 'PENDING',
          nonceHex,
          ciphertextHex,
          tagHex,
          aad,
          String(b.key_version || 'v1'),
          now,
          now
        );
      }

      db.prepare(`
        INSERT INTO acknowledgements (
          mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
        ) VALUES ('hardware', ?, ?, 3, ?, 'REJECTED_NO_ACK', ?, ?, 1, ?)
      `).run(packetId, rxLinkHop, rxAckTargetNode, verifyError || 'AES_GCM_AUTH_TAG_VERIFICATION_FAILED', safeNumber(b.latency_ms, 0), now);

      logSecurityEvent(
        'hardware',
        packetId,
        'AUTH_REJECTED',
        'NODE_3',
        'REJECTED',
        existing?.nonce ?? (b.nonce ? String(b.nonce) : null),
        existing?.key_version ?? 'v1',
        `ESP32 Node 3 rejected packet #${packetId} (${rxLinkHop}): AES-128-GCM authentication failed (${verifyError || 'tag mismatch'}). LCD not updated; no success ACK sent.`
      );
      createAlert('hardware', 'CRITICAL', 'AUTH_FAILURE', `ESP32 Node 3 rejected unauthenticated packet #${packetId}.`, 'NODE_3');
      syncHardwareQueueCounts(now);
    });
    res.status(201).json({ ok: true, authenticated: false, rejected: true, link_hop: rxLinkHop, node2_acked: 0 });
    return;
  }

  const rawTemp = decryptedOverride ? decryptedOverride.temperature : Number(b.temperature);
  const rawHum = decryptedOverride ? decryptedOverride.humidity : Number(b.humidity);
  const rawRain = decryptedOverride ? decryptedOverride.rain_raw : Number(b.rain_raw);

  if (!Number.isFinite(rawTemp) || !Number.isFinite(rawHum) || !Number.isFinite(rawRain)) {
    res.status(400).json({ error: 'Valid numeric temperature, humidity, and rain_raw are required for authenticated Node 3 readings.' });
    return;
  }

  const temperature = rawTemp;
  const humidity = rawHum;
  const rainRaw = Math.round(rawRain);
  const { category, priority } = classifyRain(
    rainRaw,
    settings.rain_normal_threshold,
    settings.rain_heavy_threshold
  );

  withTransaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO sensor_readings (
        mode, packet_id, node_id, temperature, humidity, rain_raw, rain_category,
        priority, authenticated, is_anomaly, anomaly_score, data_source, recorded_at
      ) VALUES ('hardware', ?, 'NODE_3', ?, ?, ?, ?, ?, 1, 0, 0, 'ESP32_HARDWARE', ?)
    `).run(
      packetId,
      temperature,
      humidity,
      rainRaw,
      category,
      priority,
      now
    );

    // Node 3 authenticated & decrypted payload; awaits matching ACK confirmation on POST /api/node3/ack (or /api/node1/ack for direct Wi-Fi)
    if (existing) {
      db.prepare(`
        UPDATE packets SET
          encryption_status = 'AUTHENTICATED',
          destination_status = CASE WHEN (? = 1 AND node1_acked = 1) OR (? = 0 AND node2_acked = 1) THEN 'DELIVERED' ELSE 'AUTHENTICATED_AWAITING_ACK' END,
          overall_status = CASE WHEN (? = 1 AND node1_acked = 1) OR (? = 0 AND node2_acked = 1) THEN 'DELIVERED' WHEN ? = 1 THEN 'TRANSMITTED' ELSE 'FORWARDED' END,
          updated_at = ?
        WHERE mode = 'hardware' AND packet_id = ?
      `).run(isDirectWifi ? 1 : 0, isDirectWifi ? 1 : 0, isDirectWifi ? 1 : 0, isDirectWifi ? 1 : 0, isDirectWifi ? 1 : 0, now, packetId);
    } else {
      const version = Math.round(safeNumber(b.version, 1));
      const seq = Math.max(1, Math.round(safeNumber(b.sequence_number ?? packetId, packetId)));
      const nonceHex = b.nonce ? String(b.nonce).trim().toLowerCase() : `hw_verified_${packetId}`;
      const ciphertextHex = b.ciphertext ? String(b.ciphertext).trim().toLowerCase() : '';
      const tagHex = b.tag ? String(b.tag).trim().toLowerCase() : '';
      const aad = String(b.aad || securityManager.buildAad(version, 1, 3, packetId, priority));
      db.prepare(`
        INSERT INTO packets (
          mode, packet_id, sequence_number, protocol_version, source_node, destination_node,
          priority, comm_mode, route_path, encryption_status, gateway_status, destination_status,
          overall_status, retry_count, nonce, ciphertext, auth_tag, aad, key_version,
          is_duplicate, tampered, node1_acked, node2_acked, payload_preview_json, created_at, updated_at
        ) VALUES (
          'hardware', ?, ?, ?, 1, 3,
          ?, ?, ?, 'AUTHENTICATED', ?, 'AUTHENTICATED_AWAITING_ACK',
          ?, 0, ?, ?, ?, ?, ?,
          0, 0, 0, 0, NULL, ?, ?
        )
      `).run(
        packetId,
        seq,
        version,
        priority,
        isDirectWifi ? 'WIFI' : 'LORA',
        isDirectWifi ? 'DIRECT_WIFI' : 'LORA_GATEWAY',
        isDirectWifi ? 'BYPASSED' : 'STORED',
        isDirectWifi ? 'TRANSMITTED' : 'FORWARDED',
        nonceHex,
        ciphertextHex,
        tagHex,
        aad,
        String(b.key_version || 'v1'),
        now,
        now
      );
    }

    logSecurityEvent(
      'hardware',
      packetId,
      'AUTH_VERIFIED',
      'NODE_3',
      'AUTHENTICATED',
      existing?.nonce ?? (b.nonce ? String(b.nonce) : null),
      existing?.key_version ?? 'v1',
      `ESP32 Node 3 verified AES-128-GCM tag for packet #${packetId} (${rxLinkHop}) and persisted verified reading to LittleFS.`
    );

    db.prepare(`
      UPDATE nodes SET status = 'ONLINE', link_mode = 'WIFI', storage_status = CASE WHEN storage_status = 'N/A' THEN 'MOUNTED' ELSE storage_status END, lcd_status = ?, last_heartbeat = ?, metadata_json = ?, updated_at = ?
      WHERE node_id = 'NODE_3' AND mode = 'hardware'
    `).run(
      String(b.lcd_status || 'ACTIVE'),
      now,
      JSON.stringify({
        board: 'ESP32 Node 3',
        wifi_receiver: 'CONNECTED',
        littlefs_status: String(b.littlefs_status || 'MOUNTED'),
        aes_gcm: 'VERIFIED',
        lcd_line1: `T:${temperature.toFixed(1)}C H:${humidity.toFixed(0)}%`,
        lcd_line2: `RAIN:${category} #${packetId}`,
        last_authenticated_packet: packetId,
      }),
      now
    );

    syncHardwareQueueCounts(now);

    if (category === 'HEAVY') {
      createAlert('hardware', 'CRITICAL', 'HEAVY_RAIN', `Heavy rain alert authenticated at ESP32 Node 3 (raw=${rainRaw}, packet #${packetId}).`, 'NODE_3');
    }
  });

  res.status(201).json({
    ok: true,
    authenticated: true,
    packet_id: packetId,
    route_path: isDirectWifi ? 'DIRECT_WIFI' : 'LORA_GATEWAY',
    destination_status: 'AUTHENTICATED_AWAITING_ACK',
    node2_acked: 0,
    rain_category: category,
  });
});

app.post('/api/node3/authentication', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const packetId = Math.round(safeNumber(b.packet_id, -1));
  const passed = Boolean(b.authenticated);
  const now = new Date().toISOString();

  withTransaction(() => {
    logSecurityEvent(
      'hardware',
      packetId >= 1 ? packetId : null,
      passed ? 'AUTH_VERIFIED' : 'AUTH_REJECTED',
      'NODE_3',
      passed ? 'AUTHENTICATED' : 'REJECTED',
      b.nonce ? String(b.nonce) : null,
      String(b.key_version || 'v1'),
      String(b.details || (passed ? 'Node 3 AES-128-GCM tag verified.' : 'Node 3 AES-128-GCM tag failed.'))
    );

    if (packetId >= 1) {
      if (!passed) {
        db.prepare(`
          UPDATE packets SET encryption_status = 'AUTH_FAILED', destination_status = 'REJECTED', overall_status = 'REJECTED', tampered = 1, node2_acked = 0, updated_at = ?
          WHERE mode = 'hardware' AND packet_id = ?
        `).run(now, packetId);
        syncHardwareQueueCounts(now);
      } else {
        db.prepare(`
          UPDATE packets SET encryption_status = 'AUTHENTICATED', updated_at = ?
          WHERE mode = 'hardware' AND packet_id = ? AND overall_status != 'REJECTED'
        `).run(now, packetId);
      }
    }
  });
  res.status(201).json({ ok: true, authenticated: passed });
});

app.post('/api/node3/ack', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const packetId = Math.round(safeNumber(b.packet_id, -1));
  if (!Number.isInteger(packetId) || packetId < 1) {
    res.status(400).json({ error: 'Positive integer packet_id is required.' });
    return;
  }

  const pkt = db
    .prepare(
      "SELECT id, packet_id, route_path, gateway_status, encryption_status, destination_status, overall_status FROM packets WHERE mode = 'hardware' AND packet_id = ?"
    )
    .get(packetId) as
    | {
        id: number;
        packet_id: number;
        route_path: string;
        gateway_status: string;
        encryption_status: string;
        destination_status: string;
        overall_status: string;
      }
    | undefined;

  if (!pkt) {
    res.status(404).json({ error: `Cannot process Node 3 ACK: packet #${packetId} does not exist in hardware mode.` });
    return;
  }

  const now = new Date().toISOString();
  const requestedHop = b.link_hop ? String(b.link_hop).toUpperCase() : '';
  const isDirectWifi =
    requestedHop === 'NODE1_NODE3' ||
    (requestedHop === '' && (pkt.route_path === 'DIRECT_WIFI' || pkt.gateway_status === 'BYPASSED'));
  const linkHop = isDirectWifi ? 'NODE1_NODE3' : 'NODE2_NODE3';
  const expectedReceiver = isDirectWifi ? 1 : 2;
  const status = String(b.status || 'ACK_DELIVERED').toUpperCase();

  // Strict ACK mismatch guard (packet_id & receiver_node)
  const ackPacketId = b.ack_packet_id !== undefined ? Math.round(safeNumber(b.ack_packet_id, -1)) : packetId;
  const receiverNode = b.receiver_node !== undefined ? Math.round(safeNumber(b.receiver_node, expectedReceiver)) : expectedReceiver;
  if (ackPacketId !== packetId || receiverNode !== expectedReceiver) {
    withTransaction(() => {
      db.prepare(`
        INSERT INTO acknowledgements (
          mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
        ) VALUES ('hardware', ?, ?, 3, ?, 'ACK_MISMATCH', ?, ?, 0, ?)
      `).run(
        packetId,
        linkHop,
        receiverNode,
        `EXPECTED_PKT_${packetId}_TO_NODE_${expectedReceiver}_GOT_PKT_${ackPacketId}_TO_NODE_${receiverNode}`,
        safeNumber(b.latency_ms, 0),
        now
      );
      logCommEvent(
        'hardware',
        'ACK_MISMATCH',
        linkHop,
        'WIFI',
        packetId,
        `Rejected mismatched Node 3 ACK for packet #${packetId}: got ack_packet_id=${ackPacketId}, receiver_node=${receiverNode} (expected packet #${packetId} to Node ${expectedReceiver}).`
      );
    });
    res.status(409).json({
      error: `ACK_MISMATCH: Expected ACK for packet #${packetId} addressed to Node ${expectedReceiver}, received packet #${ackPacketId} to Node ${receiverNode}.`,
      node1_acked: 0,
      node2_acked: 0,
    });
    return;
  }

  if (status === 'ACK_DELIVERED' || status === 'ACK_DUPLICATE_RESENT') {
    if (!isDirectWifi && pkt.gateway_status !== 'STORED' && pkt.gateway_status !== 'DUPLICATE_SUPPRESSED') {
      res.status(409).json({
        error: `CANNOT_DELIVER_UNSTORED_PACKET: LoRa fallback packet #${packetId} was never stored on Node 2 microSD.`,
      });
      return;
    }
    if (pkt.encryption_status !== 'AUTHENTICATED' || pkt.overall_status === 'REJECTED') {
      res.status(409).json({
        error: `CANNOT_ACK_UNAUTHENTICATED_OR_REJECTED_PACKET: Packet #${packetId} has encryption_status=${pkt.encryption_status}, overall_status=${pkt.overall_status}.`,
      });
      return;
    }
  }

  const isDeliveredAck = status === 'ACK_DELIVERED' || status === 'ACK_DUPLICATE_RESENT';

  withTransaction(() => {
    db.prepare(`
      INSERT INTO acknowledgements (
        mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
      ) VALUES ('hardware', ?, ?, 3, ?, ?, ?, ?, ?, ?)
    `).run(
      packetId,
      linkHop,
      expectedReceiver,
      status,
      b.error_code ? String(b.error_code) : null,
      safeNumber(b.latency_ms, 0),
      isDeliveredAck ? 1 : 0,
      now
    );

    if (isDeliveredAck) {
      if (isDirectWifi) {
        // Scenario A: Direct Node 3 -> Node 1 ACK retires Node 1 LittleFS without touching Node 2 microSD
        db.prepare(`
          UPDATE packets SET
            route_path = 'DIRECT_WIFI',
            gateway_status = 'BYPASSED',
            destination_status = 'DELIVERED',
            overall_status = 'DELIVERED',
            node1_acked = 1,
            node2_acked = 0,
            updated_at = ?
          WHERE id = ?
        `).run(now, pkt.id);
        logCommEvent(
          'hardware',
          'DELIVERED',
          'NODE1_NODE3',
          'WIFI',
          packetId,
          `Scenario A: Direct Node 3 → Node 1 ${status} verified for packet #${packetId}. Node 1 LittleFS retired (Node 2 bypassed).`
        );
      } else {
        // Scenario B: Stage-2 Node 3 -> Node 2 ACK retires Node 2 microSD pending queue
        db.prepare(`
          UPDATE packets SET destination_status = 'DELIVERED', overall_status = 'DELIVERED', node2_acked = 1, updated_at = ?
          WHERE id = ?
        `).run(now, pkt.id);
        logCommEvent(
          'hardware',
          'DELIVERED',
          'NODE2_NODE3',
          'WIFI',
          packetId,
          `Scenario B (Stage 2): Node 2 verified matching Node 3 ${status} for packet #${packetId} and retired microSD pending entry.`
        );
      }
    } else if (pkt.overall_status !== 'DELIVERED' && pkt.overall_status !== 'REJECTED') {
      if (isDirectWifi) {
        db.prepare(`
          UPDATE packets SET destination_status = 'RETRYING', overall_status = 'RETRYING', retry_count = retry_count + 1, node1_acked = 0, updated_at = ?
          WHERE id = ?
        `).run(now, pkt.id);
      } else {
        db.prepare(`
          UPDATE packets SET destination_status = 'RETRYING', overall_status = 'RETRYING', retry_count = retry_count + 1, node2_acked = 0, updated_at = ?
          WHERE id = ?
        `).run(now, pkt.id);
      }
      logCommEvent(
        'hardware',
        'ACK_LOST',
        linkHop,
        'WIFI',
        packetId,
        `Node 3 ACK failure (${status}) on ${linkHop} for packet #${packetId}. Pending copy retained for retry.`
      );
    }

    syncHardwareQueueCounts(now);
  });

  res.status(201).json({
    ok: true,
    packet_id: packetId,
    link_hop: linkHop,
    status,
    node1_acked: isDirectWifi && isDeliveredAck ? 1 : undefined,
    node2_acked: !isDirectWifi && isDeliveredAck ? 1 : 0,
  });
});

// ============================================================================
// PACKETS, QUEUES, STORAGE, SECURITY, ML, HISTORY & ALERTS ENDPOINTS
// ============================================================================

app.get('/api/packets', (req, res) => {
  const mode = getEffectiveMode(req.query.mode);
  const status = req.query.status ? String(req.query.status) : '';
  const priority = req.query.priority ? Number(req.query.priority) : null;
  const commMode = req.query.comm_mode ? String(req.query.comm_mode) : '';
  const routePath = req.query.route_path ? String(req.query.route_path).toUpperCase() : '';
  const view = req.query.view ? String(req.query.view) : 'all';
  const search = req.query.search ? String(req.query.search).trim() : '';
  const limit = Math.max(10, Math.min(300, safeNumber(req.query.limit, 120)));

  const clauses: string[] = ['mode = ?'];
  const params: Array<string | number> = [mode];

  if (view === 'node1_pending') {
    clauses.push("node1_acked = 0 AND destination_status != 'REJECTED'");
  } else if (view === 'node2_received') {
    clauses.push("gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')");
  } else if (view === 'node2_pending_node3') {
    clauses.push("gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')");
    clauses.push("node2_acked = 0 AND destination_status != 'REJECTED'");
  } else if (view === 'node3_delivered') {
    clauses.push(DELIVERED_SQL_CLAUSE);
  } else if (view === 'direct_wifi') {
    clauses.push("route_path = 'DIRECT_WIFI'");
  } else if (view === 'lora_fallback') {
    clauses.push("route_path = 'LORA_GATEWAY'");
  }

  if (status && status !== 'ALL') {
    clauses.push('overall_status = ?');
    params.push(status);
  }
  if (priority === 1 || priority === 2) {
    clauses.push('priority = ?');
    params.push(priority);
  }
  if (commMode && commMode !== 'ALL') {
    clauses.push('comm_mode = ?');
    params.push(commMode);
  }
  if (routePath && routePath !== 'ALL' && VALID_ROUTE_PATHS.includes(routePath as (typeof VALID_ROUTE_PATHS)[number])) {
    clauses.push('route_path = ?');
    params.push(routePath);
  }
  if (search) {
    clauses.push('(CAST(packet_id AS TEXT) LIKE ? OR nonce LIKE ? OR overall_status LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  params.push(limit);

  const packets = db
    .prepare(`SELECT * FROM packets WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...params);

  res.json({ mode, packets });
});

app.get('/api/packets/pending', (req, res) => {
  const mode = getEffectiveMode(req.query.mode);
  const node1Pending = db
    .prepare("SELECT * FROM packets WHERE mode = ? AND node1_acked = 0 AND destination_status != 'REJECTED' ORDER BY priority ASC, packet_id ASC")
    .all(mode);
  const node2PendingNode3 = db
    .prepare(
      "SELECT * FROM packets WHERE mode = ? AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED') AND node2_acked = 0 AND destination_status != 'REJECTED' ORDER BY priority ASC, packet_id ASC"
    )
    .all(mode);

  res.json({ mode, node1_pending: node1Pending, node2_pending_node3: node2PendingNode3 });
});

app.get('/api/packets/:packetId', (req, res) => {
  const mode = getEffectiveMode(req.query.mode);
  const packetId = Math.round(safeNumber(req.params.packetId, -1));
  if (packetId < 0) {
    res.status(400).json({ error: 'Invalid packetId parameter.' });
    return;
  }

  const packet = db
    .prepare('SELECT * FROM packets WHERE mode = ? AND packet_id = ?')
    .get(mode, packetId) as Record<string, unknown> | undefined;

  if (!packet) {
    res.status(404).json({ error: `Packet #${packetId} not found in ${mode} mode.` });
    return;
  }

  const acknowledgements = db
    .prepare('SELECT * FROM acknowledgements WHERE mode = ? AND packet_id = ? ORDER BY id ASC')
    .all(mode, packetId);

  const securityEvents = db
    .prepare('SELECT * FROM security_events WHERE mode = ? AND packet_id = ? ORDER BY id ASC')
    .all(mode, packetId);

  const commEvents = db
    .prepare('SELECT * FROM communication_events WHERE mode = ? AND packet_id = ? ORDER BY id ASC')
    .all(mode, packetId);

  // Only expose decrypted sensor reading if Node 3 authenticated the packet (and never when rejected)
  const authenticatedReading =
    packet.encryption_status === 'AUTHENTICATED' && packet.destination_status !== 'REJECTED'
      ? db
          .prepare('SELECT * FROM sensor_readings WHERE mode = ? AND packet_id = ? AND authenticated = 1 LIMIT 1')
          .get(mode, packetId) || null
      : null;

  res.json({
    mode,
    packet,
    acknowledgements,
    security_events: securityEvents,
    communication_events: commEvents,
    authenticated_reading: authenticatedReading,
  });
});

app.get('/api/queues', (req, res) => {
  const mode = getEffectiveMode(req.query.mode);
  const node1Pending = db
    .prepare("SELECT * FROM packets WHERE mode = ? AND node1_acked = 0 AND destination_status != 'REJECTED' ORDER BY priority ASC, packet_id ASC")
    .all(mode);
  const node2Received = db
    .prepare(
      "SELECT * FROM packets WHERE mode = ? AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED') ORDER BY id DESC LIMIT 50"
    )
    .all(mode);
  const node2PendingNode3 = db
    .prepare(
      "SELECT * FROM packets WHERE mode = ? AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED') AND node2_acked = 0 AND destination_status != 'REJECTED' ORDER BY priority ASC, packet_id ASC"
    )
    .all(mode);
  const node3Delivered = db
    .prepare(
      `SELECT * FROM packets WHERE mode = ? AND ${DELIVERED_SQL_CLAUSE} ORDER BY id DESC LIMIT 50`
    )
    .all(mode);

  const queues = {
    node1_pending: node1Pending,
    node2_received: node2Received,
    node2_pending_node3: node2PendingNode3,
    node3_delivered: node3Delivered,
  };
  res.json({
    mode,
    counts: {
      node1_pending: node1Pending.length,
      node2_received: node2Received.length,
      node2_pending_node3: node2PendingNode3.length,
      node3_delivered: node3Delivered.length,
    },
    queues,
    ...queues,
  });
});

app.get('/api/storage', (req, res) => {
  const mode = getEffectiveMode(req.query.mode);
  const rows = db
    .prepare('SELECT * FROM storage_status WHERE mode = ? ORDER BY node_id ASC')
    .all(mode) as Array<Record<string, unknown>>;

  const storage = rows.map((r) => ({
    ...r,
    files: JSON.parse(String(r.files_json || '[]')),
  }));

  const node1PendingIds = db
    .prepare("SELECT packet_id, priority, created_at FROM packets WHERE mode = ? AND node1_acked = 0 AND destination_status != 'REJECTED' ORDER BY priority ASC, packet_id ASC")
    .all(mode) as Array<Record<string, unknown>>;
  const node2PendingIds = db
    .prepare(
      "SELECT packet_id, priority, created_at FROM packets WHERE mode = ? AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED') AND node2_acked = 0 AND destination_status != 'REJECTED' ORDER BY priority ASC, packet_id ASC"
    )
    .all(mode) as Array<Record<string, unknown>>;

  res.json({
    mode,
    storage,
    node1_pending_packets: node1PendingIds,
    node2_pending_node3_packets: node2PendingIds,
  });
});

app.get('/api/security', (req, res) => {
  const mode = getEffectiveMode(req.query.mode);
  const encryptedCount = (
    db.prepare('SELECT COUNT(*) as c FROM packets WHERE mode = ?').get(mode) as { c: number }
  ).c;
  const authSuccessCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM packets WHERE mode = ? AND encryption_status = 'AUTHENTICATED'")
      .get(mode) as { c: number }
  ).c;
  const authFailedCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM packets WHERE mode = ? AND encryption_status = 'AUTH_FAILED'")
      .get(mode) as { c: number }
  ).c;
  const rejectedCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM packets WHERE mode = ? AND destination_status = 'REJECTED'")
      .get(mode) as { c: number }
  ).c;
  const uniqueNoncesInDb = (
    db.prepare('SELECT COUNT(DISTINCT nonce) as c FROM packets WHERE mode = ?').get(mode) as {
      c: number;
    }
  ).c;

  const events = db
    .prepare('SELECT * FROM security_events WHERE mode = ? ORDER BY id DESC LIMIT 60')
    .all(mode);

  res.json({
    mode,
    metadata: securityManager.getPublicKeyMetadata(),
    metrics: {
      encrypted_packet_count: encryptedCount,
      auth_success_count: authSuccessCount,
      auth_failed_count: authFailedCount,
      rejected_packet_count: rejectedCount,
      unique_nonce_verified: uniqueNoncesInDb === encryptedCount,
      unique_nonces_count: uniqueNoncesInDb,
    },
    events,
  });
});

function handleMLError(res: express.Response, err: unknown) {
  if (err instanceof MLValidationError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  console.error('[ML] Integration endpoint error:', err);
  res.status(500).json({ error: 'Internal ML integration error.' });
}

function parseQueryMLDataSource(raw: unknown): MLDataSource | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const ds = String(raw).trim().toUpperCase();
  if (!ML_DATA_SOURCES.includes(ds as MLDataSource)) {
    throw new MLValidationError(
      'INVALID_DATA_SOURCE',
      `data_source query must be SIMULATED, ESP32_HARDWARE, or CSV_IMPORT. Received '${ds}'.`
    );
  }
  return ds as MLDataSource;
}

app.get('/api/ml/network', (req, res) => {
  try {
    const mode = getEffectiveMode(req.query.mode);
    const limit = safeNumber(req.query.limit, 60);
    const explicitDataSource = parseQueryMLDataSource(req.query.data_source);
    res.json(getNetworkMLDashboardState(mode, limit, explicitDataSource));
  } catch (err) {
    handleMLError(res, err);
  }
});

app.get('/api/ml/features', (req, res) => {
  try {
    const mode = getEffectiveMode(req.query.mode);
    const limit = safeNumber(req.query.limit, 60);
    const explicitDataSource = parseQueryMLDataSource(req.query.data_source);
    res.json(extractNode2WifiFeatures(mode, limit, explicitDataSource));
  } catch (err) {
    handleMLError(res, err);
  }
});

app.post('/api/ml/network/classification', (req, res) => {
  try {
    const record = ingestClassificationPrediction((req.body ?? {}) as Record<string, unknown>);
    res.status(201).json({ ok: true, prediction: record });
  } catch (err) {
    handleMLError(res, err);
  }
});

app.post('/api/ml/network/scheduling', (req, res) => {
  try {
    const record = ingestSchedulingPrediction((req.body ?? {}) as Record<string, unknown>);
    res.status(201).json({ ok: true, prediction: record });
  } catch (err) {
    handleMLError(res, err);
  }
});

app.post('/api/ml/network/evaluation', (req, res) => {
  try {
    const evaluation = ingestEvaluationMetrics((req.body ?? {}) as Record<string, unknown>);
    res.json({ ok: true, evaluation });
  } catch (err) {
    handleMLError(res, err);
  }
});

app.post('/api/ml/network/status', (req, res) => {
  try {
    const heartbeat = updateModelStatus((req.body ?? {}) as Record<string, unknown>);
    res.json({ ok: true, status: heartbeat });
  } catch (err) {
    handleMLError(res, err);
  }
});

app.get('/api/communication', (req, res) => {
  const mode = getEffectiveMode(req.query.mode);
  const settings = getSettings();
  const limit = Math.max(10, Math.min(200, safeNumber(req.query.limit, 60)));
  const requestedLink = req.query.link_hop ? String(req.query.link_hop).toUpperCase() : '';

  const fetchLinkSeries = (hop: LinkHopId) =>
    (
      db
        .prepare(
          "SELECT * FROM network_metrics WHERE mode = ? AND link_hop = ? AND data_source != 'CSV_IMPORT' ORDER BY id DESC LIMIT ?"
        )
        .all(mode, hop, limit) as Array<Record<string, unknown>>
    ).reverse();

  const metricsByLink = {
    NODE1_NODE3_WIFI: fetchLinkSeries('NODE1_NODE3_WIFI'),
    NODE1_NODE2_LORA: fetchLinkSeries('NODE1_NODE2_LORA'),
    NODE2_NODE3_WIFI: fetchLinkSeries('NODE2_NODE3_WIFI'),
    LEGACY_UNCLASSIFIED: fetchLinkSeries('LEGACY_UNCLASSIFIED'),
  };

  // Backward-compatible `metrics` array: if ?link_hop= is specified, return strictly that link; otherwise return NODE2_NODE3_WIFI (or fallback if empty) so charts never mix Wi-Fi and LoRa!
  const metrics =
    requestedLink && VALID_LINK_HOPS.includes(requestedLink as LinkHopId)
      ? metricsByLink[requestedLink as LinkHopId]
      : metricsByLink.NODE2_NODE3_WIFI.length > 0
        ? metricsByLink.NODE2_NODE3_WIFI
        : metricsByLink.NODE1_NODE3_WIFI;

  const events = db
    .prepare('SELECT * FROM communication_events WHERE mode = ? ORDER BY id DESC LIMIT 60')
    .all(mode);

  const acks = db
    .prepare('SELECT * FROM acknowledgements WHERE mode = ? ORDER BY id DESC LIMIT 40')
    .all(mode);

  res.json({
    mode,
    active_link_filter: requestedLink || 'NODE2_NODE3_WIFI',
    metrics,
    metrics_by_link: metricsByLink,
    measurement_spec: buildMeasurementSpec(settings),
    events,
    acknowledgements: acks,
  });
});

app.get('/api/csv/imports', (req, res) => {
  const limit = safeNumber(req.query.limit, 30);
  res.json({ imports: listCsvImports(limit) });
});

app.get('/api/history', (req, res) => {
  const mode = getEffectiveMode(req.query.mode);
  const rawSourceFilter = req.query.data_source ? String(req.query.data_source).trim().toUpperCase() : '';
  if (rawSourceFilter && !VALID_DATA_SOURCES.includes(rawSourceFilter as DataSourceType)) {
    res.status(400).json({
      error: `Invalid data_source '${rawSourceFilter}'. Allowed: ${VALID_DATA_SOURCES.join(', ')}.`,
    });
    return;
  }
  const activeSourceFilter = (rawSourceFilter || null) as DataSourceType | null;
  const from = req.query.from ? String(req.query.from) : '';
  const to = req.query.to ? String(req.query.to) : '';
  const limit = Math.max(20, Math.min(500, safeNumber(req.query.limit, 150)));

  const buildScopedFilter = (
    timeCol: string,
    hasDataSource: boolean
  ): { sql: string; params: Array<string | number> } => {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (hasDataSource && activeSourceFilter) {
      clauses.push('data_source = ?');
      params.push(activeSourceFilter);
    } else if (hasDataSource) {
      clauses.push('mode = ?');
      params.push(mode);
      // Keep imported CSV files strictly separate from live simulation/hardware default view unless CSV_IMPORT is selected
      clauses.push("data_source != 'CSV_IMPORT'");
    } else {
      clauses.push('mode = ?');
      params.push(mode);
    }

    if (from) {
      clauses.push(`${timeCol} >= ?`);
      params.push(from);
    }
    if (to) {
      clauses.push(`${timeCol} <= ?`);
      params.push(to);
    }
    params.push(limit);
    return { sql: clauses.join(' AND '), params };
  };

  const sf = buildScopedFilter('recorded_at', true);
  const sensors = (
    db
      .prepare(`SELECT * FROM sensor_readings WHERE ${sf.sql} ORDER BY recorded_at DESC, id DESC LIMIT ?`)
      .all(...sf.params) as Array<Record<string, unknown>>
  ).reverse();

  const mf = buildScopedFilter('recorded_at', true);
  const metrics = (
    db
      .prepare(`SELECT * FROM network_metrics WHERE ${mf.sql} ORDER BY recorded_at DESC, id DESC LIMIT ?`)
      .all(...mf.params) as Array<Record<string, unknown>>
  ).reverse();

  const isCsvView = activeSourceFilter === 'CSV_IMPORT';

  const pf = buildScopedFilter('created_at', false);
  const packets = isCsvView
    ? []
    : db.prepare(`SELECT * FROM packets WHERE ${pf.sql} ORDER BY id DESC LIMIT ?`).all(...pf.params);

  const secf = buildScopedFilter('created_at', false);
  const securityEvents = isCsvView
    ? []
    : db
        .prepare(`SELECT * FROM security_events WHERE ${secf.sql} ORDER BY id DESC LIMIT ?`)
        .all(...secf.params);

  const mlf = buildScopedFilter('created_at', true);
  const mlPredictions = db
    .prepare(
      `SELECT id, mode, link_hop, model_type, predicted_class, confidence, predicted_wait_seconds, actual_wait_seconds, observation_censored, model_version, data_source, prediction_timestamp, model_status, created_at FROM ml_predictions WHERE ${mlf.sql} AND link_hop = 'NODE2_NODE3_WIFI' AND prediction_source = 'EXTERNAL_ML' ORDER BY id DESC LIMIT ?`
    )
    .all(...mlf.params);

  const cf = buildScopedFilter('created_at', false);
  const commEvents = isCsvView
    ? []
    : db
        .prepare(`SELECT * FROM communication_events WHERE ${cf.sql} ORDER BY id DESC LIMIT ?`)
        .all(...cf.params);

  // Global provenance counts across persisted SQLite telemetry so users see SIMULATED / ESP32_HARDWARE / CSV_IMPORT separately
  const metricCountsBySource: Record<DataSourceType, number> = {
    SIMULATED: 0,
    ESP32_HARDWARE: 0,
    CSV_IMPORT: 0,
    LEGACY_UNCLASSIFIED: 0,
  };
  for (const r of db
    .prepare('SELECT data_source, COUNT(*) as c FROM network_metrics GROUP BY data_source')
    .all() as Array<{ data_source: DataSourceType; c: number }>) {
    if (r.data_source in metricCountsBySource) {
      metricCountsBySource[r.data_source] = Number(r.c || 0);
    }
  }

  const sensorCountsBySource: Record<DataSourceType, number> = {
    SIMULATED: 0,
    ESP32_HARDWARE: 0,
    CSV_IMPORT: 0,
    LEGACY_UNCLASSIFIED: 0,
  };
  for (const r of db
    .prepare('SELECT data_source, COUNT(*) as c FROM sensor_readings GROUP BY data_source')
    .all() as Array<{ data_source: DataSourceType; c: number }>) {
    if (r.data_source in sensorCountsBySource) {
      sensorCountsBySource[r.data_source] = Number(r.c || 0);
    }
  }

  res.json({
    mode,
    active_data_source: activeSourceFilter ?? (mode === 'hardware' ? 'ESP32_HARDWARE' : 'SIMULATED'),
    sensors,
    metrics,
    packets,
    security_events: securityEvents,
    ml_predictions: mlPredictions,
    communication_events: commEvents,
    provenance_counts: {
      network_metrics: metricCountsBySource,
      sensor_readings: sensorCountsBySource,
    },
    csv_imports: listCsvImports(30),
  });
});

app.get('/api/alerts', (req, res) => {
  const mode = getEffectiveMode(req.query.mode);
  const alerts = db
    .prepare('SELECT * FROM system_alerts WHERE mode = ? ORDER BY id DESC LIMIT 100')
    .all(mode);
  res.json({ mode, alerts });
});

app.post('/api/alerts/read', (req, res) => {
  const mode = getEffectiveMode(req.body?.mode || req.query.mode);
  const alertId = req.body?.id ? Number(req.body.id) : null;
  if (alertId && Number.isFinite(alertId)) {
    db.prepare('UPDATE system_alerts SET is_read = 1 WHERE id = ? AND mode = ?').run(alertId, mode);
  } else {
    db.prepare('UPDATE system_alerts SET is_read = 1 WHERE mode = ?').run(mode);
  }
  res.json({ ok: true });
});

// ============================================================================
// SYSTEM TESTING ENDPOINTS (PDF Page 12 — 8 Test Cases)
// ============================================================================

app.get('/api/tests', (_req, res) => {
  const tests = getTestResults();
  const passed = tests.filter((t) => t.passed === true).length;
  const failed = tests.filter((t) => t.passed === false).length;
  res.json({
    tests,
    summary: {
      total: tests.length,
      passed,
      failed,
      not_run: tests.length - passed - failed,
    },
  });
});

app.post('/api/tests/run', (req, res) => {
  const testId = req.body?.test_id !== undefined ? Number(req.body.test_id) : null;
  try {
    if (testId === null || req.body?.all === true) {
      const results = runAllSystemTests();
      const passed = results.filter((t) => t.passed === true).length;
      res.json({
        ok: true,
        tests: results,
        summary: { total: results.length, passed, failed: results.length - passed, not_run: 0 },
      });
      return;
    }
    if (!Number.isInteger(testId) || testId < 1 || testId > 8) {
      res.status(400).json({ error: 'test_id must be an integer between 1 and 8.' });
      return;
    }
    const result = runSystemTest(testId);
    const all = getTestResults();
    const passed = all.filter((t) => t.passed === true).length;
    const failed = all.filter((t) => t.passed === false).length;
    res.json({
      ok: true,
      result,
      tests: all,
      summary: { total: all.length, passed, failed, not_run: all.length - passed - failed },
    });
  } catch (err) {
    console.error('[Tests] Execution error:', err);
    res.status(500).json({ error: 'System test execution failed.' });
  }
});

app.post('/api/tests/reset', (_req, res) => {
  const tests = resetTests();
  res.json({
    ok: true,
    tests,
    summary: { total: tests.length, passed: 0, failed: 0, not_run: tests.length },
  });
});

// ============================================================================
// SIMULATION CONTROL ENDPOINTS
// ============================================================================

app.get('/api/simulation/status', (_req, res) => {
  res.json({ simulation: simulationEngine.getState() });
});

app.post('/api/simulation/start', (_req, res) => {
  res.json({ ok: true, simulation: simulationEngine.start() });
});

app.post('/api/simulation/pause', (_req, res) => {
  res.json({ ok: true, simulation: simulationEngine.pause() });
});

app.post('/api/simulation/resume', (_req, res) => {
  res.json({ ok: true, simulation: simulationEngine.resume() });
});

app.post('/api/simulation/reset', (_req, res) => {
  res.json({ ok: true, simulation: simulationEngine.resetSimulation() });
});

app.post('/api/simulation/control', (req, res) => {
  const action = String(req.body?.action || '');
  if (!action) {
    res.status(400).json({ error: 'action is required.' });
    return;
  }
  const result = simulationEngine.applyControl(action, req.body as Record<string, unknown>);
  res.json({ ok: true, ...result });
});

// ============================================================================
// CSV EXPORT ENDPOINT
// ============================================================================

app.get('/api/export/csv', (req, res) => {
  const mode = getEffectiveMode(req.query.mode);
  const rawSource = req.query.data_source ? String(req.query.data_source).trim().toUpperCase() : '';
  const sourceFilter =
    rawSource && VALID_DATA_SOURCES.includes(rawSource as DataSourceType)
      ? (rawSource as DataSourceType)
      : null;
  const dataset = String(req.query.type || 'sensors');
  let csv = '';
  const sourceSlug = sourceFilter ? sourceFilter.toLowerCase() : mode;
  let filename = `resilient_iot_${dataset}_${sourceSlug}.csv`;

  if (dataset === 'sensors') {
    const rows = sourceFilter
      ? (db
          .prepare(
            'SELECT id, mode, packet_id, node_id, temperature, humidity, rain_raw, rain_category, priority, authenticated, is_anomaly, anomaly_score, data_source, recorded_at FROM sensor_readings WHERE data_source = ? ORDER BY recorded_at DESC, id DESC'
          )
          .all(sourceFilter) as Array<Record<string, unknown>>)
      : (db
          .prepare(
            "SELECT id, mode, packet_id, node_id, temperature, humidity, rain_raw, rain_category, priority, authenticated, is_anomaly, anomaly_score, data_source, recorded_at FROM sensor_readings WHERE mode = ? AND data_source != 'CSV_IMPORT' ORDER BY id DESC"
          )
          .all(mode) as Array<Record<string, unknown>>);
    csv = toCsv(rows, [
      'id', 'mode', 'packet_id', 'node_id', 'temperature', 'humidity', 'rain_raw',
      'rain_category', 'priority', 'authenticated', 'is_anomaly', 'anomaly_score', 'data_source', 'recorded_at',
    ]);
  } else if (dataset === 'network') {
    const linkFilter = req.query.link_hop ? String(req.query.link_hop).toUpperCase() : '';
    const hasValidLink = linkFilter && VALID_LINK_HOPS.includes(linkFilter as LinkHopId);
    const whereClause = sourceFilter
      ? hasValidLink
        ? 'data_source = ? AND link_hop = ?'
        : 'data_source = ?'
      : hasValidLink
        ? "mode = ? AND data_source != 'CSV_IMPORT' AND link_hop = ?"
        : "mode = ? AND data_source != 'CSV_IMPORT'";
    const queryParams = sourceFilter
      ? hasValidLink
        ? [sourceFilter, linkFilter]
        : [sourceFilter]
      : hasValidLink
        ? [mode, linkFilter]
        : [mode];
    const rows = db
      .prepare(
        `SELECT id, mode, link_hop, rssi, rssi_variation, rssi_source, packet_loss_ratio, ack_latency_ms, retry_count, queue_depth, link_mode, node2_to_node3_status, data_source, recorded_at FROM network_metrics WHERE ${whereClause} ORDER BY recorded_at DESC, id DESC`
      )
      .all(...queryParams) as Array<Record<string, unknown>>;
    if (hasValidLink) {
      filename = `resilient_iot_network_${linkFilter.toLowerCase()}_${sourceSlug}.csv`;
    }
    csv = toCsv(rows, [
      'id', 'mode', 'link_hop', 'rssi', 'rssi_variation', 'rssi_source', 'packet_loss_ratio', 'ack_latency_ms',
      'retry_count', 'queue_depth', 'link_mode', 'node2_to_node3_status', 'data_source', 'recorded_at',
    ]);
  } else if (dataset === 'packets') {
    const rows = db
      .prepare('SELECT packet_id, sequence_number, protocol_version, source_node, destination_node, priority, comm_mode, route_path, encryption_status, gateway_status, destination_status, overall_status, node1_acked, node2_acked, retry_count, nonce, key_version, is_duplicate, tampered, created_at, updated_at FROM packets WHERE mode = ? ORDER BY id DESC')
      .all(mode) as Array<Record<string, unknown>>;
    csv = toCsv(rows, [
      'packet_id', 'sequence_number', 'protocol_version', 'source_node', 'destination_node',
      'priority', 'comm_mode', 'route_path', 'encryption_status', 'gateway_status', 'destination_status',
      'overall_status', 'node1_acked', 'node2_acked', 'retry_count', 'nonce', 'key_version', 'is_duplicate', 'tampered',
      'created_at', 'updated_at',
    ]);
  } else if (dataset === 'security') {
    const rows = db
      .prepare('SELECT id, mode, packet_id, event_type, endpoint, status, nonce_hex, key_version, details, created_at FROM security_events WHERE mode = ? ORDER BY id DESC')
      .all(mode) as Array<Record<string, unknown>>;
    csv = toCsv(rows, [
      'id', 'mode', 'packet_id', 'event_type', 'endpoint', 'status',
      'nonce_hex', 'key_version', 'details', 'created_at',
    ]);
  } else {
    res.status(400).json({ error: 'Invalid CSV type. Use sensors, network, packets, or security.' });
    return;
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// Clean JSON 404 handler for unknown /api/* endpoints (never fall through to SPA index.html)
app.use('/api', (req, res) => {
  res.status(404).json({
    error: `API endpoint not found: ${req.method} ${req.originalUrl}`,
    timestamp: new Date().toISOString(),
  });
});

// Global error handler returning consistent JSON without leaking internal stack traces
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'Uploaded payload exceeds allowed size limit.' });
    return;
  }
  console.error('[Resilient IoT Server] Unhandled route error:', err);
  res.status(500).json({
    error: 'Internal server error while processing request.',
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// VITE DEV / STATIC PROD FRONTEND SERVING
// ============================================================================

async function startServer(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    const indexHtml = path.join(distDir, 'index.html');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      if (!fs.existsSync(indexHtml)) {
        res.status(503).send('Frontend production bundle not found. Run npm run build first.');
        return;
      }
      res.sendFile(indexHtml);
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Resilient IoT Server] Running on http://0.0.0.0:${PORT}`);
    console.log(`[Resilient IoT Server] SQLite database: ${DB_FILE_PATH}`);
  });

  const shutdown = () => {
    server.close(() => {
      try {
        db.close();
      } catch {
        // Ignore already-closed database during shutdown
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
