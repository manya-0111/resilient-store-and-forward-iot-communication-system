import {
  db,
  withTransaction,
  getSettings,
  createAlert,
  logCommEvent,
  logSecurityEvent,
  seedDefaultNodes,
  seedDefaultStorage,
  type LinkHopId,
  type RssiSource,
} from './database.ts';
import { securityManager } from './securityManager.ts';
import { resolveSchedulingObservationsOnReconnect } from './mlNetwork.ts';

export const PACKET_LOSS_WINDOW_SIZE = 20;

export interface SimStateRow {
  id: number;
  running: number;
  paused: number;
  speed_ms: number;
  node1_wifi_on: number;
  node1_lora_on: number;
  node2_node3_wifi_on: number;
  drop_next_ack: number;
  tamper_next_packet: number;
  duplicate_next_packet: number;
  wifi_healthy: number;
  good_wifi_streak: number;
  bad_wifi_streak: number;
  node2_wifi_rssi: number;
  node2_wifi_rssi_var: number;
  node2_wifi_loss_ratio: number;
  node2_wifi_latency_ms: number;
  node2_wifi_healthy: number;
  sequence_counter: number;
  last_temp: number;
  last_humidity: number;
  last_rain_raw: number;
  updated_at: string;
}

export interface PacketRow {
  id: number;
  mode: string;
  packet_id: number;
  sequence_number: number;
  protocol_version: number;
  source_node: number;
  destination_node: number;
  priority: number;
  comm_mode: string;
  route_path: string;
  encryption_status: string;
  gateway_status: string;
  destination_status: string;
  overall_status: string;
  retry_count: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
  aad: string;
  key_version: string;
  is_duplicate: number;
  tampered: number;
  node1_acked: number;
  node2_acked: number;
  payload_preview_json: string | null;
  created_at: string;
  updated_at: string;
}

export function classifyRain(
  rainRaw: number,
  normalThreshold = 350,
  heavyThreshold = 700
): { category: 'DRY' | 'NORMAL' | 'HEAVY'; priority: number } {
  if (rainRaw >= heavyThreshold) {
    return { category: 'HEAVY', priority: 1 }; // Deterministic high-priority override
  }
  if (rainRaw >= normalThreshold) {
    return { category: 'NORMAL', priority: 2 };
  }
  return { category: 'DRY', priority: 2 };
}

class SimulationEngine {
  private timer: NodeJS.Timeout | null = null;
  // Independent RF & packet-loss observation windows (N = 20 attempts) per physical link — NEVER mixed!
  private lastDirectWifiRssi = -60;
  private directWifiAttempts: boolean[] = [true, true, true, true, true, true, true, true];

  private lastLoraRssi = -94;
  private loraAttempts: boolean[] = [true, true, true, true, true, true, true, true];

  private lastNode2WifiRssi = -62;
  private node2WifiAttempts: boolean[] = [true, true, true, true, true, true, true, true];

  private lastSampleTimeMs = Date.now() - 3500;

  private pushAttempt(windowArr: boolean[], success: boolean): number {
    windowArr.push(success);
    if (windowArr.length > PACKET_LOSS_WINDOW_SIZE) {
      windowArr.shift();
    }
    const failed = windowArr.filter((ok) => !ok).length;
    return Number((failed / windowArr.length).toFixed(3));
  }

  private computeWindowLoss(windowArr: boolean[]): number {
    if (windowArr.length === 0) return 0;
    const failed = windowArr.filter((ok) => !ok).length;
    return Number((failed / windowArr.length).toFixed(3));
  }

  public getState(): SimStateRow {
    return db.prepare('SELECT * FROM simulation_state WHERE id = 1').get() as unknown as SimStateRow;
  }

  private updateState(updates: Partial<SimStateRow>): SimStateRow {
    const allowed = [
      'running',
      'paused',
      'speed_ms',
      'node1_wifi_on',
      'node1_lora_on',
      'node2_node3_wifi_on',
      'drop_next_ack',
      'tamper_next_packet',
      'duplicate_next_packet',
      'wifi_healthy',
      'good_wifi_streak',
      'bad_wifi_streak',
      'node2_wifi_rssi',
      'node2_wifi_rssi_var',
      'node2_wifi_loss_ratio',
      'node2_wifi_latency_ms',
      'node2_wifi_healthy',
      'sequence_counter',
      'last_temp',
      'last_humidity',
      'last_rain_raw',
    ] as const;

    const sets: string[] = [];
    const params: Array<string | number> = [];

    for (const key of allowed) {
      if (updates[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(updates[key] as number);
      }
    }
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());

    db.prepare(`UPDATE simulation_state SET ${sets.join(', ')} WHERE id = 1`).run(...params);
    return this.getState();
  }

  public startLoopIfRunning(): void {
    const state = this.getState();
    // Seed initial realistic history once if simulation has zero packets
    const pktCount = (
      db.prepare("SELECT COUNT(*) as c FROM packets WHERE mode = 'simulation'").get() as { c: number }
    ).c;
    if (pktCount === 0) {
      this.seedInitialSimulationHistory();
    }
    if (state.running && !state.paused) {
      this.scheduleTimer(state.speed_ms);
    }
  }

  private scheduleTimer(speedMs: number): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const clamped = Math.max(1200, Math.min(15000, speedMs));
    this.timer = setInterval(() => {
      try {
        const s = this.getState();
        if (s.running && !s.paused) {
          this.stepSimulation();
        }
      } catch (err) {
        console.error('[SimulationEngine] tick error:', err);
      }
    }, clamped);
  }

  public start(): SimStateRow {
    const s = this.updateState({ running: 1, paused: 0 });
    this.scheduleTimer(s.speed_ms);
    return s;
  }

  public pause(): SimStateRow {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.updateState({ paused: 1 });
  }

  public resume(): SimStateRow {
    const s = this.updateState({ running: 1, paused: 0 });
    this.scheduleTimer(s.speed_ms);
    return s;
  }

  public setSpeed(speedMs: number): SimStateRow {
    const clamped = Math.max(1200, Math.min(15000, Math.round(speedMs)));
    const s = this.updateState({ speed_ms: clamped });
    if (s.running && !s.paused) {
      this.scheduleTimer(clamped);
    }
    return s;
  }

  public resetSimulation(): SimStateRow {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const now = new Date().toISOString();
    withTransaction(() => {
      const tables = [
        'nodes',
        'sensor_readings',
        'packets',
        'acknowledgements',
        'network_metrics',
        'storage_status',
        'security_events',
        'ml_predictions',
        'anomaly_events',
        'system_alerts',
        'communication_events',
      ];
      for (const table of tables) {
        db.prepare(`DELETE FROM ${table} WHERE mode = 'simulation'`).run();
      }
      db.prepare(`
        UPDATE simulation_state SET
          running = 1, paused = 0, speed_ms = 3500,
          node1_wifi_on = 1, node1_lora_on = 1, node2_node3_wifi_on = 1,
          drop_next_ack = 0, tamper_next_packet = 0, duplicate_next_packet = 0,
          wifi_healthy = 1, good_wifi_streak = 3, bad_wifi_streak = 0,
          node2_wifi_rssi = -62.0, node2_wifi_rssi_var = 1.8, node2_wifi_loss_ratio = 0.02,
          node2_wifi_latency_ms = 52.0, node2_wifi_healthy = 1,
          sequence_counter = 100, last_temp = 27.4, last_humidity = 61.5, last_rain_raw = 210,
          updated_at = ?
        WHERE id = 1
      `).run(now);
      seedDefaultNodes('simulation', now);
      seedDefaultStorage('simulation', now);
    });
    this.lastDirectWifiRssi = -60;
    this.directWifiAttempts = [true, true, true, true, true, true, true, true];
    this.lastLoraRssi = -94;
    this.loraAttempts = [true, true, true, true, true, true, true, true];
    this.lastNode2WifiRssi = -62;
    this.node2WifiAttempts = [true, true, true, true, true, true, true, true];
    this.seedInitialSimulationHistory();
    const state = this.getState();
    this.scheduleTimer(state.speed_ms);
    return state;
  }

  private seedInitialSimulationHistory(): void {
    // Generate 8 realistic initial simulation packets across normal + 1 heavy rain so charts/tables are live immediately
    const samples = [
      { temp: 26.8, hum: 58.2, rain: 180 },
      { temp: 27.0, hum: 59.4, rain: 205 },
      { temp: 27.2, hum: 60.8, rain: 240 },
      { temp: 27.5, hum: 63.1, rain: 390 },
      { temp: 27.3, hum: 66.5, rain: 460 },
      { temp: 26.9, hum: 74.2, rain: 790 }, // Heavy rain high priority
      { temp: 26.7, hum: 71.0, rain: 410 },
      { temp: 27.1, hum: 64.0, rain: 225 },
    ];
    for (const s of samples) {
      this.createAndProcessPacket({
        temperature: s.temp,
        humidity: s.hum,
        rain_raw: s.rain,
      });
    }
  }

  /**
   * Configures the 3 independent link toggles cleanly and resets transient link-loss windows:
   * - wifi13: NODE1_NODE3_WIFI (Direct Wi-Fi, Scenario A, bypasses Node 2)
   * - lora12: NODE1_NODE2_LORA (LoRa fallback, Scenario B Hop 1)
   * - wifi23: NODE2_NODE3_WIFI (Gateway-to-Receiver Wi-Fi, Scenario B Hop 2 & ML target)
   */
  public configureLinks(wifi13: boolean, lora12: boolean, wifi23: boolean): SimStateRow {
    const updated = this.updateState({
      node1_wifi_on: wifi13 ? 1 : 0,
      node1_lora_on: lora12 ? 1 : 0,
      node2_node3_wifi_on: wifi23 ? 1 : 0,
      wifi_healthy: wifi13 ? 1 : 0,
      good_wifi_streak: wifi13 ? 3 : 0,
      bad_wifi_streak: wifi13 ? 0 : 3,
      node2_wifi_healthy: wifi23 ? 1 : 0,
      node2_wifi_rssi: wifi23 ? -62.0 : -110.0,
      node2_wifi_loss_ratio: wifi23 ? 0.0 : 1.0,
    });
    this.lastDirectWifiRssi = wifi13 ? -60 : -110;
    this.directWifiAttempts = wifi13
      ? [true, true, true, true, true, true, true, true]
      : [false, false, false, false];
    this.lastLoraRssi = lora12 ? -94 : -120;
    this.loraAttempts = lora12
      ? [true, true, true, true, true, true, true, true]
      : [false, false, false, false];
    this.lastNode2WifiRssi = wifi23 ? -62 : -110;
    this.node2WifiAttempts = wifi23
      ? [true, true, true, true, true, true, true, true]
      : [false, false, false, false];
    this.syncNodeAndStorageSummaries();
    return updated;
  }

  /**
   * Simulates power-cycling Node 1 (LittleFS) and Node 2 (microSD) while packets are pending,
   * resetting volatile in-memory state and re-hydrating persistent queues & sequence counter from SQLite.
   */
  public simulateNodesRestart(): {
    recoveredNode1Pending: number[];
    recoveredNode2Pending: number[];
    sequenceCounter: number;
  } {
    const now = new Date().toISOString();

    // Step A: Mark NODE_1 & NODE_2 RESTARTING and clear volatile runtime buffers
    db.prepare(`
      UPDATE nodes SET status = 'RESTARTING', updated_at = ?
      WHERE mode = 'simulation' AND node_id IN ('NODE_1', 'NODE_2')
    `).run(now);

    this.lastDirectWifiRssi = -60;
    this.directWifiAttempts = [true, true, true, true, true, true, true, true];
    this.lastLoraRssi = -94;
    this.loraAttempts = [true, true, true, true, true, true, true, true];
    this.lastNode2WifiRssi = -62;
    this.node2WifiAttempts = [true, true, true, true, true, true, true, true];

    // Step B: Re-hydrate persistent sequence counter & pending queues strictly from SQLite
    const state = this.getState();
    const maxSeqRow = db
      .prepare("SELECT COALESCE(MAX(sequence_number), 100) as m FROM packets WHERE mode = 'simulation'")
      .get() as { m: number };
    const recoveredSeq = Math.max(state.sequence_counter, maxSeqRow.m);
    if (recoveredSeq !== state.sequence_counter) {
      this.updateState({ sequence_counter: recoveredSeq });
    }

    const n1Pending = (
      db
        .prepare(
          "SELECT packet_id FROM packets WHERE mode = 'simulation' AND node1_acked = 0 AND destination_status != 'REJECTED' ORDER BY priority ASC, packet_id ASC"
        )
        .all() as Array<{ packet_id: number }>
    ).map((r) => r.packet_id);

    const n2Pending = (
      db
        .prepare(
          "SELECT packet_id FROM packets WHERE mode = 'simulation' AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED') AND node2_acked = 0 AND destination_status != 'REJECTED' ORDER BY priority ASC, packet_id ASC"
        )
        .all() as Array<{ packet_id: number }>
    ).map((r) => r.packet_id);

    logCommEvent(
      'simulation',
      'NODE_RESTART',
      'NODE1_NODE2',
      'RECOVERY',
      n1Pending[0] ?? null,
      `Node 1 & Node 2 power-cycled. Volatile state cleared; reloading LittleFS (${n1Pending.length} pending) and microSD (${n2Pending.length} pending) from persistent storage.`
    );
    logCommEvent(
      'simulation',
      'QUEUE_RECOVERED',
      'NODE2_NODE3',
      'RECOVERY',
      n2Pending[0] ?? null,
      `Persistent queues recovered after restart: Node 1 LittleFS=[${n1Pending.join(', ')}], Node 2 microSD=[${n2Pending.join(', ')}], sequence_counter=#${recoveredSeq}.`
    );
    createAlert(
      'simulation',
      'INFO',
      'TEST_RESTART_RECOVERY',
      `Nodes restarted: recovered ${n1Pending.length} Node 1 LittleFS and ${n2Pending.length} Node 2 microSD pending packet(s) with sequence_counter=#${recoveredSeq}.`,
      'NODE_1'
    );

    // Step C: Bring nodes back ONLINE with exact re-hydrated persistent storage counts
    this.syncNodeAndStorageSummaries();

    return {
      recoveredNode1Pending: n1Pending,
      recoveredNode2Pending: n2Pending,
      sequenceCounter: recoveredSeq,
    };
  }

  public syncNodeAndStorageSummaries(): void {
    const now = new Date().toISOString();
    const state = this.getState();

    const node1PendingRows = db
      .prepare(
        "SELECT packet_id FROM packets WHERE mode = 'simulation' AND node1_acked = 0 AND destination_status != 'REJECTED' ORDER BY priority ASC, packet_id ASC"
      )
      .all() as Array<{ packet_id: number }>;

    const node2StoredCount = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM packets WHERE mode = 'simulation' AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')"
        )
        .get() as { c: number }
    ).c;

    const node2PendingNode3Rows = db
      .prepare(
        "SELECT packet_id FROM packets WHERE mode = 'simulation' AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED') AND node2_acked = 0 AND destination_status != 'REJECTED' ORDER BY priority ASC, packet_id ASC"
      )
      .all() as Array<{ packet_id: number }>;

    const node3StoredCount = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM sensor_readings WHERE mode = 'simulation' AND authenticated = 1"
        )
        .get() as { c: number }
    ).c;

    const node3LastSeq = (
      db
        .prepare(
          "SELECT COALESCE(MAX(packet_id), 0) as m FROM sensor_readings WHERE mode = 'simulation' AND authenticated = 1"
        )
        .get() as { m: number }
    ).m;

    const latestReading = db
      .prepare(
        "SELECT * FROM sensor_readings WHERE mode = 'simulation' AND authenticated = 1 ORDER BY id DESC LIMIT 1"
      )
      .get() as
      | { temperature: number; humidity: number; rain_category: string; packet_id: number }
      | undefined;

    const directWifiActive = Boolean(state.node1_wifi_on && state.wifi_healthy);
    const linkModeNode1 = directWifiActive
      ? 'WIFI'
      : state.node1_lora_on
        ? 'LORA'
        : 'OFFLINE';

    const node2To3State = state.node2_node3_wifi_on
      ? node2PendingNode3Rows.length > 0
        ? 'RETRYING'
        : 'CONNECTED'
      : 'DISCONNECTED';

    const node3Reachable = Boolean(state.node1_wifi_on || state.node2_node3_wifi_on);

    // Update NODE_1
    db.prepare(`
      UPDATE nodes SET
        status = 'ONLINE',
        link_mode = ?,
        rssi = ?,
        queue_count = ?,
        storage_status = 'MOUNTED',
        last_heartbeat = ?,
        metadata_json = ?,
        updated_at = ?
      WHERE node_id = 'NODE_1' AND mode = 'simulation'
    `).run(
      linkModeNode1,
      directWifiActive ? this.lastDirectWifiRssi : state.node1_lora_on ? this.lastLoraRssi : -110,
      node1PendingRows.length,
      now,
      JSON.stringify({
        board: 'ESP32 DevKit V1 / ESP32-WROOM-32',
        sensors: { dht11: 'OK', raindrop: 'OK' },
        direct_wifi_target: 'NODE_3',
        wifi_status: state.node1_wifi_on ? (state.wifi_healthy ? 'DIRECT_TO_NODE3' : 'DEGRADED') : 'OFF',
        lora_status: state.node1_lora_on ? (linkModeNode1 === 'LORA' ? 'ACTIVE_FALLBACK_TO_NODE2' : 'STANDBY') : 'OFF',
        littlefs_status: 'MOUNTED',
        pending_ids: node1PendingRows.map((r) => r.packet_id),
        sequence_counter: state.sequence_counter,
        wifi_healthy: Boolean(state.wifi_healthy),
        good_wifi_streak: state.good_wifi_streak,
        encryption: 'AES-128-GCM (Node 1 Endpoint)',
      }),
      now
    );

    // Update NODE_2 (Receives ONLY via LoRa from Node 1; forwards ONLY via Wi-Fi to Node 3; bypassed during Scenario A)
    db.prepare(`
      UPDATE nodes SET
        status = 'ONLINE',
        link_mode = ?,
        rssi = ?,
        queue_count = ?,
        storage_status = 'MOUNTED',
        last_heartbeat = ?,
        metadata_json = ?,
        updated_at = ?
      WHERE node_id = 'NODE_2' AND mode = 'simulation'
    `).run(
      directWifiActive ? 'BYPASSED_STANDBY' : state.node1_lora_on ? 'LORA_FALLBACK' : 'STANDBY',
      state.node2_node3_wifi_on ? this.lastNode2WifiRssi : null,
      node2PendingNode3Rows.length,
      now,
      JSON.stringify({
        board: 'ESP32 DevKit V1 / ESP32-WROOM-32',
        bypassed_on_direct_wifi: directWifiActive,
        lora_ingress: state.node1_lora_on
          ? directWifiActive
            ? 'STANDBY_BYPASSED'
            : 'ACTIVE_RX_FROM_NODE1'
          : 'OFFLINE',
        lora_transceiver: state.node1_lora_on ? 'BIDIRECTIONAL_READY' : 'OFFLINE',
        wifi_forward_to_node3: node2To3State,
        sd_card: 'FAT32_MOUNTED_16GB',
        decrypts_payload: false,
        node3_link: node2To3State,
        stored_count: node2StoredCount,
        pending_node3_ids: node2PendingNode3Rows.map((r) => r.packet_id),
      }),
      now
    );

    // Update NODE_3 (ESP32 + Wi-Fi + Display + LittleFS storage — NEVER N/A!)
    const lcd1 = latestReading
      ? `T:${latestReading.temperature.toFixed(1)}C H:${latestReading.humidity.toFixed(0)}%`
      : 'AWAITING DATA';
    const lcd2 = latestReading
      ? `RAIN:${latestReading.rain_category} #${latestReading.packet_id}`
      : 'AUTH REQUIRED';

    db.prepare(`
      UPDATE nodes SET
        status = ?,
        link_mode = ?,
        rssi = ?,
        queue_count = 0,
        storage_status = 'MOUNTED',
        lcd_status = ?,
        last_heartbeat = ?,
        metadata_json = ?,
        updated_at = ?
      WHERE node_id = 'NODE_3' AND mode = 'simulation'
    `).run(
      node3Reachable ? 'ONLINE' : 'OFFLINE',
      node3Reachable ? 'WIFI' : 'OFFLINE',
      state.node1_wifi_on
        ? this.lastDirectWifiRssi
        : state.node2_node3_wifi_on
          ? this.lastNode2WifiRssi
          : null,
      node3Reachable ? 'ACTIVE' : 'STANDBY_LAST_AUTH',
      node3Reachable ? now : null,
      JSON.stringify({
        board: 'ESP32 DevKit V1 / ESP32-WROOM-32',
        wifi_receiver: node3Reachable ? 'CONNECTED' : 'DISCONNECTED',
        direct_wifi_from_node1: state.node1_wifi_on ? 'CONNECTED' : 'OFFLINE',
        gateway_wifi_from_node2: state.node2_node3_wifi_on ? 'CONNECTED' : 'DISCONNECTED',
        littlefs_status: 'MOUNTED',
        littlefs_stored_readings: node3StoredCount,
        aes_gcm: 'VERIFY_BEFORE_DISPLAY',
        lcd_line1: lcd1,
        lcd_line2: lcd2,
        last_authenticated_packet: latestReading?.packet_id ?? null,
      }),
      now
    );

    // Update Node 1 LittleFS storage status
    const littlefsFiles = [
      ...node1PendingRows.map(
        (r) => `/pending/packet_${String(r.packet_id).padStart(6, '0')}.bin`
      ),
      '/state/sequence_counter',
      '/state/config.json',
    ];
    db.prepare(`
      UPDATE storage_status SET
        status = 'MOUNTED',
        pending_count = ?,
        stored_count = ?,
        sequence_counter = ?,
        files_json = ?,
        updated_at = ?
      WHERE mode = 'simulation' AND node_id = 'NODE_1'
    `).run(
      node1PendingRows.length,
      node1PendingRows.length,
      state.sequence_counter,
      JSON.stringify(littlefsFiles),
      now
    );

    // Update Node 2 microSD storage status (counts ONLY gateway-stored LoRa/2-hop packets, NEVER bypassed direct Wi-Fi!)
    const sdFiles = [
      `/gateway/received_packets.bin (${node2StoredCount} envelopes)`,
      `/gateway/node3_pending.log (${node2PendingNode3Rows.length} pending IDs)`,
      '/gateway/delivery_status.csv',
      '/gateway/network_metrics.csv',
      '/gateway/gateway_config.json',
    ];
    db.prepare(`
      UPDATE storage_status SET
        status = 'MOUNTED',
        capacity_gb = 16.0,
        pending_count = ?,
        stored_count = ?,
        sequence_counter = ?,
        files_json = ?,
        updated_at = ?
      WHERE mode = 'simulation' AND node_id = 'NODE_2'
    `).run(
      node2PendingNode3Rows.length,
      node2StoredCount,
      state.sequence_counter,
      JSON.stringify(sdFiles),
      now
    );

    // Update Node 3 LittleFS storage status
    const node3Files = [
      `/receiver/verified_readings.log (${node3StoredCount} authenticated records)`,
      `/receiver/dedup_ids.dat (last_id=#${node3LastSeq})`,
      '/receiver/display_state.json',
    ];
    db.prepare(`
      UPDATE storage_status SET
        status = 'MOUNTED',
        capacity_gb = 0.004,
        pending_count = 0,
        stored_count = ?,
        sequence_counter = ?,
        files_json = ?,
        updated_at = ?
      WHERE mode = 'simulation' AND node_id = 'NODE_3'
    `).run(
      node3StoredCount,
      node3LastSeq,
      JSON.stringify(node3Files),
      now
    );
  }

  /**
   * Generates a new reading at Node 1, encrypts it once with AES-128-GCM,
   * persists in LittleFS queue, and runs both independent hops.
   */
  public createAndProcessPacket(options?: {
    temperature?: number;
    humidity?: number;
    rain_raw?: number;
    forceHeavyRain?: boolean;
    forceTamper?: boolean;
    tamperTarget?: 'ciphertext' | 'tag';
    forceDropAck?: boolean;
    forceDropHop2Ack?: boolean;
    forceDuplicate?: boolean;
  }): { packet_id: number; overall_status: string } {
    const settings = getSettings();
    let state = this.getState();

    // Generate realistic environmental drift unless explicitly overridden
    const driftT = (Math.random() - 0.5) * 0.7;
    const driftH = (Math.random() - 0.5) * 2.4;
    let temp =
      options?.temperature ??
      Number(Math.max(18, Math.min(39, state.last_temp + driftT)).toFixed(1));
    let hum =
      options?.humidity ??
      Number(Math.max(35, Math.min(92, state.last_humidity + driftH)).toFixed(1));
    let rainRaw =
      options?.rain_raw ??
      Math.max(
        60,
        Math.min(
          1023,
          Math.round(
            state.last_rain_raw + (Math.random() < 0.14 ? 260 : (Math.random() - 0.52) * 90)
          )
        )
      );

    if (options?.forceHeavyRain) {
      rainRaw = Math.max(settings.rain_heavy_threshold + 120, 845);
      hum = Math.min(94, Math.max(hum, 81.5));
    }

    const { category: rainCategory, priority } = classifyRain(
      rainRaw,
      settings.rain_normal_threshold,
      settings.rain_heavy_threshold
    );

    const maxExistingRow = db
      .prepare("SELECT COALESCE(MAX(packet_id), 100) as m FROM packets WHERE mode = 'simulation'")
      .get() as { m: number };
    const nextSeq = Math.max(state.sequence_counter, maxExistingRow.m) + 1;
    const packetId = nextSeq;
    const now = new Date().toISOString();

    const plaintextPayload = {
      rain: rainCategory,
      rain_raw: rainRaw,
      temperature: temp,
      humidity: hum,
    };

    const nonceExistsInDb = (nonceHex: string): boolean => {
      const hit = db
        .prepare("SELECT 1 FROM packets WHERE mode = 'simulation' AND nonce = ? LIMIT 1")
        .get(nonceHex);
      return Boolean(hit);
    };

    // Node 1 encrypts ONCE with a unique 96-bit nonce and AAD.
    // Plaintext is NOT stored in the packets table (Node 2 only stores/forwards opaque ciphertext).
    const envelope = securityManager.encryptAtNode1(
      packetId,
      priority,
      plaintextPayload,
      1,
      1,
      3,
      nonceExistsInDb
    );

    const willDropAck = Boolean(options?.forceDropAck || state.drop_next_ack);
    const willTamper = Boolean(options?.forceTamper || state.tamper_next_packet);
    const willDuplicate = Boolean(options?.forceDuplicate || state.duplicate_next_packet);

    withTransaction(() => {
      // Explicit lifecycle: CREATED -> ENCRYPTED -> PENDING (persisted in Node 1 LittleFS, node1_acked=0)
      db.prepare(`
        INSERT INTO packets (
          mode, packet_id, sequence_number, protocol_version, source_node, destination_node,
          priority, comm_mode, route_path, encryption_status, gateway_status, destination_status,
          overall_status, retry_count, nonce, ciphertext, auth_tag, aad, key_version,
          is_duplicate, tampered, node1_acked, node2_acked, payload_preview_json, created_at, updated_at
        ) VALUES (
          'simulation', ?, ?, ?, ?, ?,
          ?, 'PENDING', 'LOCAL_QUEUE', 'ENCRYPTED', 'PENDING', 'PENDING',
          'PENDING', 0, ?, ?, ?, ?, ?,
          0, 0, 0, 0, NULL, ?, ?
        )
      `).run(
        packetId,
        nextSeq,
        envelope.version,
        envelope.source,
        envelope.destination,
        priority,
        envelope.nonce,
        envelope.ciphertext,
        envelope.tag,
        envelope.aad,
        envelope.key_version,
        now,
        now
      );

      logSecurityEvent(
        'simulation',
        packetId,
        'ENCRYPT',
        'NODE_1',
        'SUCCESS',
        envelope.nonce,
        envelope.key_version,
        `Node 1 created packet #${packetId}, encrypted once with AES-128-GCM unique 96-bit nonce and AAD, and persisted to LittleFS.`
      );

      if (rainCategory === 'HEAVY') {
        createAlert(
          'simulation',
          'CRITICAL',
          'HEAVY_RAIN',
          `Heavy rain detected at Node 1 (raw=${rainRaw}). Deterministic HIGH priority (#1) assigned to packet #${packetId}.`,
          'NODE_1'
        );
      }

      this.updateState({
        sequence_counter: nextSeq,
        last_temp: temp,
        last_humidity: hum,
        last_rain_raw: rainRaw,
        drop_next_ack: 0,
        tamper_next_packet: 0,
        duplicate_next_packet: 0,
      });
    });

    // Process Node 1 pending queue (Scenario A Direct Wi-Fi bypass, Scenario B LoRa fallback, or Scenario C LittleFS retention)
    this.drainNode1PendingQueue({
      targetPacketId: packetId,
      dropAckOnce: willDropAck,
      duplicateOnce: willDuplicate,
      tamperOnce: willTamper,
      tamperTarget: options?.tamperTarget,
    });

    // Process Node 2 microSD pending queue (Scenario B Hop-2 Wi-Fi forwarding to Node 3 — NEVER touches bypassed direct Wi-Fi packets)
    const forwardedFromNode2 = this.drainNode2PendingQueue({
      targetPacketId: packetId,
      tamperOnce: willTamper,
      tamperTarget: options?.tamperTarget,
      dropHop2AckOnce: Boolean(options?.forceDropHop2Ack),
    });

    // Independently probe & record NODE2_NODE3_WIFI link health even when Scenario A bypassed Node 2
    // so Node 2 -> Node 3 Wi-Fi maintains a continuous, independent, ML-ready telemetry stream.
    if (forwardedFromNode2 === 0) {
      this.probeNode2To3WifiLink();
    }

    this.syncNodeAndStorageSummaries();

    const finalPkt = db
      .prepare("SELECT overall_status FROM packets WHERE mode = 'simulation' AND packet_id = ?")
      .get(packetId) as { overall_status: string } | undefined;

    return {
      packet_id: packetId,
      overall_status: finalPkt?.overall_status ?? 'PENDING',
    };
  }

  /**
   * Node 1 Transmitter Path Selection:
   * - Scenario A (Preferred): Direct Wi-Fi Node 1 -> Node 3 (NODE1_NODE3_WIFI). Node 2 is COMPLETELY BYPASSED.
   * - Scenario B (Fallback): LoRa Node 1 -> Node 2 (NODE1_NODE2_LORA). Node 2 validates, deduplicates, stores on microSD, and ACKs Node 1.
   * - Scenario C (Offline): Both paths unavailable -> Retain encrypted packet in Node 1 LittleFS queue.
   */
  public drainNode1PendingQueue(opts?: {
    targetPacketId?: number;
    dropAckOnce?: boolean;
    duplicateOnce?: boolean;
    tamperOnce?: boolean;
    tamperTarget?: 'ciphertext' | 'tag';
  }): number {
    const settings = getSettings();
    let state = this.getState();

    // Priority 1 (HEAVY RAIN) ALWAYS dequeued before Priority 2 (ROUTINE).
    // Node 1 retains every packet in LittleFS until a matching ACK (Node 3 direct ACK in Scenario A, or Node 2 storage ACK in Scenario B) sets node1_acked = 1.
    const pending = db
      .prepare(
        "SELECT * FROM packets WHERE mode = 'simulation' AND node1_acked = 0 AND destination_status != 'REJECTED' ORDER BY priority ASC, packet_id ASC LIMIT 12"
      )
      .all() as unknown as PacketRow[];

    if (pending.length === 0) return 0;

    let retiredFromNode1 = 0;

    for (const pkt of pending) {
      state = this.getState();
      const now = new Date().toISOString();

      // Evaluate Link 1 (NODE1_NODE3_WIFI) direct Wi-Fi health with hysteresis
      const directWifiRssi = state.node1_wifi_on
        ? Number((-56 - Math.random() * 14).toFixed(1))
        : -110;
      const directWifiRssiVar = Number(Math.abs(directWifiRssi - this.lastDirectWifiRssi).toFixed(2));
      this.lastDirectWifiRssi = directWifiRssi;

      const directWifiLoss = this.computeWindowLoss(this.directWifiAttempts);
      const directWifiLatency = state.node1_wifi_on
        ? Number((38 + Math.random() * 58).toFixed(1))
        : settings.ack_timeout_ms;

      const rawDirectWifiGood =
        Boolean(state.node1_wifi_on) &&
        directWifiRssi > settings.wifi_rssi_poor_threshold &&
        directWifiLoss < settings.wifi_loss_poor_threshold &&
        directWifiLatency < settings.wifi_latency_poor_threshold;

      let wifiHealthy = Boolean(state.wifi_healthy);
      let goodStreak = state.good_wifi_streak;
      let badStreak = state.bad_wifi_streak;

      if (rawDirectWifiGood) {
        goodStreak++;
        badStreak = 0;
        if (!wifiHealthy && goodStreak >= settings.hysteresis_good_samples) {
          wifiHealthy = true;
          logCommEvent(
            'simulation',
            'LINK_RECOVERY',
            'NODE1_NODE3',
            'WIFI',
            pkt.packet_id,
            `Direct Wi-Fi (Node 1 → Node 3) restored after ${goodStreak} consecutive healthy samples (hysteresis satisfied).`,
            directWifiRssi,
            directWifiLatency
          );
        }
      } else {
        badStreak++;
        goodStreak = 0;
        if (wifiHealthy && (!state.node1_wifi_on || badStreak >= settings.hysteresis_bad_samples)) {
          wifiHealthy = false;
          if (state.node1_lora_on) {
            logCommEvent(
              'simulation',
              'LORA_FALLBACK',
              'NODE1_NODE2',
              'LORA',
              pkt.packet_id,
              `Direct Node 1 → Node 3 Wi-Fi unavailable/degraded (RSSI ${directWifiRssi} dBm). Switching to LoRa fallback via Node 2 gateway.`,
              directWifiRssi,
              directWifiLatency
            );
            createAlert(
              'simulation',
              'WARNING',
              'LORA_FALLBACK',
              `Direct Node 1 → Node 3 Wi-Fi unavailable/poor. Automatic LoRa fallback via Node 2 activated for packet #${pkt.packet_id}.`,
              'NODE_1'
            );
          }
        }
      }

      this.updateState({
        wifi_healthy: wifiHealthy ? 1 : 0,
        good_wifi_streak: goodStreak,
        bad_wifi_streak: badStreak,
      });

      const isTarget = !opts?.targetPacketId || opts.targetPacketId === pkt.packet_id;
      const shouldDropAck = Boolean(opts?.dropAckOnce && isTarget);
      const shouldDuplicate = Boolean(opts?.duplicateOnce && isTarget);
      const shouldTamper = Boolean(opts?.tamperOnce && isTarget);

      // ======================================================================
      // SCENARIO A: Direct Wi-Fi (Node 1 -> Node 3, Node 2 COMPLETELY BYPASSED)
      // ======================================================================
      if (wifiHealthy && state.node1_wifi_on) {
        db.prepare(`
          UPDATE packets SET
            comm_mode = 'WIFI',
            route_path = 'DIRECT_WIFI',
            gateway_status = 'BYPASSED',
            overall_status = 'TRANSMITTED',
            updated_at = ?
          WHERE id = ?
        `).run(now, pkt.id);

        logCommEvent(
          'simulation',
          'WIFI_TX',
          'NODE1_NODE3',
          'WIFI',
          pkt.packet_id,
          `Scenario A: Node 1 transmitted AES-128-GCM packet #${pkt.packet_id} (priority=${pkt.priority}) directly to Node 3 over Wi-Fi (Node 2 bypassed).`,
          directWifiRssi,
          directWifiLatency
        );

        let transmittedCiphertext = pkt.ciphertext;
        let transmittedTag = pkt.auth_tag;
        let tamperedField: string | null = null;

        if (shouldTamper) {
          const tampered = securityManager.tamperEnvelope(
            pkt.ciphertext,
            pkt.auth_tag,
            opts?.tamperTarget || 'ciphertext'
          );
          transmittedCiphertext = tampered.ciphertext;
          transmittedTag = tampered.tag;
          tamperedField = tampered.tamperedField;
        }

        const verifyRes = securityManager.verifyAndDecryptAtNode3({
          nonce: pkt.nonce,
          ciphertext: transmittedCiphertext,
          tag: transmittedTag,
          aad: pkt.aad,
          version: pkt.protocol_version,
          source: pkt.source_node,
          destination: pkt.destination_node,
          packet_id: pkt.packet_id,
          priority: pkt.priority,
        });

        if (!verifyRes.authenticated || !verifyRes.plaintext) {
          // Direct Wi-Fi AES-128-GCM authentication failure at Node 3: reject & emit no success ACK
          const updatedLoss = this.pushAttempt(this.directWifiAttempts, false);
          withTransaction(() => {
            db.prepare(`
              UPDATE packets SET
                ciphertext = ?,
                auth_tag = ?,
                comm_mode = 'WIFI',
                route_path = 'DIRECT_WIFI',
                gateway_status = 'BYPASSED',
                encryption_status = 'AUTH_FAILED',
                destination_status = 'REJECTED',
                overall_status = 'REJECTED',
                tampered = 1,
                node1_acked = 0,
                node2_acked = 0,
                updated_at = ?
              WHERE id = ?
            `).run(transmittedCiphertext, transmittedTag, now, pkt.id);

            db.prepare(`
              INSERT INTO acknowledgements (
                mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
              ) VALUES ('simulation', ?, 'NODE1_NODE3', 3, 1, 'REJECTED_NO_ACK', ?, ?, 1, ?)
            `).run(pkt.packet_id, verifyRes.error || 'AUTH_TAG_MISMATCH', directWifiLatency, now);

            logSecurityEvent(
              'simulation',
              pkt.packet_id,
              'AUTH_REJECTED',
              'NODE_3',
              'REJECTED',
              pkt.nonce,
              pkt.key_version,
              `Direct Wi-Fi AES-128-GCM verification failed at Node 3 (${tamperedField || 'ciphertext/tag'} modified). Payload rejected; LCD not updated; no direct ACK sent.`
            );

            createAlert(
              'simulation',
              'CRITICAL',
              'AUTH_FAILURE',
              `Security rejection at Node 3 for direct Wi-Fi packet #${pkt.packet_id}: AES-128-GCM tag check failed. Invalid data blocked from LCD display.`,
              'NODE_3'
            );
          });

          this.recordLinkMetric({
            linkHop: 'NODE1_NODE3_WIFI',
            rssi: directWifiRssi,
            rssiVar: directWifiRssiVar,
            rssiSource: 'SIMULATED_LINK_RSSI',
            lossRatio: updatedLoss,
            latencyMs: directWifiLatency,
            retryCount: pkt.retry_count,
            queueDepth: Math.max(0, pending.length - retiredFromNode1),
            linkMode: 'WIFI',
            node2To3Status: state.node2_node3_wifi_on ? 'CONNECTED' : 'DISCONNECTED',
          });
          continue;
        }

        // Direct Wi-Fi authentication succeeded at Node 3
        const reading = verifyRes.plaintext;

        if (shouldDropAck || shouldDuplicate) {
          // Direct Wi-Fi ACK lost -> Node 1 retains LittleFS copy (node1_acked=0), retransmits identical ciphertext, Node 3 deduplicates & resends direct ACK
          this.pushAttempt(this.directWifiAttempts, false);
          withTransaction(() => {
            db.prepare(`
              INSERT OR IGNORE INTO sensor_readings (
                mode, packet_id, node_id, temperature, humidity, rain_raw, rain_category,
                priority, authenticated, is_anomaly, anomaly_score, data_source, recorded_at
              ) VALUES ('simulation', ?, 'NODE_3', ?, ?, ?, ?, ?, 1, 0, 0, 'SIMULATED', ?)
            `).run(
              pkt.packet_id,
              reading.temperature,
              reading.humidity,
              reading.rain_raw,
              reading.rain,
              pkt.priority,
              now
            );

            db.prepare(`
              UPDATE packets SET
                comm_mode = 'WIFI',
                route_path = 'DIRECT_WIFI',
                gateway_status = 'BYPASSED',
                encryption_status = 'AUTHENTICATED',
                destination_status = 'AUTHENTICATED_AWAITING_ACK',
                overall_status = 'RETRYING',
                node1_acked = 0,
                node2_acked = 0,
                updated_at = ?
              WHERE id = ?
            `).run(now, pkt.id);

            db.prepare(`
              INSERT INTO acknowledgements (
                mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
              ) VALUES ('simulation', ?, 'NODE1_NODE3', 3, 1, 'LOST', 'ACK_TIMEOUT', ?, 1, ?)
            `).run(pkt.packet_id, settings.ack_timeout_ms, now);

            logCommEvent(
              'simulation',
              'ACK_LOST',
              'NODE1_NODE3',
              'WIFI',
              pkt.packet_id,
              `Direct Node 3 → Node 1 ACK lost for packet #${pkt.packet_id}. Node 1 retains LittleFS copy (node1_acked=0) and retransmits identical ciphertext.`,
              directWifiRssi,
              settings.ack_timeout_ms
            );
          });

          const persistedCopy = db
            .prepare('SELECT packet_id, nonce, ciphertext, auth_tag, aad, node1_acked FROM packets WHERE id = ?')
            .get(pkt.id) as {
            packet_id: number;
            nonce: string;
            ciphertext: string;
            auth_tag: string;
            aad: string;
            node1_acked: number;
          };
          if (
            persistedCopy.nonce !== pkt.nonce ||
            persistedCopy.ciphertext !== pkt.ciphertext ||
            persistedCopy.auth_tag !== pkt.auth_tag ||
            persistedCopy.aad !== pkt.aad ||
            persistedCopy.node1_acked !== 0
          ) {
            throw new Error(`Protocol invariant violation during direct Wi-Fi retry of packet #${pkt.packet_id}`);
          }

          const directDupAck = {
            packet_id: persistedCopy.packet_id,
            sender_node: 3,
            receiver_node: 1,
            status: 'ACK_DUPLICATE_RESENT' as const,
            authenticated_ack: 1,
          };
          const ackMatches =
            directDupAck.packet_id === pkt.packet_id &&
            directDupAck.sender_node === 3 &&
            directDupAck.receiver_node === 1;

          withTransaction(() => {
            db.prepare(`
              INSERT INTO acknowledgements (
                mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
              ) VALUES ('simulation', ?, 'NODE1_NODE3', ?, ?, ?, NULL, ?, ?, ?)
            `).run(
              directDupAck.packet_id,
              directDupAck.sender_node,
              directDupAck.receiver_node,
              directDupAck.status,
              directWifiLatency,
              directDupAck.authenticated_ack,
              now
            );

            db.prepare(`
              UPDATE packets SET
                comm_mode = 'WIFI',
                route_path = 'DIRECT_WIFI',
                gateway_status = 'BYPASSED',
                encryption_status = 'AUTHENTICATED',
                destination_status = 'DELIVERED',
                overall_status = 'DELIVERED',
                retry_count = retry_count + 1,
                is_duplicate = 1,
                node1_acked = ?,
                node2_acked = 0,
                updated_at = ?
              WHERE id = ?
            `).run(ackMatches ? 1 : 0, now, pkt.id);

            logCommEvent(
              'simulation',
              'DUPLICATE_SUPPRESSED',
              'NODE1_NODE3',
              'WIFI',
              pkt.packet_id,
              `Node 3 detected duplicate direct Wi-Fi packet #${pkt.packet_id}, prevented duplicate storage, and resent matching direct ACK to Node 1 (Node 2 bypassed).`,
              directWifiRssi,
              directWifiLatency
            );
          });
        } else {
          // Normal Scenario A direct delivery: Node 3 authenticates -> persists to LittleFS -> sends direct ACK_DELIVERED to Node 1
          const directAck = {
            packet_id: pkt.packet_id,
            sender_node: 3,
            receiver_node: 1,
            status: 'ACK_DELIVERED' as const,
            authenticated_ack: 1,
          };
          const ackMatches =
            directAck.packet_id === pkt.packet_id &&
            directAck.sender_node === 3 &&
            directAck.receiver_node === 1 &&
            directAck.status === 'ACK_DELIVERED' &&
            directAck.authenticated_ack === 1;

          withTransaction(() => {
            db.prepare(`
              INSERT OR IGNORE INTO sensor_readings (
                mode, packet_id, node_id, temperature, humidity, rain_raw, rain_category,
                priority, authenticated, is_anomaly, anomaly_score, data_source, recorded_at
              ) VALUES ('simulation', ?, 'NODE_3', ?, ?, ?, ?, ?, 1, 0, 0, 'SIMULATED', ?)
            `).run(
              pkt.packet_id,
              reading.temperature,
              reading.humidity,
              reading.rain_raw,
              reading.rain,
              pkt.priority,
              now
            );

            db.prepare(`
              INSERT INTO acknowledgements (
                mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
              ) VALUES ('simulation', ?, 'NODE1_NODE3', ?, ?, ?, NULL, ?, ?, ?)
            `).run(
              directAck.packet_id,
              directAck.sender_node,
              directAck.receiver_node,
              directAck.status,
              directWifiLatency,
              directAck.authenticated_ack,
              now
            );

            db.prepare(`
              UPDATE packets SET
                comm_mode = 'WIFI',
                route_path = 'DIRECT_WIFI',
                gateway_status = 'BYPASSED',
                encryption_status = 'AUTHENTICATED',
                destination_status = ?,
                overall_status = ?,
                node1_acked = ?,
                node2_acked = 0,
                updated_at = ?
              WHERE id = ?
            `).run(
              ackMatches ? 'DELIVERED' : 'AUTHENTICATED_AWAITING_ACK',
              ackMatches ? 'DELIVERED' : 'TRANSMITTED',
              ackMatches ? 1 : 0,
              now,
              pkt.id
            );

            logSecurityEvent(
              'simulation',
              pkt.packet_id,
              'AUTH_VERIFIED',
              'NODE_3',
              'AUTHENTICATED',
              pkt.nonce,
              pkt.key_version,
              `Node 3 verified AES-128-GCM tag & AAD for direct Wi-Fi packet #${pkt.packet_id}, saved to LittleFS, updated LCD, and sent direct ACK_DELIVERED to Node 1.`
            );

            logCommEvent(
              'simulation',
              'DELIVERED',
              'NODE1_NODE3',
              'WIFI',
              pkt.packet_id,
              `Scenario A complete: Packet #${pkt.packet_id} delivered directly Node 1 → Node 3 over Wi-Fi and retired on matching Node 3 ACK (Node 2 completely bypassed).`,
              directWifiRssi,
              directWifiLatency
            );
          });
        }

        const updatedLoss = this.pushAttempt(this.directWifiAttempts, true);
        retiredFromNode1++;
        this.lastSampleTimeMs = Date.now();

        this.recordLinkMetric({
          linkHop: 'NODE1_NODE3_WIFI',
          rssi: directWifiRssi,
          rssiVar: directWifiRssiVar,
          rssiSource: 'SIMULATED_LINK_RSSI',
          lossRatio: updatedLoss,
          latencyMs: directWifiLatency,
          retryCount: pkt.retry_count + (shouldDropAck || shouldDuplicate ? 1 : 0),
          queueDepth: Math.max(0, pending.length - retiredFromNode1),
          linkMode: 'WIFI',
          node2To3Status: state.node2_node3_wifi_on ? 'CONNECTED' : 'DISCONNECTED',
        });
        continue;
      }

      // ======================================================================
      // SCENARIO C: Both Paths Unavailable -> Retain in Node 1 LittleFS
      // ======================================================================
      if (!state.node1_lora_on) {
        const updatedLoss = this.pushAttempt(this.directWifiAttempts, false);
        const nextRetry = Math.min(settings.retry_limit, pkt.retry_count + 1);
        const offlineStatus = nextRetry < settings.retry_limit ? 'RETRYING' : 'PENDING';

        db.prepare(`
          UPDATE packets SET
            comm_mode = 'OFFLINE',
            route_path = 'LOCAL_QUEUE',
            gateway_status = 'PENDING',
            overall_status = ?,
            retry_count = ?,
            node1_acked = 0,
            node2_acked = 0,
            updated_at = ?
          WHERE id = ?
        `).run(offlineStatus, nextRetry, now, pkt.id);

        logCommEvent(
          'simulation',
          'OFFLINE_QUEUE',
          'NODE1_NODE3',
          'OFFLINE',
          pkt.packet_id,
          `Scenario C: Direct Wi-Fi and LoRa fallback both unavailable (attempt ${nextRetry}/${settings.retry_limit}). Encrypted packet #${pkt.packet_id} retained in Node 1 LittleFS.`,
          -110,
          settings.ack_timeout_ms
        );

        this.recordLinkMetric({
          linkHop: 'NODE1_NODE3_WIFI',
          rssi: -110,
          rssiVar: directWifiRssiVar,
          rssiSource: 'SIMULATED_LINK_RSSI',
          lossRatio: updatedLoss,
          latencyMs: settings.ack_timeout_ms,
          retryCount: nextRetry,
          queueDepth: pending.length,
          linkMode: 'OFFLINE',
          node2To3Status: state.node2_node3_wifi_on ? 'CONNECTED' : 'DISCONNECTED',
        });
        continue;
      }

      // ======================================================================
      // SCENARIO B (Stage 1): LoRa Fallback (Node 1 -> Node 2 microSD)
      // Node 2 validates envelope format (NEVER decrypts), deduplicates,
      // stores durably on microSD, and sends Stage-1 storage ACK to Node 1.
      // ======================================================================
      const loraRssi = Number((-90 - Math.random() * 12).toFixed(1));
      const loraRssiVar = Number(Math.abs(loraRssi - this.lastLoraRssi).toFixed(2));
      this.lastLoraRssi = loraRssi;
      const loraLatency = Number((255 + Math.random() * 175).toFixed(1));

      db.prepare(`
        UPDATE packets SET
          comm_mode = 'LORA',
          route_path = 'LORA_GATEWAY',
          overall_status = 'TRANSMITTED',
          updated_at = ?
        WHERE id = ?
      `).run(now, pkt.id);

      logCommEvent(
        'simulation',
        'LORA_TX',
        'NODE1_NODE2',
        'LORA',
        pkt.packet_id,
        `Scenario B (Stage 1): Node 1 transmitted AES-128-GCM packet #${pkt.packet_id} (priority=${pkt.priority}) to Node 2 over LoRa fallback.`,
        loraRssi,
        loraLatency
      );

      // Node 2 validates opaque envelope format (never decrypts) before microSD persistence
      const formatCheck = securityManager.validateEnvelopeFormat({
        nonce: pkt.nonce,
        ciphertext: pkt.ciphertext,
        tag: pkt.auth_tag,
        aad: pkt.aad,
        version: pkt.protocol_version,
        source: pkt.source_node,
        destination: pkt.destination_node,
        packet_id: pkt.packet_id,
        priority: pkt.priority,
      });
      if (!formatCheck.valid) {
        const updatedLoraLoss = this.pushAttempt(this.loraAttempts, false);
        logCommEvent(
          'simulation',
          'INVALID_ENVELOPE',
          'NODE1_NODE2',
          'LORA',
          pkt.packet_id,
          `Node 2 rejected malformed LoRa envelope for packet #${pkt.packet_id}: ${formatCheck.error}.`,
          loraRssi,
          loraLatency
        );
        this.recordLinkMetric({
          linkHop: 'NODE1_NODE2_LORA',
          rssi: loraRssi,
          rssiVar: loraRssiVar,
          rssiSource: 'SIMULATED_LINK_RSSI',
          lossRatio: updatedLoraLoss,
          latencyMs: loraLatency,
          retryCount: pkt.retry_count,
          queueDepth: pending.length,
          linkMode: 'LORA',
          node2To3Status: state.node2_node3_wifi_on ? 'CONNECTED' : 'DISCONNECTED',
        });
        continue;
      }

      if (shouldDropAck || shouldDuplicate) {
        // Stage-1 LoRa ACK lost: Node 2 stores durably on microSD, but Node 1 gets NO ACK -> node1_acked stays 0!
        this.pushAttempt(this.loraAttempts, false);
        withTransaction(() => {
          db.prepare(`
            UPDATE packets SET
              comm_mode = 'LORA',
              route_path = 'LORA_GATEWAY',
              gateway_status = 'STORED',
              overall_status = 'RETRYING',
              node1_acked = 0,
              updated_at = ?
            WHERE id = ?
          `).run(now, pkt.id);

          db.prepare(`
            INSERT INTO acknowledgements (
              mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
            ) VALUES ('simulation', ?, 'NODE1_NODE2', 2, 1, 'LOST', 'ACK_TIMEOUT', ?, 1, ?)
          `).run(pkt.packet_id, settings.ack_timeout_ms, now);

          logCommEvent(
            'simulation',
            'ACK_LOST',
            'NODE1_NODE2',
            'LORA',
            pkt.packet_id,
            `Stage-1 LoRa ACK from Node 2 lost for packet #${pkt.packet_id}. Node 1 retains LittleFS copy (node1_acked=0) and retransmits identical ciphertext.`,
            loraRssi,
            settings.ack_timeout_ms
          );

          createAlert(
            'simulation',
            'WARNING',
            'ACK_TIMEOUT',
            `LoRa ACK timeout on Node 1 → Node 2 for packet #${pkt.packet_id}. Retransmission triggered; Node 2 deduplicates.`,
            'NODE_2'
          );
        });

        const persistedLittleFsCopy = db
          .prepare('SELECT packet_id, nonce, ciphertext, auth_tag, aad, gateway_status, node1_acked FROM packets WHERE id = ?')
          .get(pkt.id) as {
          packet_id: number;
          nonce: string;
          ciphertext: string;
          auth_tag: string;
          aad: string;
          gateway_status: string;
          node1_acked: number;
        };

        const identicalBytes =
          persistedLittleFsCopy.nonce === pkt.nonce &&
          persistedLittleFsCopy.ciphertext === pkt.ciphertext &&
          persistedLittleFsCopy.auth_tag === pkt.auth_tag &&
          persistedLittleFsCopy.aad === pkt.aad;

        if (!identicalBytes || persistedLittleFsCopy.node1_acked !== 0) {
          throw new Error(`Protocol invariant violation during Hop-1 LoRa retransmission of packet #${pkt.packet_id}`);
        }

        const hop1Ack = {
          packet_id: persistedLittleFsCopy.packet_id,
          sender_node: 2,
          receiver_node: 1,
          status: 'ACK_DUPLICATE_RESENT' as const,
        };
        const ackMatches =
          hop1Ack.packet_id === pkt.packet_id &&
          hop1Ack.sender_node === 2 &&
          hop1Ack.receiver_node === 1 &&
          hop1Ack.status === 'ACK_DUPLICATE_RESENT';

        withTransaction(() => {
          db.prepare(`
            INSERT INTO acknowledgements (
              mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
            ) VALUES ('simulation', ?, 'NODE1_NODE2', ?, ?, ?, NULL, ?, 1, ?)
          `).run(hop1Ack.packet_id, hop1Ack.sender_node, hop1Ack.receiver_node, hop1Ack.status, loraLatency, now);

          db.prepare(`
            UPDATE packets SET
              comm_mode = 'LORA',
              route_path = 'LORA_GATEWAY',
              gateway_status = 'DUPLICATE_SUPPRESSED',
              overall_status = 'GATEWAY_STORED',
              retry_count = retry_count + 1,
              is_duplicate = 1,
              node1_acked = ?,
              updated_at = ?
            WHERE id = ?
          `).run(ackMatches ? 1 : 0, now, pkt.id);

          logCommEvent(
            'simulation',
            'DUPLICATE_SUPPRESSED',
            'NODE1_NODE2',
            'LORA',
            pkt.packet_id,
            `Node 2 detected duplicate LoRa packet #${pkt.packet_id} on microSD (identical ciphertext retransmitted), suppressed duplicate storage, and resent Stage-1 ACK_DUPLICATE_RESENT.`,
            loraRssi,
            loraLatency
          );
        });
      } else {
        // Normal Stage-1 storage-before-ACK sequence over LoRa:
        // Confirms gateway microSD storage ONLY — NOT final delivery to Node 3!
        const hop1Ack = {
          packet_id: pkt.packet_id,
          sender_node: 2,
          receiver_node: 1,
          status: pkt.gateway_status === 'STORED' ? ('ACK_DUPLICATE_RESENT' as const) : ('ACK_STORED' as const),
        };
        const ackMatches =
          hop1Ack.packet_id === pkt.packet_id &&
          hop1Ack.sender_node === 2 &&
          hop1Ack.receiver_node === 1 &&
          (hop1Ack.status === 'ACK_STORED' || hop1Ack.status === 'ACK_DUPLICATE_RESENT');

        withTransaction(() => {
          db.prepare(`
            INSERT INTO acknowledgements (
              mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
            ) VALUES ('simulation', ?, 'NODE1_NODE2', ?, ?, ?, NULL, ?, 1, ?)
          `).run(hop1Ack.packet_id, hop1Ack.sender_node, hop1Ack.receiver_node, hop1Ack.status, loraLatency, now);

          db.prepare(`
            UPDATE packets SET
              comm_mode = 'LORA',
              route_path = 'LORA_GATEWAY',
              gateway_status = ?,
              overall_status = 'GATEWAY_STORED',
              is_duplicate = CASE WHEN gateway_status = 'STORED' THEN 1 ELSE is_duplicate END,
              node1_acked = ?,
              node2_acked = 0,
              updated_at = ?
            WHERE id = ?
          `).run(
            pkt.gateway_status === 'STORED' ? 'DUPLICATE_SUPPRESSED' : 'STORED',
            ackMatches ? 1 : 0,
            now,
            pkt.id
          );

          logCommEvent(
            'simulation',
            'ACK_RECEIVED',
            'NODE1_NODE2',
            'LORA',
            pkt.packet_id,
            `Stage-1 Gateway ACK: Node 2 stored ciphertext #${pkt.packet_id} on microSD and sent LoRa ${hop1Ack.status} to Node 1 (awaiting Stage-2 delivery to Node 3).`,
            loraRssi,
            loraLatency
          );
        });
      }

      const updatedLoraLoss = this.pushAttempt(this.loraAttempts, true);
      retiredFromNode1++;

      this.recordLinkMetric({
        linkHop: 'NODE1_NODE2_LORA',
        rssi: loraRssi,
        rssiVar: loraRssiVar,
        rssiSource: 'SIMULATED_LINK_RSSI',
        lossRatio: updatedLoraLoss,
        latencyMs: loraLatency,
        retryCount: pkt.retry_count + (shouldDropAck || shouldDuplicate ? 1 : 0),
        queueDepth: Math.max(0, pending.length - retiredFromNode1),
        linkMode: 'LORA',
        node2To3Status: state.node2_node3_wifi_on ? 'CONNECTED' : 'DISCONNECTED',
      });
    }

    return retiredFromNode1;
  }

  /**
   * Scenario B (Stage 2 — Independent): Node 2 -> Node 3 over Wi-Fi (NODE2_NODE3_WIFI).
   * Processes ONLY packets durably stored on Node 2 microSD (gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED')).
   * NEVER touches Scenario A direct Wi-Fi packets (gateway_status = 'BYPASSED').
   * Records dedicated NODE2_NODE3_WIFI link telemetry independently for future ML dataset collection.
   */
  public drainNode2PendingQueue(opts?: {
    targetPacketId?: number;
    tamperOnce?: boolean;
    tamperTarget?: 'ciphertext' | 'tag';
    dropHop2AckOnce?: boolean;
  }): number {
    const state = this.getState();
    const settings = getSettings();

    const pendingForNode3 = db
      .prepare(
        "SELECT * FROM packets WHERE mode = 'simulation' AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED') AND node2_acked = 0 AND destination_status != 'REJECTED' ORDER BY priority ASC, packet_id ASC LIMIT 12"
      )
      .all() as unknown as PacketRow[];

    if (pendingForNode3.length === 0) return 0;

    let processedAtNode2 = 0;

    for (const pkt of pendingForNode3) {
      const now = new Date().toISOString();
      const remainingQueue = Math.max(0, pendingForNode3.length - processedAtNode2);

      if (!state.node2_node3_wifi_on) {
        // Node 2 -> Node 3 Wi-Fi unavailable -> retain securely on Node 2 microSD (node2_acked=0), NEVER mark delivered!
        const updatedN2Loss = this.pushAttempt(this.node2WifiAttempts, false);
        const rssiVar = Number(Math.abs(-110 - this.lastNode2WifiRssi).toFixed(2));
        this.lastNode2WifiRssi = -110;

        db.prepare(`
          UPDATE packets SET
            destination_status = 'RETRYING',
            overall_status = 'GATEWAY_STORED',
            node2_acked = 0,
            updated_at = ?
          WHERE id = ?
        `).run(now, pkt.id);

        logCommEvent(
          'simulation',
          'NODE3_PENDING',
          'NODE2_NODE3',
          'OFFLINE',
          pkt.packet_id,
          `Node 2 → Node 3 Wi-Fi unavailable. Packet #${pkt.packet_id} retained in Node 2 microSD node3_pending.log (node2_acked=0) until reconnection.`,
          -110,
          settings.ack_timeout_ms
        );

        this.recordNode2To3WifiMetric(
          -110,
          rssiVar,
          updatedN2Loss,
          settings.ack_timeout_ms,
          pkt.retry_count,
          remainingQueue,
          'DISCONNECTED'
        );
        processedAtNode2++;
        continue;
      }

      // Compute dedicated Node 2 -> Node 3 Wi-Fi link RF telemetry (independent of Node 1)
      const n2WifiRssi = Number((-58 - Math.random() * 18).toFixed(1));
      const n2WifiRssiVar = Number(Math.abs(n2WifiRssi - this.lastNode2WifiRssi).toFixed(2));
      this.lastNode2WifiRssi = n2WifiRssi;
      const forwardLatency = Number((36 + Math.random() * 64).toFixed(1));

      // Explicit state transition: GATEWAY_STORED -> FORWARDED (node2_acked still 0)
      db.prepare(`
        UPDATE packets SET destination_status = 'FORWARDED', overall_status = 'FORWARDED', updated_at = ? WHERE id = ?
      `).run(now, pkt.id);

      const isTarget = !opts?.targetPacketId || opts.targetPacketId === pkt.packet_id;
      const shouldTamper = Boolean(opts?.tamperOnce && isTarget);
      const shouldDropHop2Ack = Boolean(opts?.dropHop2AckOnce && isTarget);

      let forwardedCiphertext = pkt.ciphertext;
      let forwardedTag = pkt.auth_tag;
      let tamperedField: string | null = null;

      if (shouldTamper) {
        const tampered = securityManager.tamperEnvelope(
          pkt.ciphertext,
          pkt.auth_tag,
          opts?.tamperTarget || 'ciphertext'
        );
        forwardedCiphertext = tampered.ciphertext;
        forwardedTag = tampered.tag;
        tamperedField = tampered.tamperedField;
      }

      const result = securityManager.verifyAndDecryptAtNode3({
        nonce: pkt.nonce,
        ciphertext: forwardedCiphertext,
        tag: forwardedTag,
        aad: pkt.aad,
        version: pkt.protocol_version,
        source: pkt.source_node,
        destination: pkt.destination_node,
        packet_id: pkt.packet_id,
        priority: pkt.priority,
      });

      if (!result.authenticated || !result.plaintext) {
        const updatedN2Loss = this.pushAttempt(this.node2WifiAttempts, false);
        withTransaction(() => {
          db.prepare(`
            UPDATE packets SET
              ciphertext = ?,
              auth_tag = ?,
              encryption_status = 'AUTH_FAILED',
              destination_status = 'REJECTED',
              overall_status = 'REJECTED',
              tampered = 1,
              node2_acked = 0,
              updated_at = ?
            WHERE id = ?
          `).run(forwardedCiphertext, forwardedTag, now, pkt.id);

          db.prepare(`
            INSERT INTO acknowledgements (
              mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
            ) VALUES ('simulation', ?, 'NODE2_NODE3', 3, 2, 'REJECTED_NO_ACK', ?, ?, 1, ?)
          `).run(pkt.packet_id, result.error || 'AUTH_TAG_MISMATCH', forwardLatency, now);

          logSecurityEvent(
            'simulation',
            pkt.packet_id,
            'AUTH_REJECTED',
            'NODE_3',
            'REJECTED',
            pkt.nonce,
            pkt.key_version,
            `AES-128-GCM verification failed at Node 3 on forwarded packet #${pkt.packet_id} (${tamperedField || 'ciphertext/tag'} modified). Payload rejected; LCD not updated; no success ACK sent.`
          );

          createAlert(
            'simulation',
            'CRITICAL',
            'AUTH_FAILURE',
            `Security rejection at Node 3 for packet #${pkt.packet_id}: AES-128-GCM tag check failed. Invalid data blocked from LCD display.`,
            'NODE_3'
          );
        });

        this.recordNode2To3WifiMetric(
          n2WifiRssi,
          n2WifiRssiVar,
          updatedN2Loss,
          forwardLatency,
          pkt.retry_count,
          Math.max(0, remainingQueue - 1),
          'CONNECTED'
        );
        processedAtNode2++;
        continue;
      }

      const reading = result.plaintext;

      if (shouldDropHop2Ack) {
        const updatedN2Loss = this.pushAttempt(this.node2WifiAttempts, false);
        withTransaction(() => {
          db.prepare(`
            INSERT OR IGNORE INTO sensor_readings (
              mode, packet_id, node_id, temperature, humidity, rain_raw, rain_category,
              priority, authenticated, is_anomaly, anomaly_score, data_source, recorded_at
            ) VALUES ('simulation', ?, 'NODE_3', ?, ?, ?, ?, ?, 1, 0, 0, 'SIMULATED', ?)
          `).run(
            pkt.packet_id,
            reading.temperature,
            reading.humidity,
            reading.rain_raw,
            reading.rain,
            pkt.priority,
            now
          );

          db.prepare(`
            UPDATE packets SET
              encryption_status = 'AUTHENTICATED',
              destination_status = 'RETRYING',
              overall_status = 'RETRYING',
              retry_count = retry_count + 1,
              node2_acked = 0,
              updated_at = ?
            WHERE id = ?
          `).run(now, pkt.id);

          db.prepare(`
            INSERT INTO acknowledgements (
              mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
            ) VALUES ('simulation', ?, 'NODE2_NODE3', 3, 2, 'LOST', 'ACK_TIMEOUT', ?, 1, ?)
          `).run(pkt.packet_id, settings.ack_timeout_ms, now);

          logCommEvent(
            'simulation',
            'ACK_LOST',
            'NODE2_NODE3',
            'WIFI',
            pkt.packet_id,
            `Stage-2 ACK from Node 3 lost for packet #${pkt.packet_id}. Node 2 retains packet in microSD node3_pending.log (node2_acked=0) for retry.`,
            n2WifiRssi,
            settings.ack_timeout_ms
          );
        });

        this.recordNode2To3WifiMetric(
          n2WifiRssi,
          n2WifiRssiVar,
          updatedN2Loss,
          settings.ack_timeout_ms,
          pkt.retry_count + 1,
          remainingQueue,
          'CONNECTED'
        );
        processedAtNode2++;
        continue;
      }

      // Stage-2 matching final delivery ACK (Node 3 -> Node 2)
      const hop2Ack = {
        packet_id: pkt.packet_id,
        sender_node: 3,
        receiver_node: 2,
        status: 'ACK_DELIVERED' as const,
        authenticated_ack: 1,
      };
      const hop2AckMatches =
        hop2Ack.packet_id === pkt.packet_id &&
        hop2Ack.sender_node === 3 &&
        hop2Ack.receiver_node === 2 &&
        hop2Ack.status === 'ACK_DELIVERED' &&
        hop2Ack.authenticated_ack === 1;

      withTransaction(() => {
        db.prepare(`
          INSERT OR IGNORE INTO sensor_readings (
            mode, packet_id, node_id, temperature, humidity, rain_raw, rain_category,
            priority, authenticated, is_anomaly, anomaly_score, data_source, recorded_at
          ) VALUES ('simulation', ?, 'NODE_3', ?, ?, ?, ?, ?, 1, 0, 0, 'SIMULATED', ?)
        `).run(
          pkt.packet_id,
          reading.temperature,
          reading.humidity,
          reading.rain_raw,
          reading.rain,
          pkt.priority,
          now
        );

        db.prepare(`
          INSERT INTO acknowledgements (
            mode, packet_id, link_hop, sender_node, receiver_node, status, error_code, latency_ms, authenticated_ack, created_at
          ) VALUES ('simulation', ?, 'NODE2_NODE3', ?, ?, ?, NULL, ?, ?, ?)
        `).run(
          hop2Ack.packet_id,
          hop2Ack.sender_node,
          hop2Ack.receiver_node,
          hop2Ack.status,
          forwardLatency,
          hop2Ack.authenticated_ack,
          now
        );

        db.prepare(`
          UPDATE packets SET
            encryption_status = 'AUTHENTICATED',
            destination_status = ?,
            overall_status = ?,
            node2_acked = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
          hop2AckMatches ? 'DELIVERED' : 'AUTHENTICATED_AWAITING_ACK',
          hop2AckMatches ? 'DELIVERED' : 'FORWARDED',
          hop2AckMatches ? 1 : 0,
          now,
          pkt.id
        );

        logSecurityEvent(
          'simulation',
          pkt.packet_id,
          'AUTH_VERIFIED',
          'NODE_3',
          'AUTHENTICATED',
          pkt.nonce,
          pkt.key_version,
          `Node 3 verified AES-128-GCM tag & AAD for gateway-forwarded packet #${pkt.packet_id}, persisted to LittleFS, updated LCD, and sent matching Stage-2 ACK_DELIVERED to Node 2.`
        );

        logCommEvent(
          'simulation',
          'DELIVERED',
          'NODE2_NODE3',
          'WIFI',
          pkt.packet_id,
          `Scenario B (Stage 2) complete: Packet #${pkt.packet_id} forwarded Node 2 → Node 3 over Wi-Fi, verified at Node 3, and retired from microSD pending queue after matching Node 3 ACK.`,
          n2WifiRssi,
          forwardLatency
        );
      });

      const updatedN2Loss = this.pushAttempt(this.node2WifiAttempts, true);
      processedAtNode2++;
      this.lastSampleTimeMs = Date.now();

      this.recordNode2To3WifiMetric(
        n2WifiRssi,
        n2WifiRssiVar,
        updatedN2Loss,
        forwardLatency,
        pkt.retry_count,
        Math.max(0, pendingForNode3.length - processedAtNode2),
        'CONNECTED'
      );
    }

    return processedAtNode2;
  }

  /**
   * Independent periodic health probe for Link 3 (NODE2_NODE3_WIFI) so Node 2 -> Node 3 Wi-Fi
   * metrics remain continuously sampled and isolated from Node 1 links even when Scenario A bypasses Node 2.
   */
  public probeNode2To3WifiLink(): void {
    const state = this.getState();
    const settings = getSettings();
    const pendingN2Count = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM packets WHERE mode = 'simulation' AND gateway_status IN ('STORED', 'DUPLICATE_SUPPRESSED') AND node2_acked = 0 AND destination_status != 'REJECTED'"
        )
        .get() as { c: number }
    ).c;

    if (!state.node2_node3_wifi_on) {
      const loss = this.pushAttempt(this.node2WifiAttempts, false);
      const rssiVar = Number(Math.abs(-110 - this.lastNode2WifiRssi).toFixed(2));
      this.lastNode2WifiRssi = -110;
      this.recordNode2To3WifiMetric(-110, rssiVar, loss, settings.ack_timeout_ms, 0, pendingN2Count, 'DISCONNECTED');
      return;
    }

    // Independent realistic RF walk for Node 2 -> Node 3 Wi-Fi link
    const drift = (Math.random() - 0.5) * 4.5;
    const baseRssi = this.lastNode2WifiRssi < -95 ? -62 : this.lastNode2WifiRssi;
    const rssi = Number(Math.max(-84, Math.min(-52, baseRssi + drift)).toFixed(1));
    const rssiVar = Number(Math.abs(rssi - this.lastNode2WifiRssi).toFixed(2));
    this.lastNode2WifiRssi = rssi;
    const latency = Number((34 + Math.max(0, (-rssi - 55) * 2.4) + Math.random() * 25).toFixed(1));
    const probeOk = rssi > -81 && latency < settings.ack_timeout_ms;
    const loss = this.pushAttempt(this.node2WifiAttempts, probeOk);

    this.recordNode2To3WifiMetric(
      rssi,
      rssiVar,
      loss,
      probeOk ? latency : settings.ack_timeout_ms,
      probeOk ? 0 : 1,
      pendingN2Count,
      'CONNECTED'
    );
  }

  private recordLinkMetric(params: {
    linkHop: LinkHopId;
    rssi: number;
    rssiVar: number;
    rssiSource: RssiSource;
    lossRatio: number;
    latencyMs: number;
    retryCount: number;
    queueDepth: number;
    linkMode: string;
    node2To3Status: string;
  }): void {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO network_metrics (
        mode, link_hop, rssi, rssi_variation, rssi_source, packet_loss_ratio, ack_latency_ms,
        retry_count, queue_depth, link_mode, node2_to_node3_status, data_source, recorded_at
      ) VALUES ('simulation', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SIMULATED', ?)
    `).run(
      params.linkHop,
      params.rssi,
      params.rssiVar,
      params.rssiSource,
      Number(params.lossRatio.toFixed(3)),
      params.latencyMs,
      params.retryCount,
      params.queueDepth,
      params.linkMode,
      params.node2To3Status,
      now
    );
  }

  /**
   * Records Link 3 (NODE2_NODE3_WIFI) metrics strictly under link_hop='NODE2_NODE3_WIFI'.
   * External Python ML models evaluate NODE2_NODE3_WIFI metrics separately without blocking or controlling simulation.
   */
  private recordNode2To3WifiMetric(
    rssi: number,
    rssiVar: number,
    lossRatio: number,
    latencyMs: number,
    retryCount: number,
    queueDepth: number,
    node2To3Status: 'CONNECTED' | 'DISCONNECTED'
  ): void {
    const now = new Date().toISOString();
    const settings = getSettings();
    const clampedLoss = Number(Math.max(0, Math.min(1, lossRatio)).toFixed(3));

    const prevNode2Metric = db
      .prepare(
        "SELECT node2_to_node3_status FROM network_metrics WHERE mode = 'simulation' AND link_hop = 'NODE2_NODE3_WIFI' ORDER BY id DESC LIMIT 1"
      )
      .get() as { node2_to_node3_status: string } | undefined;

    this.recordLinkMetric({
      linkHop: 'NODE2_NODE3_WIFI',
      rssi,
      rssiVar,
      rssiSource: 'SIMULATED_LINK_RSSI',
      lossRatio: clampedLoss,
      latencyMs,
      retryCount,
      queueDepth,
      linkMode: node2To3Status === 'CONNECTED' ? 'WIFI' : 'OFFLINE',
      node2To3Status,
    });

    this.updateState({
      node2_wifi_rssi: rssi,
      node2_wifi_rssi_var: rssiVar,
      node2_wifi_loss_ratio: clampedLoss,
      node2_wifi_latency_ms: latencyMs,
      node2_wifi_healthy:
        node2To3Status === 'CONNECTED' &&
        rssi > settings.wifi_rssi_poor_threshold &&
        clampedLoss < settings.wifi_loss_poor_threshold
          ? 1
          : 0,
    });

    if (
      prevNode2Metric?.node2_to_node3_status === 'DISCONNECTED' &&
      node2To3Status === 'CONNECTED'
    ) {
      resolveSchedulingObservationsOnReconnect('simulation', now);
    }
  }

  public stepSimulation(): { packet_id: number; overall_status: string } {
    return this.createAndProcessPacket();
  }

  /**
   * Handles all manual interactive simulation controls from the dashboard UI.
   */
  public applyControl(action: string, payload?: Record<string, unknown>): {
    action: string;
    message: string;
    state: SimStateRow;
    packet_id?: number;
  } {
    const state = this.getState();

    switch (action) {
      case 'toggle_node1_wifi': {
        const nextVal = payload?.enabled !== undefined ? (payload.enabled ? 1 : 0) : state.node1_wifi_on ? 0 : 1;
        const updated = this.updateState({
          node1_wifi_on: nextVal,
          wifi_healthy: nextVal ? 1 : 0,
          good_wifi_streak: nextVal ? 3 : 0,
          bad_wifi_streak: nextVal ? 0 : 3,
        });
        if (nextVal === 1) {
          this.directWifiAttempts = [true, true, true, true, true, true, true, true];
          logCommEvent('simulation', 'LINK_RECOVERY', 'NODE1_NODE3', 'WIFI', null, 'Direct Wi-Fi (Node 1 → Node 3) enabled manually. Draining pending LittleFS queue directly to Node 3.', -60, 48);
          this.drainNode1PendingQueue();
          this.drainNode2PendingQueue();
        } else {
          logCommEvent('simulation', 'WIFI_FAILURE', 'NODE1_NODE3', updated.node1_lora_on ? 'LORA' : 'OFFLINE', null, 'Direct Wi-Fi (Node 1 → Node 3) disabled manually.', -110, null);
          createAlert('simulation', 'WARNING', 'WIFI_UNAVAILABLE', 'Direct Node 1 → Node 3 Wi-Fi disabled. Evaluating LoRa fallback via Node 2 or LittleFS queueing.', 'NODE_1');
        }
        this.syncNodeAndStorageSummaries();
        return {
          action,
          message: nextVal ? 'Direct Node 1 → Node 3 Wi-Fi restored and pending packets flushed.' : 'Direct Node 1 → Node 3 Wi-Fi disabled.',
          state: this.getState(),
        };
      }

      case 'toggle_node1_lora': {
        const nextVal = payload?.enabled !== undefined ? (payload.enabled ? 1 : 0) : state.node1_lora_on ? 0 : 1;
        this.updateState({ node1_lora_on: nextVal });
        if (nextVal === 1) {
          this.loraAttempts = [true, true, true, true, true, true, true, true];
          logCommEvent('simulation', 'LORA_READY', 'NODE1_NODE2', 'LORA', null, 'Node 1 → Node 2 bidirectional LoRa fallback enabled.', -94, 290);
          if (!state.node1_wifi_on) {
            this.drainNode1PendingQueue();
            this.drainNode2PendingQueue();
          }
        } else {
          logCommEvent('simulation', 'LORA_OFFLINE', 'NODE1_NODE2', state.node1_wifi_on ? 'WIFI' : 'OFFLINE', null, 'Node 1 → Node 2 LoRa transceiver disabled.', null, null);
          if (!state.node1_wifi_on) {
            createAlert('simulation', 'CRITICAL', 'ALL_LINKS_DOWN', 'Direct Wi-Fi and LoRa fallback both unavailable. Switching to Node 1 LittleFS store-and-forward.', 'NODE_1');
          }
        }
        this.syncNodeAndStorageSummaries();
        return {
          action,
          message: nextVal ? 'Node 1 → Node 2 LoRa enabled.' : 'Node 1 → Node 2 LoRa disabled.',
          state: this.getState(),
        };
      }

      case 'toggle_node2_node3_wifi': {
        const nextVal = payload?.enabled !== undefined ? (payload.enabled ? 1 : 0) : state.node2_node3_wifi_on ? 0 : 1;
        this.updateState({
          node2_node3_wifi_on: nextVal,
          node2_wifi_healthy: nextVal ? 1 : 0,
        });
        if (nextVal === 1) {
          this.node2WifiAttempts = [true, true, true, true, true, true, true, true];
          logCommEvent('simulation', 'NODE3_RECONNECTED', 'NODE2_NODE3', 'WIFI', null, 'Node 2 → Node 3 Wi-Fi restored. Forwarding microSD pending queue.', -60, 48);
          this.drainNode2PendingQueue();
          this.probeNode2To3WifiLink();
        } else {
          logCommEvent('simulation', 'NODE3_DISCONNECTED', 'NODE2_NODE3', 'OFFLINE', null, 'Node 2 → Node 3 Wi-Fi disconnected. Node 2 gateway buffers LoRa fallback packets on microSD.', -110, null);
          createAlert('simulation', 'WARNING', 'NODE3_DISCONNECTED', 'Node 2 → Node 3 Wi-Fi disconnected. Node 2 gateway retains LoRa fallback packets in microSD pending queue.', 'NODE_2');
          this.probeNode2To3WifiLink();
        }
        this.syncNodeAndStorageSummaries();
        return {
          action,
          message: nextVal ? 'Node 2 → Node 3 Wi-Fi restored and microSD pending queue forwarded.' : 'Node 2 → Node 3 Wi-Fi disconnected.',
          state: this.getState(),
        };
      }

      case 'restore_all_links': {
        this.updateState({
          node1_wifi_on: 1,
          node1_lora_on: 1,
          node2_node3_wifi_on: 1,
          wifi_healthy: 1,
          good_wifi_streak: 3,
          bad_wifi_streak: 0,
          node2_wifi_healthy: 1,
        });
        this.directWifiAttempts = [true, true, true, true, true, true, true, true];
        this.loraAttempts = [true, true, true, true, true, true, true, true];
        this.node2WifiAttempts = [true, true, true, true, true, true, true, true];
        logCommEvent('simulation', 'LINK_RECOVERY', 'NODE1_NODE3', 'WIFI', null, 'All 3 communication links restored. Flushing LittleFS and microSD pending queues in priority order.', -58, 45);
        this.drainNode1PendingQueue();
        this.drainNode2PendingQueue();
        this.probeNode2To3WifiLink();
        this.syncNodeAndStorageSummaries();
        return {
          action,
          message: 'All 3 links restored and pending queues flushed.',
          state: this.getState(),
        };
      }

      case 'drop_ack': {
        const res = this.createAndProcessPacket({ forceDropAck: true });
        return {
          action,
          message: `Simulated lost Hop-1 ACK for packet #${res.packet_id}. Node 1 retransmitted identical ciphertext and Node 2 suppressed the duplicate.`,
          state: this.getState(),
          packet_id: res.packet_id,
        };
      }

      case 'trigger_duplicate': {
        const res = this.createAndProcessPacket({ forceDuplicate: true });
        return {
          action,
          message: `Triggered duplicate retransmission for packet #${res.packet_id}. Node 2 detected duplicate ID and resent matching ACK.`,
          state: this.getState(),
          packet_id: res.packet_id,
        };
      }

      case 'trigger_tamper': {
        const target = payload?.target === 'tag' ? 'tag' : 'ciphertext';
        const res = this.createAndProcessPacket({ forceTamper: true, tamperTarget: target });
        return {
          action,
          message: `Simulated ${target === 'tag' ? 'authentication tag' : 'ciphertext'} tampering on packet #${res.packet_id}. Node 3 AES-128-GCM tag check failed and rejected the packet.`,
          state: this.getState(),
          packet_id: res.packet_id,
        };
      }

      case 'restart_node': {
        const targetNode = String(payload?.node || 'NODE_1');
        const report = this.simulateNodesRestart();
        this.drainNode1PendingQueue();
        this.drainNode2PendingQueue();
        this.syncNodeAndStorageSummaries();
        return {
          action,
          message: `${targetNode} simulated restart complete. Recovered LittleFS (${report.recoveredNode1Pending.length}) & microSD (${report.recoveredNode2Pending.length}) pending queues and sequence counter (#${report.sequenceCounter}).`,
          state: this.getState(),
        };
      }

      case 'generate_heavy_rain': {
        const res = this.createAndProcessPacket({ forceHeavyRain: true });
        return {
          action,
          message: `Heavy-rain HIGH priority alert packet #${res.packet_id} created (${res.overall_status}).`,
          state: this.getState(),
          packet_id: res.packet_id,
        };
      }

      case 'generate_routine': {
        const res = this.createAndProcessPacket({ rain_raw: 195 });
        return {
          action,
          message: `Routine environmental telemetry packet #${res.packet_id} created (${res.overall_status}).`,
          state: this.getState(),
          packet_id: res.packet_id,
        };
      }

      case 'set_speed': {
        const speedMs = Number(payload?.speed_ms ?? 3500);
        const updated = this.setSpeed(speedMs);
        return {
          action,
          message: `Simulation sampling interval set to ${updated.speed_ms} ms.`,
          state: updated,
        };
      }

      default:
        return {
          action,
          message: `Unknown control action: ${action}`,
          state: this.getState(),
        };
    }
  }
}

export const simulationEngine = new SimulationEngine();
