import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type OperatingMode = 'simulation' | 'hardware';

export const VALID_LINK_HOPS = [
  'NODE1_NODE3_WIFI',
  'NODE1_NODE2_LORA',
  'NODE2_NODE3_WIFI',
  'LEGACY_UNCLASSIFIED',
] as const;
export type LinkHopId = (typeof VALID_LINK_HOPS)[number];

export const VALID_ACK_LINK_HOPS = ['NODE1_NODE2', 'NODE2_NODE3', 'NODE1_NODE3'] as const;
export type AckLinkHop = (typeof VALID_ACK_LINK_HOPS)[number];

export const VALID_ROUTE_PATHS = [
  'DIRECT_WIFI',
  'LORA_GATEWAY',
  'LOCAL_QUEUE',
  'LEGACY_TWO_HOP',
  'LEGACY_UNCLASSIFIED',
] as const;
export type RoutePath = (typeof VALID_ROUTE_PATHS)[number];

export const VALID_RSSI_SOURCES = [
  'AP_STATION_RSSI',
  'PEER_TO_PEER_RSSI',
  'LORA_PKT_RSSI',
  'SIMULATED_LINK_RSSI',
  'UNSPECIFIED',
] as const;
export type RssiSource = (typeof VALID_RSSI_SOURCES)[number];

export const VALID_PREDICTION_SOURCES = [
  'EXTERNAL_ML',
  'SIMULATED_BASELINE',
  'LEGACY_UNCLASSIFIED',
] as const;
export type PredictionSource = (typeof VALID_PREDICTION_SOURCES)[number];

export const VALID_DATA_SOURCES = [
  'SIMULATED',
  'ESP32_HARDWARE',
  'CSV_IMPORT',
  'LEGACY_UNCLASSIFIED',
] as const;
export type DataSourceType = (typeof VALID_DATA_SOURCES)[number];

export interface SystemSettings {
  active_mode: OperatingMode;
  ack_timeout_ms: number;
  retry_limit: number;
  hysteresis_good_samples: number;
  hysteresis_bad_samples: number;
  wifi_rssi_poor_threshold: number;
  wifi_loss_poor_threshold: number;
  wifi_latency_poor_threshold: number;
  sampling_interval_ms: number;
  rain_normal_threshold: number;
  rain_heavy_threshold: number;
  ml_network_enabled: boolean;
}

export const DEFAULT_SETTINGS: SystemSettings = {
  active_mode: 'simulation',
  ack_timeout_ms: 1500,
  retry_limit: 3,
  hysteresis_good_samples: 3,
  hysteresis_bad_samples: 2,
  wifi_rssi_poor_threshold: -78,
  wifi_loss_poor_threshold: 0.25,
  wifi_latency_poor_threshold: 450,
  sampling_interval_ms: 3500,
  rain_normal_threshold: 350,
  rain_heavy_threshold: 700,
  ml_network_enabled: true,
};

const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = process.env.SQLITE_DB_PATH
  ? path.resolve(process.cwd(), process.env.SQLITE_DB_PATH)
  : path.join(DATA_DIR, 'resilient_iot.db');

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

function openHealthyDatabase(dbPath: string): DatabaseSync {
  const configurePragmas = (conn: DatabaseSync) => {
    conn.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA wal_autocheckpoint = 100;
      PRAGMA foreign_keys = ON;
    `);
  };

  try {
    const conn = new DatabaseSync(dbPath);
    configurePragmas(conn);
    const check = conn.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== 'ok') {
      throw new Error(`SQLite quick_check failed: ${check?.quick_check ?? 'unknown'}`);
    }
    return conn;
  } catch (err) {
    console.warn('[Database] Detected malformed SQLite database on startup; recreating cleanly:', err);
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${dbPath}${suffix}`;
      if (fs.existsSync(target)) {
        try {
          fs.unlinkSync(target);
        } catch {
          // ignore cleanup failure
        }
      }
    }
    const fresh = new DatabaseSync(dbPath);
    configurePragmas(fresh);
    return fresh;
  }
}

export const db = openHealthyDatabase(DB_PATH);
export const DB_FILE_PATH = DB_PATH;

const closeDbGracefully = () => {
  try {
    db.close();
  } catch {
    // ignore if already closed
  }
};
process.once('SIGINT', closeDbGracefully);
process.once('SIGTERM', closeDbGracefully);


export function initializeDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
      link_mode TEXT NOT NULL DEFAULT 'OFFLINE',
      rssi REAL,
      queue_count INTEGER NOT NULL DEFAULT 0,
      storage_status TEXT NOT NULL DEFAULT 'UNKNOWN',
      lcd_status TEXT DEFAULT NULL,
      last_heartbeat TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      UNIQUE(node_id, mode)
    );

    CREATE TABLE IF NOT EXISTS sensor_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
      packet_id INTEGER,
      node_id TEXT NOT NULL,
      temperature REAL NOT NULL,
      humidity REAL NOT NULL,
      rain_raw INTEGER NOT NULL,
      rain_category TEXT NOT NULL CHECK(rain_category IN ('DRY', 'NORMAL', 'HEAVY')),
      priority INTEGER NOT NULL,
      authenticated INTEGER NOT NULL DEFAULT 1,
      is_anomaly INTEGER NOT NULL DEFAULT 0,
      anomaly_score REAL DEFAULT 0,
      data_source TEXT NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED',
      import_batch_id INTEGER DEFAULT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS packets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
      packet_id INTEGER NOT NULL,
      sequence_number INTEGER NOT NULL,
      protocol_version INTEGER NOT NULL DEFAULT 1,
      source_node INTEGER NOT NULL DEFAULT 1,
      destination_node INTEGER NOT NULL DEFAULT 3,
      priority INTEGER NOT NULL DEFAULT 2,
      comm_mode TEXT NOT NULL DEFAULT 'WIFI',
      route_path TEXT NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED',
      encryption_status TEXT NOT NULL DEFAULT 'ENCRYPTED',
      gateway_status TEXT NOT NULL DEFAULT 'PENDING',
      destination_status TEXT NOT NULL DEFAULT 'PENDING',
      overall_status TEXT NOT NULL DEFAULT 'CREATED',
      retry_count INTEGER NOT NULL DEFAULT 0,
      nonce TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      aad TEXT NOT NULL,
      key_version TEXT NOT NULL DEFAULT 'v1',
      is_duplicate INTEGER NOT NULL DEFAULT 0,
      tampered INTEGER NOT NULL DEFAULT 0,
      node1_acked INTEGER NOT NULL DEFAULT 0,
      node2_acked INTEGER NOT NULL DEFAULT 0,
      payload_preview_json TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(mode, packet_id)
    );

    CREATE TABLE IF NOT EXISTS acknowledgements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
      packet_id INTEGER NOT NULL,
      link_hop TEXT NOT NULL CHECK(link_hop IN ('NODE1_NODE2', 'NODE2_NODE3', 'NODE1_NODE3')),
      sender_node INTEGER NOT NULL,
      receiver_node INTEGER NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT DEFAULT NULL,
      latency_ms REAL DEFAULT 0,
      authenticated_ack INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS network_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
      link_hop TEXT NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED',
      rssi REAL NOT NULL,
      rssi_variation REAL NOT NULL DEFAULT 0,
      rssi_source TEXT NOT NULL DEFAULT 'UNSPECIFIED',
      packet_loss_ratio REAL NOT NULL DEFAULT 0,
      ack_latency_ms REAL NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      queue_depth INTEGER NOT NULL DEFAULT 0,
      link_mode TEXT NOT NULL,
      node2_to_node3_status TEXT NOT NULL DEFAULT 'CONNECTED',
      data_source TEXT NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED',
      import_batch_id INTEGER DEFAULT NULL,
      ml_features_complete INTEGER NOT NULL DEFAULT 1,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS csv_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      record_type TEXT NOT NULL CHECK(record_type IN ('network', 'sensors', 'combined')),
      default_link_hop TEXT NOT NULL DEFAULT 'NODE2_NODE3_WIFI',
      row_count INTEGER NOT NULL DEFAULT 0,
      network_rows INTEGER NOT NULL DEFAULT 0,
      sensor_rows INTEGER NOT NULL DEFAULT 0,
      ml_ready_n2n3_count INTEGER NOT NULL DEFAULT 0,
      file_sha256 TEXT NOT NULL UNIQUE,
      min_recorded_at TEXT DEFAULT NULL,
      max_recorded_at TEXT DEFAULT NULL,
      uploaded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS storage_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
      node_id TEXT NOT NULL,
      storage_type TEXT NOT NULL,
      status TEXT NOT NULL,
      capacity_gb REAL DEFAULT NULL,
      pending_count INTEGER NOT NULL DEFAULT 0,
      stored_count INTEGER NOT NULL DEFAULT 0,
      sequence_counter INTEGER NOT NULL DEFAULT 0,
      storage_errors INTEGER NOT NULL DEFAULT 0,
      files_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      UNIQUE(mode, node_id)
    );

    CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
      packet_id INTEGER,
      event_type TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      status TEXT NOT NULL,
      nonce_hex TEXT,
      key_version TEXT DEFAULT 'v1',
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ml_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
      link_hop TEXT NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED',
      model_type TEXT NOT NULL,
      predicted_class TEXT NOT NULL,
      confidence REAL NOT NULL,
      risk_score REAL NOT NULL,
      baseline_class TEXT,
      predicted_wait_seconds REAL DEFAULT NULL,
      recommended_action TEXT DEFAULT NULL,
      model_version TEXT DEFAULT NULL,
      prediction_source TEXT NOT NULL DEFAULT 'SIMULATED_BASELINE',
      features_json TEXT NOT NULL DEFAULT '{}',
      model_status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS anomaly_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
      packet_id INTEGER,
      temperature REAL NOT NULL,
      humidity REAL NOT NULL,
      rain_raw INTEGER NOT NULL,
      anomaly_score REAL NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      preserved INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
      severity TEXT NOT NULL CHECK(severity IN ('INFO', 'WARNING', 'CRITICAL')),
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      related_node TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS test_results (
      test_id INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
      test_name TEXT NOT NULL,
      initial_config_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'NOT_RUN',
      passed INTEGER DEFAULT NULL,
      expected_result TEXT NOT NULL,
      actual_result TEXT DEFAULT NULL,
      steps_json TEXT NOT NULL DEFAULT '[]',
      packet_id INTEGER DEFAULT NULL,
      executed_at TEXT DEFAULT NULL,
      PRIMARY KEY(test_id, mode)
    );

    CREATE TABLE IF NOT EXISTS simulation_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      running INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0,
      speed_ms INTEGER NOT NULL DEFAULT 3500,
      node1_wifi_on INTEGER NOT NULL DEFAULT 1,
      node1_lora_on INTEGER NOT NULL DEFAULT 1,
      node2_node3_wifi_on INTEGER NOT NULL DEFAULT 1,
      drop_next_ack INTEGER NOT NULL DEFAULT 0,
      tamper_next_packet INTEGER NOT NULL DEFAULT 0,
      duplicate_next_packet INTEGER NOT NULL DEFAULT 0,
      wifi_healthy INTEGER NOT NULL DEFAULT 1,
      good_wifi_streak INTEGER NOT NULL DEFAULT 3,
      bad_wifi_streak INTEGER NOT NULL DEFAULT 0,
      node2_wifi_rssi REAL NOT NULL DEFAULT -62.0,
      node2_wifi_rssi_var REAL NOT NULL DEFAULT 1.8,
      node2_wifi_loss_ratio REAL NOT NULL DEFAULT 0.02,
      node2_wifi_latency_ms REAL NOT NULL DEFAULT 52.0,
      node2_wifi_healthy INTEGER NOT NULL DEFAULT 1,
      sequence_counter INTEGER NOT NULL DEFAULT 100,
      last_temp REAL NOT NULL DEFAULT 27.4,
      last_humidity REAL NOT NULL DEFAULT 61.5,
      last_rain_raw INTEGER NOT NULL DEFAULT 210,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS communication_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
      event_type TEXT NOT NULL,
      link_hop TEXT NOT NULL,
      comm_mode TEXT NOT NULL,
      packet_id INTEGER,
      details TEXT NOT NULL,
      rssi REAL,
      latency_ms REAL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_packets_mode_status ON packets(mode, overall_status, created_at);
    CREATE INDEX IF NOT EXISTS idx_packets_mode_gw ON packets(mode, gateway_status, destination_status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_packets_mode_nonce ON packets(mode, nonce);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sensor_readings_mode_pkt ON sensor_readings(mode, packet_id) WHERE packet_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sensor_mode_time ON sensor_readings(mode, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_metrics_mode_time ON network_metrics(mode, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_comm_mode_time ON communication_events(mode, created_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_mode_time ON system_alerts(mode, is_read, created_at);
    CREATE INDEX IF NOT EXISTS idx_security_mode_time ON security_events(mode, created_at);
    CREATE INDEX IF NOT EXISTS idx_ml_mode_time ON ml_predictions(mode, model_type, created_at);
  `);

  // ============================================================================
  // IDEMPOTENT, RECORD-PRESERVING SCHEMA MIGRATIONS (Phase 1)
  // Never delete existing rows or fabricate physical link labels for legacy rows.
  // ============================================================================

  const getCols = (tableName: string): string[] =>
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((c) => c.name);

  // 1. packets: legacy ACK columns + route_path
  const packetCols = getCols('packets');
  if (!packetCols.includes('node1_acked')) {
    db.exec('ALTER TABLE packets ADD COLUMN node1_acked INTEGER NOT NULL DEFAULT 0');
    db.exec("UPDATE packets SET node1_acked = 1 WHERE gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')");
  }
  if (!packetCols.includes('node2_acked')) {
    db.exec('ALTER TABLE packets ADD COLUMN node2_acked INTEGER NOT NULL DEFAULT 0');
    db.exec("UPDATE packets SET node2_acked = 1 WHERE destination_status = 'DELIVERED'");
  }
  if (!packetCols.includes('route_path')) {
    db.exec("ALTER TABLE packets ADD COLUMN route_path TEXT NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED'");
    // Honestly tag pre-migration rows without falsely labeling legacy Wi-Fi rows as LORA_GATEWAY or DIRECT_WIFI
    db.exec(`
      UPDATE packets
      SET route_path = CASE
        WHEN gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED') THEN 'LEGACY_TWO_HOP'
        WHEN node1_acked = 0 AND gateway_status = 'PENDING' THEN 'LOCAL_QUEUE'
        ELSE 'LEGACY_UNCLASSIFIED'
      END
      WHERE route_path = 'LEGACY_UNCLASSIFIED'
    `);
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_packets_mode_ack ON packets(mode, node1_acked, node2_acked, gateway_status, destination_status)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_packets_mode_route ON packets(mode, route_path, gateway_status, destination_status)'
  );

  // 2. acknowledgements: transactional table rebuild to widen CHECK(link_hop) to include 'NODE1_NODE3'
  const ackTableInfo = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'acknowledgements'")
    .get() as { sql?: string } | undefined;
  if (ackTableInfo?.sql && !ackTableInfo.sql.includes("'NODE1_NODE3'")) {
    withTransaction(() => {
      const beforeCount = (
        db.prepare('SELECT COUNT(*) as c FROM acknowledgements').get() as { c: number }
      ).c;

      db.exec(`
        CREATE TABLE acknowledgements_phase1_migrated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mode TEXT NOT NULL CHECK(mode IN ('simulation', 'hardware')),
          packet_id INTEGER NOT NULL,
          link_hop TEXT NOT NULL CHECK(link_hop IN ('NODE1_NODE2', 'NODE2_NODE3', 'NODE1_NODE3')),
          sender_node INTEGER NOT NULL,
          receiver_node INTEGER NOT NULL,
          status TEXT NOT NULL,
          error_code TEXT DEFAULT NULL,
          latency_ms REAL DEFAULT 0,
          authenticated_ack INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );

        INSERT INTO acknowledgements_phase1_migrated (
          id, mode, packet_id, link_hop, sender_node, receiver_node,
          status, error_code, latency_ms, authenticated_ack, created_at
        )
        SELECT
          id, mode, packet_id, link_hop, sender_node, receiver_node,
          status, error_code, latency_ms, authenticated_ack, created_at
        FROM acknowledgements;
      `);

      const afterCount = (
        db.prepare('SELECT COUNT(*) as c FROM acknowledgements_phase1_migrated').get() as { c: number }
      ).c;
      if (afterCount !== beforeCount) {
        throw new Error(
          `Acknowledgements migration row-count mismatch (before=${beforeCount}, after=${afterCount}). Rolled back.`
        );
      }

      db.exec('DROP TABLE acknowledgements;');
      db.exec('ALTER TABLE acknowledgements_phase1_migrated RENAME TO acknowledgements;');
    });
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_ack_mode_pkt_hop ON acknowledgements(mode, packet_id, link_hop)'
  );

  // 3. network_metrics: separate physical links + explicit RSSI source + simulation vs hardware vs csv data_source
  // Existing ambiguous historical rows strictly remain link_hop='LEGACY_UNCLASSIFIED' and rssi_source='UNSPECIFIED'.
  const metricCols = getCols('network_metrics');
  if (!metricCols.includes('link_hop')) {
    db.exec("ALTER TABLE network_metrics ADD COLUMN link_hop TEXT NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED'");
  }
  if (!metricCols.includes('rssi_source')) {
    db.exec("ALTER TABLE network_metrics ADD COLUMN rssi_source TEXT NOT NULL DEFAULT 'UNSPECIFIED'");
  }
  if (!metricCols.includes('data_source')) {
    db.exec("ALTER TABLE network_metrics ADD COLUMN data_source TEXT NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED'");
    db.exec(`
      UPDATE network_metrics
      SET data_source = CASE WHEN mode = 'hardware' THEN 'ESP32_HARDWARE' ELSE 'SIMULATED' END
      WHERE data_source = 'LEGACY_UNCLASSIFIED'
    `);
  }
  if (!metricCols.includes('import_batch_id')) {
    db.exec('ALTER TABLE network_metrics ADD COLUMN import_batch_id INTEGER DEFAULT NULL');
  }
  if (!metricCols.includes('ml_features_complete')) {
    db.exec('ALTER TABLE network_metrics ADD COLUMN ml_features_complete INTEGER NOT NULL DEFAULT 1');
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_metrics_mode_link_time ON network_metrics(mode, link_hop, recorded_at)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_metrics_source_link_time ON network_metrics(data_source, link_hop, recorded_at)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_metrics_batch ON network_metrics(import_batch_id)'
  );

  // 3b. sensor_readings: provenance separation + CSV batch linking
  const sensorCols = getCols('sensor_readings');
  if (!sensorCols.includes('data_source')) {
    db.exec("ALTER TABLE sensor_readings ADD COLUMN data_source TEXT NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED'");
    db.exec(`
      UPDATE sensor_readings
      SET data_source = CASE WHEN mode = 'hardware' THEN 'ESP32_HARDWARE' ELSE 'SIMULATED' END
      WHERE data_source = 'LEGACY_UNCLASSIFIED'
    `);
  }
  if (!sensorCols.includes('import_batch_id')) {
    db.exec('ALTER TABLE sensor_readings ADD COLUMN import_batch_id INTEGER DEFAULT NULL');
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_sensor_mode_source_time ON sensor_readings(mode, data_source, recorded_at)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_sensor_batch ON sensor_readings(import_batch_id)'
  );

  // 4. ml_predictions: isolate NODE2_NODE3_WIFI predictions + predictive scheduling columns
  // Existing pre-migration rows stay link_hop='LEGACY_UNCLASSIFIED' so legacy Hop-1 predictions never mix with NODE2_NODE3_WIFI.
  const mlCols = getCols('ml_predictions');
  if (!mlCols.includes('link_hop')) {
    db.exec("ALTER TABLE ml_predictions ADD COLUMN link_hop TEXT NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED'");
  }
  if (!mlCols.includes('predicted_wait_seconds')) {
    db.exec('ALTER TABLE ml_predictions ADD COLUMN predicted_wait_seconds REAL DEFAULT NULL');
  }
  if (!mlCols.includes('recommended_action')) {
    db.exec('ALTER TABLE ml_predictions ADD COLUMN recommended_action TEXT DEFAULT NULL');
  }
  if (!mlCols.includes('model_version')) {
    db.exec('ALTER TABLE ml_predictions ADD COLUMN model_version TEXT DEFAULT NULL');
  }
  if (!mlCols.includes('prediction_source')) {
    db.exec("ALTER TABLE ml_predictions ADD COLUMN prediction_source TEXT NOT NULL DEFAULT 'SIMULATED_BASELINE'");
  }
  if (!mlCols.includes('probabilities_json')) {
    db.exec('ALTER TABLE ml_predictions ADD COLUMN probabilities_json TEXT DEFAULT NULL');
  }
  if (!mlCols.includes('data_source')) {
    db.exec('ALTER TABLE ml_predictions ADD COLUMN data_source TEXT DEFAULT NULL');
  }
  if (!mlCols.includes('prediction_timestamp')) {
    db.exec('ALTER TABLE ml_predictions ADD COLUMN prediction_timestamp TEXT DEFAULT NULL');
  }
  if (!mlCols.includes('actual_wait_seconds')) {
    db.exec('ALTER TABLE ml_predictions ADD COLUMN actual_wait_seconds REAL DEFAULT NULL');
  }
  if (!mlCols.includes('observation_censored')) {
    db.exec('ALTER TABLE ml_predictions ADD COLUMN observation_censored INTEGER NOT NULL DEFAULT 0');
  }
  if (!mlCols.includes('metric_id')) {
    db.exec('ALTER TABLE ml_predictions ADD COLUMN metric_id INTEGER DEFAULT NULL');
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_ml_mode_link_time ON ml_predictions(mode, link_hop, model_type, created_at)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_ml_mode_link_src_time ON ml_predictions(mode, link_hop, prediction_source, model_type, created_at)'
  );

  // 5. simulation_state: dedicated Node 2 -> Node 3 Wi-Fi link telemetry state columns
  const simCols = getCols('simulation_state');
  if (!simCols.includes('node2_wifi_rssi')) {
    db.exec('ALTER TABLE simulation_state ADD COLUMN node2_wifi_rssi REAL NOT NULL DEFAULT -62.0');
  }
  if (!simCols.includes('node2_wifi_rssi_var')) {
    db.exec('ALTER TABLE simulation_state ADD COLUMN node2_wifi_rssi_var REAL NOT NULL DEFAULT 1.8');
  }
  if (!simCols.includes('node2_wifi_loss_ratio')) {
    db.exec('ALTER TABLE simulation_state ADD COLUMN node2_wifi_loss_ratio REAL NOT NULL DEFAULT 0.02');
  }
  if (!simCols.includes('node2_wifi_latency_ms')) {
    db.exec('ALTER TABLE simulation_state ADD COLUMN node2_wifi_latency_ms REAL NOT NULL DEFAULT 52.0');
  }
  if (!simCols.includes('node2_wifi_healthy')) {
    db.exec('ALTER TABLE simulation_state ADD COLUMN node2_wifi_healthy INTEGER NOT NULL DEFAULT 1');
  }

  const now = new Date().toISOString();

  // Seed default settings if absent
  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)'
  );
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(k, JSON.stringify(v), now);
  }

  // Seed simulation_state row if absent
  db.prepare(`
    INSERT OR IGNORE INTO simulation_state (
      id, running, paused, speed_ms, node1_wifi_on, node1_lora_on, node2_node3_wifi_on,
      drop_next_ack, tamper_next_packet, duplicate_next_packet, wifi_healthy,
      good_wifi_streak, bad_wifi_streak, node2_wifi_rssi, node2_wifi_rssi_var,
      node2_wifi_loss_ratio, node2_wifi_latency_ms, node2_wifi_healthy,
      sequence_counter, last_temp, last_humidity, last_rain_raw, updated_at
    ) VALUES (1, 1, 0, 3500, 1, 1, 1, 0, 0, 0, 1, 3, 0, -62.0, 1.8, 0.02, 52.0, 1, 100, 27.4, 61.5, 210, ?)
  `).run(now);

  // Seed nodes for both simulation and hardware modes cleanly (hardware starts NOT_CONNECTED!)
  seedDefaultNodes('simulation', now);
  seedDefaultNodes('hardware', now);

  // Upgrade existing NODE_3 rows that still have storage_status='N/A' to LittleFS status
  db.prepare(`
    UPDATE nodes
    SET
      role = 'ESP32 Authenticated Receiver (Wi-Fi + AES-128-GCM Verify/Decrypt + Display + LittleFS)',
      storage_status = CASE WHEN mode = 'simulation' THEN 'MOUNTED' ELSE 'NOT_REPORTED' END,
      updated_at = ?
    WHERE node_id = 'NODE_3' AND storage_status = 'N/A'
  `).run(now);

  // Seed storage_status for both modes (now includes NODE_3 LittleFS via INSERT OR IGNORE)
  seedDefaultStorage('simulation', now);
  seedDefaultStorage('hardware', now);
}

export function seedDefaultNodes(mode: OperatingMode, now: string): void {
  const isSim = mode === 'simulation';
  const insertNode = db.prepare(`
    INSERT OR IGNORE INTO nodes (
      node_id, mode, name, role, status, link_mode, rssi, queue_count,
      storage_status, lcd_status, last_heartbeat, metadata_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertNode.run(
    'NODE_1',
    mode,
    'Node 1 — Sensor & Transmitter',
    'ESP32 Sensor Transmitter (DHT11 + Raindrop + AES-128-GCM + LittleFS)',
    isSim ? 'ONLINE' : 'NOT_CONNECTED',
    isSim ? 'WIFI' : 'OFFLINE',
    isSim ? -61 : null,
    0,
    isSim ? 'MOUNTED' : 'NOT_REPORTED',
    null,
    isSim ? now : null,
    JSON.stringify({
      board: 'ESP32 DevKit V1 / ESP32-WROOM-32',
      sensors: { dht11: isSim ? 'OK' : 'NOT_REPORTED', raindrop: isSim ? 'OK' : 'NOT_REPORTED' },
      wifi_status: isSim ? 'CONNECTED' : 'NOT_CONNECTED',
      lora_status: isSim ? 'READY' : 'NOT_REPORTED',
      littlefs_status: isSim ? 'MOUNTED' : 'NOT_REPORTED',
      encryption: 'AES-128-GCM (Node 1 Endpoint)',
    }),
    now
  );

  insertNode.run(
    'NODE_2',
    mode,
    'Node 2 — Central Gateway',
    'ESP32 Store-and-Forward Gateway (Wi-Fi + LoRa Transceiver + 16 GB microSD)',
    isSim ? 'ONLINE' : 'NOT_CONNECTED',
    isSim ? 'WIFI' : 'OFFLINE',
    isSim ? -61 : null,
    0,
    isSim ? 'MOUNTED' : 'NOT_REPORTED',
    null,
    isSim ? now : null,
    JSON.stringify({
      board: 'ESP32 DevKit V1 / ESP32-WROOM-32',
      wifi_receiver: isSim ? 'ACTIVE' : 'NOT_CONNECTED',
      lora_transceiver: isSim ? 'READY_BIDIRECTIONAL' : 'NOT_REPORTED',
      sd_card: isSim ? 'FAT32_MOUNTED_16GB' : 'NOT_REPORTED',
      decrypts_payload: false,
      node3_link: isSim ? 'CONNECTED' : 'DISCONNECTED',
    }),
    now
  );

  insertNode.run(
    'NODE_3',
    mode,
    'Node 3 — Destination Receiver',
    'ESP32 Authenticated Receiver (Wi-Fi + AES-128-GCM Verify/Decrypt + Display + LittleFS)',
    isSim ? 'ONLINE' : 'NOT_CONNECTED',
    isSim ? 'WIFI' : 'OFFLINE',
    isSim ? -58 : null,
    0,
    isSim ? 'MOUNTED' : 'NOT_REPORTED',
    isSim ? 'ACTIVE' : 'NOT_REPORTED',
    isSim ? now : null,
    JSON.stringify({
      board: 'ESP32 DevKit V1 / ESP32-WROOM-32',
      wifi_receiver: isSim ? 'CONNECTED' : 'NOT_CONNECTED',
      littlefs_status: isSim ? 'MOUNTED' : 'NOT_REPORTED',
      aes_gcm: isSim ? 'READY' : 'NOT_REPORTED',
      lcd_line1: isSim ? 'T:27.4C H:61.5%' : 'AWAITING ESP32',
      lcd_line2: isSim ? 'RAIN:DRY  OK' : 'NOT CONNECTED',
      last_ack_status: isSim ? 'READY' : 'NONE',
    }),
    now
  );
}

export function seedDefaultStorage(mode: OperatingMode, now: string): void {
  const isSim = mode === 'simulation';
  const insertStorage = db.prepare(`
    INSERT OR IGNORE INTO storage_status (
      mode, node_id, storage_type, status, capacity_gb, pending_count,
      stored_count, sequence_counter, storage_errors, files_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertStorage.run(
    mode,
    'NODE_1',
    'LittleFS',
    isSim ? 'MOUNTED' : 'NOT_REPORTED',
    0.004,
    0,
    0,
    isSim ? 100 : 0,
    0,
    JSON.stringify(
      isSim
        ? ['/state/sequence_counter', '/state/config.json']
        : []
    ),
    now
  );

  insertStorage.run(
    mode,
    'NODE_2',
    'microSD (FAT32)',
    isSim ? 'MOUNTED' : 'NOT_REPORTED',
    16.0,
    0,
    0,
    0,
    0,
    JSON.stringify(
      isSim
        ? [
            '/gateway/received_packets.bin',
            '/gateway/node3_pending.log',
            '/gateway/delivery_status.csv',
            '/gateway/network_metrics.csv',
            '/gateway/gateway_config.json',
          ]
        : []
    ),
    now
  );

  insertStorage.run(
    mode,
    'NODE_3',
    'LittleFS',
    isSim ? 'MOUNTED' : 'NOT_REPORTED',
    0.004,
    0,
    0,
    0,
    0,
    JSON.stringify(
      isSim
        ? [
            '/receiver/verified_readings.log',
            '/receiver/dedup_ids.dat',
            '/receiver/display_state.json',
          ]
        : []
    ),
    now
  );
}

export function withTransaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSettings(): SystemSettings {
  const rows = db.prepare('SELECT key, value FROM system_settings').all() as Array<{
    key: string;
    value: string;
  }>;
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    try {
      merged[row.key] = JSON.parse(row.value);
    } catch {
      merged[row.key] = row.value;
    }
  }
  return merged as unknown as SystemSettings;
}

export function updateSettings(partial: Partial<SystemSettings>): SystemSettings {
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const allowedKeys = new Set(Object.keys(DEFAULT_SETTINGS));
  withTransaction(() => {
    for (const [k, v] of Object.entries(partial)) {
      if (allowedKeys.has(k) && v !== undefined) {
        upsert.run(k, JSON.stringify(v), now);
      }
    }
  });
  return getSettings();
}

export function getJsonSetting<T>(key: string): T | null {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setJsonSetting(key: string, value: unknown): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), now);
}

export function getActiveMode(): OperatingMode {
  const settings = getSettings();
  return settings.active_mode === 'hardware' ? 'hardware' : 'simulation';
}

export function getEffectiveMode(queryMode?: unknown): OperatingMode {
  if (queryMode === 'hardware' || queryMode === 'simulation') {
    return queryMode;
  }
  return getActiveMode();
}

export function createAlert(
  mode: OperatingMode,
  severity: 'INFO' | 'WARNING' | 'CRITICAL',
  category: string,
  message: string,
  relatedNode: string
): void {
  db.prepare(`
    INSERT INTO system_alerts (mode, severity, category, message, related_node, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(mode, severity, category, message, relatedNode, new Date().toISOString());
}

export function logCommEvent(
  mode: OperatingMode,
  eventType: string,
  linkHop: string,
  commMode: string,
  packetId: number | null,
  details: string,
  rssi: number | null = null,
  latencyMs: number | null = null
): void {
  db.prepare(`
    INSERT INTO communication_events (mode, event_type, link_hop, comm_mode, packet_id, details, rssi, latency_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(mode, eventType, linkHop, commMode, packetId, details, rssi, latencyMs, new Date().toISOString());
}

export function logSecurityEvent(
  mode: OperatingMode,
  packetId: number | null,
  eventType: string,
  endpoint: string,
  status: string,
  nonceHex: string | null,
  keyVersion: string,
  details: string
): void {
  db.prepare(`
    INSERT INTO security_events (mode, packet_id, event_type, endpoint, status, nonce_hex, key_version, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(mode, packetId, eventType, endpoint, status, nonceHex, keyVersion, details, new Date().toISOString());
}

export const VALID_PACKET_STATUSES = [
  'CREATED',
  'ENCRYPTED',
  'PENDING',
  'TRANSMITTED',
  'GATEWAY_STORED',
  'FORWARDED',
  'DELIVERED',
  'RETRYING',
  'REJECTED',
] as const;

export type PacketLifecycleStatus = (typeof VALID_PACKET_STATUSES)[number];

export function getAllPersistedNonces(): string[] {
  const rows = db.prepare('SELECT nonce FROM packets').all() as Array<{ nonce: string }>;
  return rows.map((r) => r.nonce);
}

const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  CREATED: new Set(['ENCRYPTED']),
  ENCRYPTED: new Set(['PENDING', 'TRANSMITTED']),
  PENDING: new Set(['TRANSMITTED', 'RETRYING']),
  TRANSMITTED: new Set(['GATEWAY_STORED', 'DELIVERED', 'REJECTED', 'RETRYING', 'PENDING']),
  RETRYING: new Set(['TRANSMITTED', 'GATEWAY_STORED', 'FORWARDED', 'DELIVERED', 'REJECTED', 'PENDING']),
  GATEWAY_STORED: new Set(['FORWARDED', 'RETRYING', 'GATEWAY_STORED', 'REJECTED']),
  FORWARDED: new Set(['DELIVERED', 'REJECTED', 'RETRYING', 'FORWARDED']),
  DELIVERED: new Set(['DELIVERED']), // Terminal state: never regress after matching Node 3 ACK
  REJECTED: new Set(['REJECTED']),   // Terminal state: never accept after AES-GCM failure
};

export function canTransitionPacketStatus(current: string, next: string): boolean {
  const allowed = ALLOWED_TRANSITIONS[current];
  if (!allowed) return false;
  return allowed.has(next);
}

