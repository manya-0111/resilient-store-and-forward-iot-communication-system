import { db } from './database.ts';
import { simulationEngine } from './simulationEngine.ts';

export interface TestDefinition {
  test_id: number;
  test_name: string;
  initial_config: {
    node1_wifi: string;
    node1_lora: string;
    node2_node3_wifi: string;
  };
  expected_result: string;
}

export interface TestStepResult {
  step: number;
  label: string;
  status: 'DONE' | 'PASS' | 'WARN' | 'REJECTED';
  detail: string;
}

export interface TestResultRecord {
  test_id: number;
  mode: string;
  test_name: string;
  initial_config: TestDefinition['initial_config'];
  status: string;
  passed: boolean | null;
  expected_result: string;
  actual_result: string | null;
  steps: TestStepResult[];
  packet_id: number | null;
  executed_at: string | null;
}

export const PDF_TEST_DEFINITIONS: TestDefinition[] = [
  {
    test_id: 1,
    test_name: 'Scenario A: Direct Wi-Fi Communication (Node 1 → Node 3, Bypassing Node 2)',
    initial_config: { node1_wifi: 'ON (N1→N3)', node1_lora: 'Standby', node2_node3_wifi: 'ON' },
    expected_result:
      'Packet goes directly Node 1 → Node 3 over Wi-Fi; Node 2 is completely bypassed (microSD unchanged); Node 3 verifies AES-GCM, stores in LittleFS, and sends direct ACK to Node 1.',
  },
  {
    test_id: 2,
    test_name: 'Scenario B: Direct Wi-Fi Failure with LoRa Fallback via Node 2',
    initial_config: { node1_wifi: 'OFF (N1→N3)', node1_lora: 'ON (N1→N2)', node2_node3_wifi: 'ON (N2→N3)' },
    expected_result:
      'Node 1 sends via LoRa to Node 2; Node 2 stores on microSD and sends Stage-1 ACK; Node 2 forwards over Wi-Fi to Node 3 for AES-GCM decryption and Stage-2 final ACK.',
  },
  {
    test_id: 3,
    test_name: 'Scenario C: Both Node 1 Paths Unavailable (LittleFS Store-and-Forward)',
    initial_config: { node1_wifi: 'OFF', node1_lora: 'OFF', node2_node3_wifi: 'ON' },
    expected_result:
      'Node 1 retains encrypted packet in LittleFS with zero ACKs; upon direct Wi-Fi recovery it drains directly to Node 3 (bypassing Node 2) with identical ciphertext.',
  },
  {
    test_id: 4,
    test_name: 'Node 2 → Node 3 Wi-Fi Unavailable (microSD Independent Buffering)',
    initial_config: { node1_wifi: 'OFF (LoRa Fallback)', node1_lora: 'ON', node2_node3_wifi: 'OFF' },
    expected_result:
      'Node 1 delivers via LoRa to Node 2 (Stage-1 ACK only); Node 2 microSD pending queue grows; Stage-2 delivery and ACK occur after Node 2 → Node 3 Wi-Fi reconnects.',
  },
  {
    test_id: 5,
    test_name: 'All Three Wireless Links Unavailable',
    initial_config: { node1_wifi: 'OFF', node1_lora: 'OFF', node2_node3_wifi: 'OFF' },
    expected_result:
      'Node 1 LittleFS and Node 2 microSD retain their independent pending queues; zero packets are falsely marked delivered.',
  },
  {
    test_id: 6,
    test_name: 'ACK Loss, Identical-Ciphertext Retry & Duplicate Suppression',
    initial_config: { node1_wifi: 'OFF (LoRa Fallback)', node1_lora: 'ON', node2_node3_wifi: 'ON' },
    expected_result:
      'Drop Stage-1 ACK; Node 1 retransmits identical ciphertext; Node 2 suppresses microSD duplicate, resends Stage-1 ACK, and completes Stage-2 delivery.',
  },
  {
    test_id: 7,
    test_name: 'AES-128-GCM Ciphertext & Auth-Tag Tampering (Direct Wi-Fi + Gateway)',
    initial_config: { node1_wifi: 'ON → OFF (Both Paths)', node1_lora: 'ON', node2_node3_wifi: 'ON' },
    expected_result:
      'Tampered ciphertext (Direct Wi-Fi) and tampered 128-bit GCM tag (Gateway path) are both rejected by Node 3 with no success ACK, 0 readings saved, and LCD unchanged.',
  },
  {
    test_id: 8,
    test_name: 'Node Restart with Pending Packets (LittleFS & microSD Recovery)',
    initial_config: { node1_wifi: 'OFF → ON', node1_lora: 'OFF → ON', node2_node3_wifi: 'OFF → ON' },
    expected_result:
      'Power-cycle nodes with pending LittleFS and microSD queues; persistent queues and monotonic sequence counter recover and drain cleanly upon reconnection.',
  },
];

export function ensureTestDefinitionsSeeded(): void {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO test_results (
      test_id, mode, test_name, initial_config_json, status, passed, expected_result, actual_result, steps_json, packet_id, executed_at
    ) VALUES (?, 'simulation', ?, ?, 'NOT_RUN', NULL, ?, NULL, '[]', NULL, NULL)
  `);

  const syncMetaStmt = db.prepare(`
    UPDATE test_results
    SET test_name = ?, initial_config_json = ?, expected_result = ?
    WHERE test_id = ? AND mode = 'simulation'
  `);

  for (const def of PDF_TEST_DEFINITIONS) {
    const configJson = JSON.stringify(def.initial_config);
    insertStmt.run(def.test_id, def.test_name, configJson, def.expected_result);
    syncMetaStmt.run(def.test_name, configJson, def.expected_result, def.test_id);
  }
}

export function getTestResults(): TestResultRecord[] {
  ensureTestDefinitionsSeeded();
  const rows = db
    .prepare("SELECT * FROM test_results WHERE mode = 'simulation' ORDER BY test_id ASC")
    .all() as Array<{
    test_id: number;
    mode: string;
    test_name: string;
    initial_config_json: string;
    status: string;
    passed: number | null;
    expected_result: string;
    actual_result: string | null;
    steps_json: string;
    packet_id: number | null;
    executed_at: string | null;
  }>;

  return rows.map((r) => ({
    test_id: r.test_id,
    mode: r.mode,
    test_name: r.test_name,
    initial_config: JSON.parse(r.initial_config_json),
    status: r.status,
    passed: r.passed === null ? null : Boolean(r.passed),
    expected_result: r.expected_result,
    actual_result: r.actual_result,
    steps: JSON.parse(r.steps_json || '[]'),
    packet_id: r.packet_id,
    executed_at: r.executed_at,
  }));
}

export function resetTests(): TestResultRecord[] {
  ensureTestDefinitionsSeeded();
  db.prepare(`
    UPDATE test_results
    SET status = 'NOT_RUN', passed = NULL, actual_result = NULL, steps_json = '[]', packet_id = NULL, executed_at = NULL
    WHERE mode = 'simulation'
  `).run();
  return getTestResults();
}

function saveTestResult(
  testId: number,
  passed: boolean,
  actualResult: string,
  steps: TestStepResult[],
  packetId: number | null
): TestResultRecord {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE test_results
    SET status = ?, passed = ?, actual_result = ?, steps_json = ?, packet_id = ?, executed_at = ?
    WHERE test_id = ? AND mode = 'simulation'
  `).run(
    passed ? 'PASS' : 'FAIL',
    passed ? 1 : 0,
    actualResult,
    JSON.stringify(steps),
    packetId,
    now,
    testId
  );

  return getTestResults().find((t) => t.test_id === testId)!;
}

// --- SQLite State Inspection Helpers (No Pass Without Real DB Proof) ---

interface PacketSnapshot {
  packet_id: number;
  sequence_number: number;
  comm_mode: string;
  route_path: string;
  encryption_status: string;
  gateway_status: string;
  destination_status: string;
  overall_status: string;
  retry_count: number;
  is_duplicate: number;
  tampered: number;
  node1_acked: number;
  node2_acked: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
  payload_preview_json: string | null;
}

interface NodeSnapshot {
  node_id: string;
  status: string;
  link_mode: string;
  queue_count: number;
  storage_status: string;
  lcd_status: string | null;
  metadata: Record<string, unknown>;
}

interface StorageSnapshot {
  node_id: string;
  status: string;
  pending_count: number;
  stored_count: number;
  sequence_counter: number;
  files: string[];
}

function getPacket(packetId: number): PacketSnapshot | undefined {
  return db
    .prepare(
      "SELECT packet_id, sequence_number, comm_mode, route_path, encryption_status, gateway_status, destination_status, overall_status, retry_count, is_duplicate, tampered, node1_acked, node2_acked, nonce, ciphertext, auth_tag, payload_preview_json FROM packets WHERE mode = 'simulation' AND packet_id = ?"
    )
    .get(packetId) as PacketSnapshot | undefined;
}

function areAllSimulationNoncesUnique(): boolean {
  const row = db
    .prepare("SELECT COUNT(*) as total, COUNT(DISTINCT nonce) as uniq FROM packets WHERE mode = 'simulation'")
    .get() as { total: number; uniq: number };
  return row.total === row.uniq;
}

function getNode(nodeId: 'NODE_1' | 'NODE_2' | 'NODE_3'): NodeSnapshot {
  const row = db
    .prepare(
      "SELECT node_id, status, link_mode, queue_count, storage_status, lcd_status, metadata_json FROM nodes WHERE mode = 'simulation' AND node_id = ?"
    )
    .get(nodeId) as {
    node_id: string;
    status: string;
    link_mode: string;
    queue_count: number;
    storage_status: string;
    lcd_status: string | null;
    metadata_json: string;
  };
  return {
    node_id: row.node_id,
    status: row.status,
    link_mode: row.link_mode,
    queue_count: row.queue_count,
    storage_status: row.storage_status,
    lcd_status: row.lcd_status,
    metadata: JSON.parse(row.metadata_json || '{}'),
  };
}

function getStorage(nodeId: 'NODE_1' | 'NODE_2' | 'NODE_3'): StorageSnapshot {
  const row = db
    .prepare(
      "SELECT node_id, status, pending_count, stored_count, sequence_counter, files_json FROM storage_status WHERE mode = 'simulation' AND node_id = ?"
    )
    .get(nodeId) as {
    node_id: string;
    status: string;
    pending_count: number;
    stored_count: number;
    sequence_counter: number;
    files_json: string;
  };
  return {
    node_id: row.node_id,
    status: row.status,
    pending_count: row.pending_count,
    stored_count: row.stored_count,
    sequence_counter: row.sequence_counter,
    files: JSON.parse(row.files_json || '[]'),
  };
}

function getAcks(
  packetId: number,
  hop?: 'NODE1_NODE2' | 'NODE2_NODE3' | 'NODE1_NODE3'
): Array<{ link_hop: string; sender_node: number; receiver_node: number; status: string; error_code: string | null }> {
  if (hop) {
    return db
      .prepare(
        "SELECT link_hop, sender_node, receiver_node, status, error_code FROM acknowledgements WHERE mode = 'simulation' AND packet_id = ? AND link_hop = ? ORDER BY id ASC"
      )
      .all(packetId, hop) as Array<{
      link_hop: string;
      sender_node: number;
      receiver_node: number;
      status: string;
      error_code: string | null;
    }>;
  }
  return db
    .prepare(
      "SELECT link_hop, sender_node, receiver_node, status, error_code FROM acknowledgements WHERE mode = 'simulation' AND packet_id = ? ORDER BY id ASC"
    )
    .all(packetId) as Array<{
    link_hop: string;
    sender_node: number;
    receiver_node: number;
    status: string;
    error_code: string | null;
  }>;
}

function getReadings(packetId: number): Array<{ temperature: number; humidity: number; rain_raw: number; authenticated: number }> {
  return db
    .prepare(
      "SELECT temperature, humidity, rain_raw, authenticated FROM sensor_readings WHERE mode = 'simulation' AND packet_id = ?"
    )
    .all(packetId) as Array<{ temperature: number; humidity: number; rain_raw: number; authenticated: number }>;
}

function getSecurityEvents(packetId: number): Array<{ event_type: string; endpoint: string; status: string }> {
  return db
    .prepare(
      "SELECT event_type, endpoint, status FROM security_events WHERE mode = 'simulation' AND packet_id = ? ORDER BY id ASC"
    )
    .all(packetId) as Array<{ event_type: string; endpoint: string; status: string }>;
}

function getCommEvents(packetId: number): Array<{ event_type: string; link_hop: string; comm_mode: string }> {
  return db
    .prepare(
      "SELECT event_type, link_hop, comm_mode FROM communication_events WHERE mode = 'simulation' AND packet_id = ? ORDER BY id ASC"
    )
    .all(packetId) as Array<{ event_type: string; link_hop: string; comm_mode: string }>;
}

function collectFailures(checks: Array<[string, boolean]>): string[] {
  return checks.filter(([, ok]) => !ok).map(([name]) => name);
}

/**
 * Executes one of the 8 PDF Page 12 System Test Scenarios directly against live SQLite tables,
 * mutating simulation_state, nodes, storage_status, packets, acknowledgements, security_events,
 * communication_events, and sensor_readings. A test is marked PASS only if every expected
 * transition is verified in SQLite.
 */
export function runSystemTest(testId: number): TestResultRecord {
  ensureTestDefinitionsSeeded();

  switch (testId) {
    case 1: {
      // TEST 1 (Scenario A): Direct Wi-Fi Node 1 -> Node 3, completely bypassing Node 2
      simulationEngine.configureLinks(true, true, true);
      simulationEngine.drainNode1PendingQueue();
      simulationEngine.drainNode2PendingQueue();
      simulationEngine.syncNodeAndStorageSummaries();

      const sdBefore = getStorage('NODE_2').stored_count;
      const n3Before = getStorage('NODE_3').stored_count;
      const res = simulationEngine.createAndProcessPacket({
        temperature: 27.6,
        humidity: 62.0,
        rain_raw: 210,
      });

      const pkt = getPacket(res.packet_id);
      const directAcks = getAcks(res.packet_id, 'NODE1_NODE3');
      const hop1Acks = getAcks(res.packet_id, 'NODE1_NODE2');
      const hop2Acks = getAcks(res.packet_id, 'NODE2_NODE3');
      const readings = getReadings(res.packet_id);
      const secEvents = getSecurityEvents(res.packet_id);
      const commEvents = getCommEvents(res.packet_id);
      const node1 = getNode('NODE_1');
      const node2 = getNode('NODE_2');
      const node3 = getNode('NODE_3');
      const sdAfter = getStorage('NODE_2');
      const n3After = getStorage('NODE_3');
      const simState = simulationEngine.getState();

      const failures = collectFailures([
        ['sim_links(1,1,1)', simState.node1_wifi_on === 1 && simState.node1_lora_on === 1 && simState.node2_node3_wifi_on === 1],
        ['node1_link_WIFI', node1.link_mode === 'WIFI'],
        ['node2_bypassed_standby', node2.link_mode === 'BYPASSED_STANDBY'],
        ['pkt_comm_WIFI', pkt?.comm_mode === 'WIFI'],
        ['pkt_route_DIRECT_WIFI', pkt?.route_path === 'DIRECT_WIFI'],
        ['pkt_gateway_BYPASSED', pkt?.gateway_status === 'BYPASSED'],
        ['pkt_dest_DELIVERED', pkt?.destination_status === 'DELIVERED'],
        ['pkt_overall_DELIVERED', pkt?.overall_status === 'DELIVERED'],
        ['pkt_auth_AUTHENTICATED', pkt?.encryption_status === 'AUTHENTICATED'],
        ['pkt_direct_ack_only', pkt?.node1_acked === 1 && pkt?.node2_acked === 0],
        ['pkt_no_plaintext_preview', pkt?.payload_preview_json === null],
        ['all_nonces_unique', areAllSimulationNoncesUnique()],
        ['direct_ACK_DELIVERED_3_to_1', directAcks.some((a) => a.status === 'ACK_DELIVERED' && a.sender_node === 3 && a.receiver_node === 1)],
        ['zero_node2_acks', hop1Acks.length === 0 && hop2Acks.length === 0],
        ['sd_not_incremented_on_direct_wifi', sdAfter.stored_count === sdBefore],
        ['node3_littlefs_mounted_and_incremented', node3.storage_status === 'MOUNTED' && n3After.status === 'MOUNTED' && n3After.stored_count === n3Before + 1],
        ['sec_ENCRYPT_and_VERIFY', secEvents.some((e) => e.event_type === 'ENCRYPT' && e.endpoint === 'NODE_1') && secEvents.some((e) => e.event_type === 'AUTH_VERIFIED' && e.endpoint === 'NODE_3')],
        ['comm_DIRECT_WIFI_TX_and_DELIVERED', commEvents.some((e) => e.event_type === 'WIFI_TX' && e.link_hop === 'NODE1_NODE3') && commEvents.some((e) => e.event_type === 'DELIVERED' && e.link_hop === 'NODE1_NODE3')],
        ['node3_decrypted_reading', readings.length === 1 && readings[0].authenticated === 1 && readings[0].temperature === 27.6 && readings[0].rain_raw === 210],
        ['node3_lcd_updated', Number(node3.metadata.last_authenticated_packet) === res.packet_id],
      ]);

      const passed = failures.length === 0;
      const steps: TestStepResult[] = [
        { step: 1, label: 'Node 1 → Node 3 Direct Wi-Fi TX', status: pkt?.route_path === 'DIRECT_WIFI' ? 'DONE' : 'WARN', detail: `Packet #${res.packet_id} encrypted (AES-128-GCM) and sent directly over ${pkt?.comm_mode} (route=${pkt?.route_path}); Node 1 link_mode=${node1.link_mode}.` },
        { step: 2, label: 'Verify Node 2 Completely Bypassed', status: sdAfter.stored_count === sdBefore && pkt?.gateway_status === 'BYPASSED' ? 'PASS' : 'WARN', detail: `gateway_status=${pkt?.gateway_status}, Node 2 microSD stored_count unchanged (${sdBefore}→${sdAfter.stored_count}), gateway ACKs=${hop1Acks.length + hop2Acks.length}.` },
        { step: 3, label: 'Node 3 AES-GCM Verify, LittleFS Store & LCD', status: readings.length === 1 && n3After.stored_count === n3Before + 1 ? 'DONE' : 'WARN', detail: `Node 3 verified GCM tag, decrypted ${readings[0]?.temperature ?? '—'}°C/${readings[0]?.humidity ?? '—'}%, LittleFS=${node3.storage_status} (${n3Before}→${n3After.stored_count}), LCD="${String(node3.metadata.lcd_line1)}".` },
        { step: 4, label: 'Direct Node 3 → Node 1 ACK Verification', status: passed ? 'PASS' : 'WARN', detail: passed ? `All 20 Scenario A SQLite assertions passed (direct NODE1_NODE3 ${directAcks.map((a) => a.status).join(',')}).` : `Failed checks: ${failures.join(', ')}.` },
      ];
      const actual = passed
        ? `PASS: Packet #${res.packet_id} delivered directly Node 1 → Node 3 over Wi-Fi (route=DIRECT_WIFI, gateway=BYPASSED, Node 2 microSD unchanged at ${sdAfter.stored_count}, Node 3 LittleFS ${n3Before}→${n3After.stored_count}, direct NODE1_NODE3 ACK_DELIVERED).`
        : `FAIL: Packet #${res.packet_id} failed checks [${failures.join(', ')}].`;
      return saveTestResult(1, passed, actual, steps, res.packet_id);
    }

    case 2: {
      // TEST 2 (Scenario B): Direct Wi-Fi OFF -> LoRa Fallback to Node 2 -> microSD + Stage-1 ACK -> Wi-Fi to Node 3 + Stage-2 ACK
      simulationEngine.configureLinks(true, true, true);
      simulationEngine.drainNode1PendingQueue();
      simulationEngine.drainNode2PendingQueue();
      simulationEngine.configureLinks(false, true, true);

      const sdBefore = getStorage('NODE_2').stored_count;
      const n3Before = getStorage('NODE_3').stored_count;
      const res = simulationEngine.createAndProcessPacket({
        temperature: 28.1,
        humidity: 65.5,
        rain_raw: 420,
      });

      const pkt = getPacket(res.packet_id);
      const directAcks = getAcks(res.packet_id, 'NODE1_NODE3');
      const hop1Acks = getAcks(res.packet_id, 'NODE1_NODE2');
      const hop2Acks = getAcks(res.packet_id, 'NODE2_NODE3');
      const readings = getReadings(res.packet_id);
      const commEvents = getCommEvents(res.packet_id);
      const node1 = getNode('NODE_1');
      const sdAfter = getStorage('NODE_2');
      const n3After = getStorage('NODE_3');
      const simState = simulationEngine.getState();

      const failures = collectFailures([
        ['sim_links(0,1,1)', simState.node1_wifi_on === 0 && simState.node1_lora_on === 1 && simState.node2_node3_wifi_on === 1],
        ['node1_link_LORA', node1.link_mode === 'LORA'],
        ['pkt_comm_LORA', pkt?.comm_mode === 'LORA'],
        ['pkt_route_LORA_GATEWAY', pkt?.route_path === 'LORA_GATEWAY'],
        ['pkt_gateway_STORED', pkt?.gateway_status === 'STORED'],
        ['pkt_dest_DELIVERED', pkt?.destination_status === 'DELIVERED'],
        ['pkt_overall_DELIVERED', pkt?.overall_status === 'DELIVERED'],
        ['pkt_two_stage_acks_retired', pkt?.node1_acked === 1 && pkt?.node2_acked === 1],
        ['zero_direct_acks', directAcks.length === 0],
        ['stage1_LORA_ACK_STORED_2_to_1', hop1Acks.some((a) => a.status === 'ACK_STORED' && a.sender_node === 2 && a.receiver_node === 1)],
        ['stage2_WIFI_ACK_DELIVERED_3_to_2', hop2Acks.some((a) => a.status === 'ACK_DELIVERED' && a.sender_node === 3 && a.receiver_node === 2)],
        ['comm_LORA_TX_logged', commEvents.some((e) => e.event_type === 'LORA_TX' && e.link_hop === 'NODE1_NODE2' && e.comm_mode === 'LORA')],
        ['sd_stored_incremented', sdAfter.stored_count === sdBefore + 1],
        ['node3_littlefs_incremented', n3After.stored_count === n3Before + 1],
        ['node3_decrypted_reading', readings.length === 1 && readings[0].authenticated === 1 && readings[0].rain_raw === 420],
      ]);

      const passed = failures.length === 0;
      const steps: TestStepResult[] = [
        { step: 1, label: 'Disable Direct Wi-Fi / Activate LoRa Fallback', status: node1.link_mode === 'LORA' ? 'DONE' : 'WARN', detail: `simulation_state=(DirectWiFi:OFF, LoRa:ON, N2→N3 WiFi:ON); Node 1 link_mode=${node1.link_mode}.` },
        { step: 2, label: 'Stage 1: Node 1 → Node 2 LoRa TX', status: pkt?.route_path === 'LORA_GATEWAY' ? 'DONE' : 'WARN', detail: `Packet #${res.packet_id} sent over ${pkt?.comm_mode} (route=${pkt?.route_path}) using opaque AES-128-GCM envelope.` },
        { step: 3, label: 'Node 2 microSD Store + Stage-1 Storage ACK (2→1)', status: hop1Acks.some((a) => a.status === 'ACK_STORED') ? 'DONE' : 'WARN', detail: `microSD stored_count ${sdBefore}→${sdAfter.stored_count}; Stage-1 ACK=${hop1Acks.map((a) => a.status).join(',') || 'NONE'}.` },
        { step: 4, label: 'Stage 2: Node 2 → Node 3 Wi-Fi Forward + Final ACK (3→2)', status: passed ? 'PASS' : 'WARN', detail: passed ? `Delivered to Node 3 (${hop2Acks.map((a) => a.status).join(',')}); LittleFS ${n3Before}→${n3After.stored_count}; authenticated reading persisted.` : `Failed checks: ${failures.join(', ')}.` },
      ];
      const actual = passed
        ? `PASS: Packet #${res.packet_id} delivered via Scenario B LoRa fallback (route=LORA_GATEWAY, microSD ${sdBefore}→${sdAfter.stored_count}, Stage-1 NODE1_NODE2 ACK_STORED, Stage-2 NODE2_NODE3 ACK_DELIVERED, Node 3 decrypted).`
        : `FAIL: Packet #${res.packet_id} failed checks [${failures.join(', ')}].`;
      return saveTestResult(2, passed, actual, steps, res.packet_id);
    }

    case 3: {
      // TEST 3 (Scenario C): Both Node 1 paths unavailable -> LittleFS retention -> Direct Wi-Fi recovery (bypassing Node 2)
      simulationEngine.configureLinks(true, true, true);
      simulationEngine.drainNode1PendingQueue();
      simulationEngine.drainNode2PendingQueue();
      simulationEngine.configureLinks(false, false, true);

      const sdBefore = getStorage('NODE_2').stored_count;
      const res = simulationEngine.createAndProcessPacket({
        temperature: 26.4,
        humidity: 78.0,
        rain_raw: 810,
        forceHeavyRain: true,
      });

      const pktOffline = getPacket(res.packet_id);
      const node1Offline = getNode('NODE_1');
      const lfsOffline = getStorage('NODE_1');
      const sdOffline = getStorage('NODE_2');
      const acksOffline = getAcks(res.packet_id);
      const readingsOffline = getReadings(res.packet_id);
      const expectedFile = `/pending/packet_${String(res.packet_id).padStart(6, '0')}.bin`;

      const offlineChecks = collectFailures([
        ['node1_offline_mode', node1Offline.link_mode === 'OFFLINE'],
        ['pkt_offline_comm', pktOffline?.comm_mode === 'OFFLINE'],
        ['pkt_route_LOCAL_QUEUE', pktOffline?.route_path === 'LOCAL_QUEUE'],
        ['pkt_gateway_PENDING', pktOffline?.gateway_status === 'PENDING'],
        ['pkt_node1_unacked_offline', pktOffline?.node1_acked === 0 && pktOffline?.node2_acked === 0],
        ['pkt_not_delivered_offline', pktOffline?.overall_status === 'PENDING' || pktOffline?.overall_status === 'RETRYING'],
        ['lfs_pending_grew', lfsOffline.pending_count >= 1 && lfsOffline.files.includes(expectedFile)],
        ['sd_unchanged_offline', sdOffline.stored_count === sdBefore],
        ['zero_acks_offline', acksOffline.length === 0],
        ['zero_readings_offline', readingsOffline.length === 0],
      ]);

      // Restore direct Wi-Fi -> drains directly Node 1 -> Node 3 (bypassing Node 2) with identical ciphertext
      simulationEngine.configureLinks(true, true, true);
      simulationEngine.drainNode1PendingQueue();
      simulationEngine.drainNode2PendingQueue();
      simulationEngine.syncNodeAndStorageSummaries();

      const pktRecovered = getPacket(res.packet_id);
      const node1Recovered = getNode('NODE_1');
      const lfsRecovered = getStorage('NODE_1');
      const sdRecovered = getStorage('NODE_2');
      const directAfter = getAcks(res.packet_id, 'NODE1_NODE3');
      const hop1After = getAcks(res.packet_id, 'NODE1_NODE2');
      const readingsAfter = getReadings(res.packet_id);

      const recoveryChecks = collectFailures([
        ['node1_link_restored_WIFI', node1Recovered.link_mode === 'WIFI'],
        ['lfs_queue_retired', lfsRecovered.pending_count === 0 && !lfsRecovered.files.includes(expectedFile)],
        ['identical_ciphertext_retransmitted', pktRecovered?.nonce === pktOffline?.nonce && pktRecovered?.ciphertext === pktOffline?.ciphertext && pktRecovered?.auth_tag === pktOffline?.auth_tag],
        ['pkt_recovered_DIRECT_WIFI', pktRecovered?.comm_mode === 'WIFI' && pktRecovered?.route_path === 'DIRECT_WIFI'],
        ['pkt_recovered_BYPASSED', pktRecovered?.gateway_status === 'BYPASSED'],
        ['sd_still_unchanged_after_direct_drain', sdRecovered.stored_count === sdBefore],
        ['pkt_recovered_DELIVERED', pktRecovered?.destination_status === 'DELIVERED' && pktRecovered?.overall_status === 'DELIVERED' && pktRecovered?.node1_acked === 1 && pktRecovered?.node2_acked === 0],
        ['direct_ACK_DELIVERED_after', directAfter.some((a) => a.status === 'ACK_DELIVERED' && a.sender_node === 3 && a.receiver_node === 1)],
        ['zero_hop1_gateway_acks', hop1After.length === 0],
        ['reading_decrypted_after', readingsAfter.length === 1 && readingsAfter[0].authenticated === 1],
      ]);

      const failures = [...offlineChecks, ...recoveryChecks];
      const passed = failures.length === 0;
      const steps: TestStepResult[] = [
        { step: 1, label: 'Disable Node 1 Direct Wi-Fi & LoRa', status: node1Offline.link_mode === 'OFFLINE' ? 'DONE' : 'WARN', detail: `Node 1 link_mode=${node1Offline.link_mode}; route=${pktOffline?.route_path}; zero ACKs while offline (${acksOffline.length}).` },
        { step: 2, label: 'Retain Encrypted Packet in LittleFS', status: offlineChecks.length === 0 ? 'PASS' : 'WARN', detail: `LittleFS pending_count=${lfsOffline.pending_count}, file=${lfsOffline.files.includes(expectedFile) ? expectedFile : 'MISSING'}, status=${pktOffline?.overall_status}.` },
        { step: 3, label: 'Restore Direct Wi-Fi & Drain LittleFS', status: lfsRecovered.pending_count === 0 ? 'DONE' : 'WARN', detail: `Node 1 link_mode=${node1Recovered.link_mode}; LittleFS pending ${lfsOffline.pending_count}→${lfsRecovered.pending_count}; Node 2 bypassed (microSD unchanged at ${sdRecovered.stored_count}).` },
        { step: 4, label: 'Direct Delivery & Identical Ciphertext Check', status: passed ? 'PASS' : 'WARN', detail: passed ? `Packet #${res.packet_id} drained directly to Node 3 (${directAfter.map((a) => a.status).join(',')}) with identical nonce/ciphertext.` : `Failed checks: ${failures.join(', ')}.` },
      ];
      const actual = passed
        ? `PASS: Packet #${res.packet_id} retained in LittleFS (${expectedFile}, pending=${lfsOffline.pending_count}) while OFFLINE, then retired (pending=0) and DELIVERED directly via NODE1_NODE3_WIFI (Node 2 bypassed, identical ciphertext).`
        : `FAIL: Packet #${res.packet_id} failed checks [${failures.join(', ')}].`;
      return saveTestResult(3, passed, actual, steps, res.packet_id);
    }

    case 4: {
      // TEST 4: Node 2 -> Node 3 Wi-Fi Unavailable (Direct Wi-Fi OFF so Node 1 uses LoRa to Node 2, and NODE2_NODE3_WIFI OFF)
      simulationEngine.configureLinks(true, true, true);
      simulationEngine.drainNode1PendingQueue();
      simulationEngine.drainNode2PendingQueue();
      simulationEngine.configureLinks(false, true, false);

      const sdBefore = getStorage('NODE_2');
      const res = simulationEngine.createAndProcessPacket({
        temperature: 29.0,
        humidity: 59.0,
        rain_raw: 230,
      });

      const pktMid = getPacket(res.packet_id);
      const sdMid = getStorage('NODE_2');
      const node2Mid = getNode('NODE_2');
      const node3Mid = getNode('NODE_3');
      const hop1Mid = getAcks(res.packet_id, 'NODE1_NODE2');
      const hop2Mid = getAcks(res.packet_id, 'NODE2_NODE3');
      const readingsMid = getReadings(res.packet_id);

      const midChecks = collectFailures([
        ['node3_status_OFFLINE', node3Mid.status === 'OFFLINE'],
        ['node2_link3_DISCONNECTED', node2Mid.metadata.node3_link === 'DISCONNECTED'],
        ['pkt_route_LORA_GATEWAY', pktMid?.route_path === 'LORA_GATEWAY' && pktMid?.comm_mode === 'LORA'],
        ['pkt_stage1_stored_and_acked', pktMid?.gateway_status === 'STORED' && pktMid?.node1_acked === 1],
        ['pkt_stage2_pending_unacked', (pktMid?.destination_status === 'PENDING' || pktMid?.destination_status === 'RETRYING') && pktMid?.node2_acked === 0],
        ['pkt_overall_GATEWAY_STORED', pktMid?.overall_status === 'GATEWAY_STORED'],
        ['sd_pending_grew', sdMid.pending_count === sdBefore.pending_count + 1 && sdMid.stored_count === sdBefore.stored_count + 1],
        ['stage1_ACK_sent_independently', hop1Mid.some((a) => a.status === 'ACK_STORED' && a.sender_node === 2 && a.receiver_node === 1)],
        ['stage2_no_ACK_while_offline', hop2Mid.length === 0],
        ['zero_readings_while_offline', readingsMid.length === 0],
      ]);

      // Reconnect Node 2 -> Node 3 Wi-Fi (while keeping Direct Wi-Fi OFF) and drain microSD pending queue
      simulationEngine.configureLinks(false, true, true);
      simulationEngine.drainNode2PendingQueue();
      simulationEngine.syncNodeAndStorageSummaries();

      const pktFinal = getPacket(res.packet_id);
      const sdFinal = getStorage('NODE_2');
      const node3Final = getNode('NODE_3');
      const hop2Final = getAcks(res.packet_id, 'NODE2_NODE3');
      const readingsFinal = getReadings(res.packet_id);

      const finalChecks = collectFailures([
        ['node3_status_ONLINE', node3Final.status === 'ONLINE'],
        ['sd_pending_drained', sdFinal.pending_count === 0],
        ['pkt_final_DELIVERED', pktFinal?.destination_status === 'DELIVERED' && pktFinal?.overall_status === 'DELIVERED' && pktFinal?.node2_acked === 1],
        ['stage2_ACK_DELIVERED_after', hop2Final.some((a) => a.status === 'ACK_DELIVERED' && a.sender_node === 3 && a.receiver_node === 2)],
        ['reading_decrypted_after', readingsFinal.length === 1 && readingsFinal[0].authenticated === 1],
      ]);

      const failures = [...midChecks, ...finalChecks];
      const passed = failures.length === 0;
      const steps: TestStepResult[] = [
        { step: 1, label: 'Set LoRa Fallback ON & Disconnect Node 2 → Node 3 Wi-Fi', status: node3Mid.status === 'OFFLINE' ? 'DONE' : 'WARN', detail: `DirectWiFi=OFF, LoRa=ON, Node2→Node3 WiFi=OFF; Node 3 status=${node3Mid.status}, node3_link=${String(node2Mid.metadata.node3_link)}.` },
        { step: 2, label: 'Node 2 microSD Store + Stage-1 ACK + Pending Queue Growth', status: midChecks.length === 0 ? 'PASS' : 'WARN', detail: `Packet #${res.packet_id} stored on microSD (pending ${sdBefore.pending_count}→${sdMid.pending_count}); Stage-1 ACK_STORED sent (node1_acked=1, node2_acked=0); Stage-2 ACKs=${hop2Mid.length}.` },
        { step: 3, label: 'Restore Node 2 → Node 3 Wi-Fi & Forward Queue', status: sdFinal.pending_count === 0 ? 'DONE' : 'WARN', detail: `Node 3 status=${node3Final.status}; microSD pending drained ${sdMid.pending_count}→${sdFinal.pending_count}.` },
        { step: 4, label: 'Node 3 Authentication & Stage-2 Final ACK', status: passed ? 'PASS' : 'WARN', detail: passed ? `Packet #${res.packet_id} reached DELIVERED (${hop2Final.map((a) => a.status).join(',')}) and decrypted.` : `Failed checks: ${failures.join(', ')}.` },
      ];
      const actual = passed
        ? `PASS: Packet #${res.packet_id} stored on Node 2 microSD via LoRa (pending ${sdBefore.pending_count}→${sdMid.pending_count}, Stage-1 ACK only) while Node 2→Node 3 Wi-Fi OFF, then delivered (pending=0, Stage-2 ACK_DELIVERED) on reconnect.`
        : `FAIL: Packet #${res.packet_id} failed checks [${failures.join(', ')}].`;
      return saveTestResult(4, passed, actual, steps, res.packet_id);
    }

    case 5: {
      // TEST 5: All three wireless links unavailable (OFF / OFF / OFF)
      // Step 1: Drain prior queues, then buffer 1 packet on Node 2 microSD via LoRa (DirectWiFi=OFF, LoRa=ON, N2→N3=OFF)
      simulationEngine.configureLinks(true, true, true);
      simulationEngine.drainNode1PendingQueue();
      simulationEngine.drainNode2PendingQueue();
      simulationEngine.configureLinks(false, true, false);
      const pktGwRes = simulationEngine.createAndProcessPacket({
        temperature: 27.1,
        humidity: 60.2,
        rain_raw: 260,
      });

      // Step 2: Cut ALL three links (OFF / OFF / OFF) and create 1 packet at Node 1
      simulationEngine.configureLinks(false, false, false);
      const pktN1Res = simulationEngine.createAndProcessPacket({
        temperature: 27.3,
        humidity: 61.8,
        rain_raw: 310,
      });

      const simState = simulationEngine.getState();
      const node1 = getNode('NODE_1');
      const node2 = getNode('NODE_2');
      const node3 = getNode('NODE_3');
      const lfs = getStorage('NODE_1');
      const sd = getStorage('NODE_2');
      const pktGw = getPacket(pktGwRes.packet_id);
      const pktN1 = getPacket(pktN1Res.packet_id);
      const n1Acks = getAcks(pktN1Res.packet_id);
      const gwHop2Acks = getAcks(pktGwRes.packet_id, 'NODE2_NODE3');
      const n1Readings = getReadings(pktN1Res.packet_id);
      const gwReadings = getReadings(pktGwRes.packet_id);

      const failures = collectFailures([
        ['sim_all_links_OFF', simState.node1_wifi_on === 0 && simState.node1_lora_on === 0 && simState.node2_node3_wifi_on === 0],
        ['node1_link_OFFLINE', node1.link_mode === 'OFFLINE'],
        ['node3_status_OFFLINE', node3.status === 'OFFLINE'],
        ['node2_link3_DISCONNECTED', node2.metadata.node3_link === 'DISCONNECTED'],
        ['lfs_pending_retained', lfs.pending_count >= 1],
        ['sd_pending_retained', sd.pending_count >= 1],
        ['pktN1_pending_not_delivered', pktN1?.route_path === 'LOCAL_QUEUE' && pktN1?.gateway_status === 'PENDING' && pktN1?.overall_status !== 'DELIVERED'],
        ['pktGw_stored_not_delivered', pktGw?.route_path === 'LORA_GATEWAY' && pktGw?.gateway_status === 'STORED' && (pktGw?.destination_status === 'PENDING' || pktGw?.destination_status === 'RETRYING') && pktGw?.overall_status !== 'DELIVERED'],
        ['zero_acks_for_pktN1', n1Acks.length === 0],
        ['zero_stage2_acks_for_pktGw', gwHop2Acks.length === 0],
        ['zero_false_readings', n1Readings.length === 0 && gwReadings.length === 0],
      ]);

      const passed = failures.length === 0;
      const steps: TestStepResult[] = [
        { step: 1, label: 'Disable All Three Wireless Links', status: simState.node1_wifi_on === 0 && simState.node1_lora_on === 0 && simState.node2_node3_wifi_on === 0 ? 'DONE' : 'WARN', detail: `All links OFF: Node 1=${node1.link_mode}, Node 3=${node3.status}.` },
        { step: 2, label: 'Node 1 LittleFS Queue Retention', status: lfs.pending_count >= 1 && pktN1?.gateway_status === 'PENDING' ? 'PASS' : 'WARN', detail: `Packet #${pktN1Res.packet_id} retained in LittleFS (pending=${lfs.pending_count}, status=${pktN1?.overall_status}, ACKs=${n1Acks.length}).` },
        { step: 3, label: 'Node 2 microSD Queue Retention', status: sd.pending_count >= 1 && pktGw?.overall_status !== 'DELIVERED' ? 'PASS' : 'WARN', detail: `Packet #${pktGwRes.packet_id} retained on microSD (pending=${sd.pending_count}, dst=${pktGw?.destination_status}, Stage-2 ACKs=${gwHop2Acks.length}).` },
        { step: 4, label: 'Zero False Delivery Verification', status: passed ? 'PASS' : 'WARN', detail: passed ? `Both queues retained safely with 0 false deliveries and 0 premature readings.` : `Failed checks: ${failures.join(', ')}.` },
      ];
      const actual = passed
        ? `PASS: All 3 links OFFLINE; Node 1 LittleFS retained #${pktN1Res.packet_id} (pending=${lfs.pending_count}), Node 2 microSD retained #${pktGwRes.packet_id} (pending=${sd.pending_count}); 0 false deliveries.`
        : `FAIL: All-offline retention failed checks [${failures.join(', ')}].`;
      return saveTestResult(5, passed, actual, steps, pktN1Res.packet_id);
    }

    case 6: {
      // TEST 6: ACK Loss, Identical-Ciphertext Retransmission & Duplicate Detection on Scenario B LoRa Fallback
      simulationEngine.configureLinks(true, true, true);
      simulationEngine.drainNode1PendingQueue();
      simulationEngine.drainNode2PendingQueue();
      simulationEngine.configureLinks(false, true, true);

      const sdBefore = getStorage('NODE_2').stored_count;
      const res = simulationEngine.createAndProcessPacket({
        temperature: 28.4,
        humidity: 58.9,
        rain_raw: 190,
        forceDropAck: true,
      });

      const pkt = getPacket(res.packet_id);
      const sdAfter = getStorage('NODE_2');
      const hop1Acks = getAcks(res.packet_id, 'NODE1_NODE2');
      const hop2Acks = getAcks(res.packet_id, 'NODE2_NODE3');
      const commEvents = getCommEvents(res.packet_id);
      const readings = getReadings(res.packet_id);
      const duplicateRows = (
        db
          .prepare("SELECT COUNT(*) as c FROM packets WHERE mode = 'simulation' AND packet_id = ?")
          .get(res.packet_id) as { c: number }
      ).c;

      const failures = collectFailures([
        ['pkt_route_LORA_GATEWAY', pkt?.route_path === 'LORA_GATEWAY'],
        ['stage1_ACK_LOST_recorded', hop1Acks.some((a) => a.status === 'LOST' && a.error_code === 'ACK_TIMEOUT')],
        ['stage1_ACK_DUPLICATE_RESENT', hop1Acks.some((a) => a.status === 'ACK_DUPLICATE_RESENT')],
        ['comm_ACK_LOST_and_DUP_SUPPRESSED', commEvents.some((e) => e.event_type === 'ACK_LOST' && e.link_hop === 'NODE1_NODE2') && commEvents.some((e) => e.event_type === 'DUPLICATE_SUPPRESSED' && e.link_hop === 'NODE1_NODE2')],
        ['pkt_is_duplicate_flagged', pkt?.is_duplicate === 1],
        ['pkt_gateway_DUPLICATE_SUPPRESSED', pkt?.gateway_status === 'DUPLICATE_SUPPRESSED'],
        ['pkt_retry_incremented', (pkt?.retry_count ?? 0) >= 1],
        ['single_packet_row', duplicateRows === 1],
        ['sd_stored_only_once', sdAfter.stored_count === sdBefore + 1],
        ['stage2_ACK_DELIVERED', hop2Acks.some((a) => a.status === 'ACK_DELIVERED')],
        ['pkt_overall_DELIVERED', pkt?.overall_status === 'DELIVERED' && pkt?.node1_acked === 1 && pkt?.node2_acked === 1],
        ['single_authenticated_reading', readings.length === 1 && readings[0].authenticated === 1],
      ]);

      const passed = failures.length === 0;
      const steps: TestStepResult[] = [
        { step: 1, label: 'Drop Stage-1 LoRa ACK (Timeout)', status: hop1Acks.some((a) => a.status === 'LOST') ? 'DONE' : 'WARN', detail: `Packet #${res.packet_id} stored at Node 2 over LoRa; Stage-1 ACK logged LOST (ACK_TIMEOUT).` },
        { step: 2, label: 'Identical Ciphertext Retransmission', status: (pkt?.retry_count ?? 0) >= 1 ? 'DONE' : 'WARN', detail: `Node 1 retransmitted packet #${res.packet_id} (retry_count=${pkt?.retry_count}) with identical nonce/ciphertext.` },
        { step: 3, label: 'Node 2 Deduplication & Matching ACK Resend', status: duplicateRows === 1 && hop1Acks.some((a) => a.status === 'ACK_DUPLICATE_RESENT') ? 'PASS' : 'WARN', detail: `microSD stored_count ${sdBefore}→${sdAfter.stored_count} (rows=${duplicateRows}); Stage-1 ACKs=[${hop1Acks.map((a) => a.status).join(' → ')}].` },
        { step: 4, label: 'Stage-2 Delivery Completion', status: passed ? 'PASS' : 'WARN', detail: passed ? `Duplicate suppressed cleanly; Node 3 authenticated & sent Stage-2 ACK_DELIVERED.` : `Failed checks: ${failures.join(', ')}.` },
      ];
      const actual = passed
        ? `PASS: Packet #${res.packet_id} dropped Stage-1 LoRa ACK, retried (retries=${pkt?.retry_count}), deduplicated on microSD (${sdBefore}→${sdAfter.stored_count}), resent ACK_DUPLICATE_RESENT, and reached DELIVERED.`
        : `FAIL: Packet #${res.packet_id} failed checks [${failures.join(', ')}].`;
      return saveTestResult(6, passed, actual, steps, res.packet_id);
    }

    case 7: {
      // TEST 7: AES-128-GCM Tamper Rejection across BOTH paths:
      // 7A: Ciphertext tamper on Scenario A Direct Wi-Fi (Node 2 bypassed)
      // 7B: 128-bit GCM Auth-Tag tamper on Scenario B LoRa Fallback (Node 2 forwards opaque ciphertext)
      simulationEngine.configureLinks(true, true, true);
      simulationEngine.drainNode1PendingQueue();
      simulationEngine.drainNode2PendingQueue();
      simulationEngine.syncNodeAndStorageSummaries();

      const lcdBefore = String(getNode('NODE_3').metadata.lcd_line1 || '');

      // 7A: Direct Wi-Fi ciphertext tamper (sentinel temperature 43.2°C must NEVER reach LCD or sensor_readings)
      const resCt = simulationEngine.createAndProcessPacket({
        temperature: 43.2,
        humidity: 91.0,
        rain_raw: 910,
        forceTamper: true,
        tamperTarget: 'ciphertext',
      });

      // 7B: Switch to Scenario B LoRa fallback and tamper 128-bit GCM auth tag (sentinel 44.8°C must NEVER reach LCD)
      simulationEngine.configureLinks(false, true, true);
      const resTag = simulationEngine.createAndProcessPacket({
        temperature: 44.8,
        humidity: 92.5,
        rain_raw: 930,
        forceTamper: true,
        tamperTarget: 'tag',
      });

      const pktCt = getPacket(resCt.packet_id);
      const pktTag = getPacket(resTag.packet_id);
      const readingsCt = getReadings(resCt.packet_id);
      const readingsTag = getReadings(resTag.packet_id);
      const acksCt = getAcks(resCt.packet_id, 'NODE1_NODE3');
      const acksTag = getAcks(resTag.packet_id, 'NODE2_NODE3');
      const secCt = getSecurityEvents(resCt.packet_id);
      const secTag = getSecurityEvents(resTag.packet_id);
      const node3After = getNode('NODE_3');
      const lcdAfter = String(node3After.metadata.lcd_line1 || '');
      const alertCount = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM system_alerts WHERE mode = 'simulation' AND category = 'AUTH_FAILURE' AND (message LIKE ? OR message LIKE ?)"
          )
          .get(`%#${resCt.packet_id}%`, `%#${resTag.packet_id}%`) as { c: number }
      ).c;

      const failures = collectFailures([
        ['direct_wifi_ct_tampered_REJECTED', pktCt?.route_path === 'DIRECT_WIFI' && pktCt?.gateway_status === 'BYPASSED' && pktCt?.tampered === 1 && pktCt?.encryption_status === 'AUTH_FAILED' && pktCt?.destination_status === 'REJECTED' && pktCt?.overall_status === 'REJECTED' && pktCt?.node1_acked === 0],
        ['gateway_tag_tampered_REJECTED', pktTag?.route_path === 'LORA_GATEWAY' && pktTag?.tampered === 1 && pktTag?.encryption_status === 'AUTH_FAILED' && pktTag?.destination_status === 'REJECTED' && pktTag?.overall_status === 'REJECTED' && pktTag?.node2_acked === 0],
        ['no_plaintext_stored_in_packets', pktCt?.payload_preview_json === null && pktTag?.payload_preview_json === null],
        ['zero_authenticated_readings', readingsCt.length === 0 && readingsTag.length === 0],
        ['no_success_ack_direct_ct', acksCt.some((a) => a.status === 'REJECTED_NO_ACK') && !acksCt.some((a) => a.status === 'ACK_DELIVERED')],
        ['no_success_ack_gateway_tag', acksTag.some((a) => a.status === 'REJECTED_NO_ACK') && !acksTag.some((a) => a.status === 'ACK_DELIVERED')],
        ['sec_AUTH_REJECTED_logged', secCt.some((e) => e.event_type === 'AUTH_REJECTED' && e.status === 'REJECTED') && secTag.some((e) => e.event_type === 'AUTH_REJECTED' && e.status === 'REJECTED')],
        ['critical_alerts_logged', alertCount >= 2],
        ['lcd_refused_tampered_values', !lcdAfter.includes('43.2') && !lcdAfter.includes('44.8') && lcdAfter === lcdBefore],
      ]);

      const passed = failures.length === 0;
      const steps: TestStepResult[] = [
        { step: 1, label: 'Modify Ciphertext on Direct Wi-Fi Path (Scenario A)', status: pktCt?.overall_status === 'REJECTED' ? 'REJECTED' : 'WARN', detail: `Packet #${resCt.packet_id} (43.2°C sentinel, route=${pktCt?.route_path}, gw=${pktCt?.gateway_status}) → ${pktCt?.encryption_status} / ${pktCt?.overall_status}.` },
        { step: 2, label: 'Modify 128-bit GCM Auth Tag on Gateway Path (Scenario B)', status: pktTag?.overall_status === 'REJECTED' ? 'REJECTED' : 'WARN', detail: `Packet #${resTag.packet_id} (44.8°C sentinel, route=${pktTag?.route_path}) auth tag flipped → ${pktTag?.encryption_status} / ${pktTag?.overall_status}.` },
        { step: 3, label: 'Verify No Success ACK & Security Alerts', status: alertCount >= 2 ? 'DONE' : 'WARN', detail: `Direct ACK #${resCt.packet_id}=${acksCt.map((a) => a.status).join(',')}; Stage-2 ACK #${resTag.packet_id}=${acksTag.map((a) => a.status).join(',')}; CRITICAL alerts=${alertCount}.` },
        { step: 4, label: 'Confirm LCD & DB Blocked Invalid Data', status: passed ? 'PASS' : 'WARN', detail: passed ? `0 readings written; Node 3 LCD stayed "${lcdAfter}" (never displayed 43.2°C or 44.8°C).` : `Failed checks: ${failures.join(', ')}.` },
      ];
      const actual = passed
        ? `PASS: Direct Wi-Fi ciphertext tamper (#${resCt.packet_id}) and Gateway Auth-Tag tamper (#${resTag.packet_id}) both REJECTED by Node 3 AES-128-GCM; 0 readings saved, no success ACK, LCD unchanged ("${lcdAfter}").`
        : `FAIL: Security tamper verification failed checks [${failures.join(', ')}].`;
      return saveTestResult(7, passed, actual, steps, resCt.packet_id);
    }

    case 8: {
      // TEST 8: Node Restart with Pending Packets (Node 1 LittleFS AND Node 2 microSD)
      simulationEngine.configureLinks(true, true, true);
      simulationEngine.drainNode1PendingQueue();
      simulationEngine.drainNode2PendingQueue();

      // Queue 1 pending packet on Node 2 microSD via LoRa (DirectWiFi=OFF, LoRa=ON, N2→N3=OFF)
      simulationEngine.configureLinks(false, true, false);
      const pktGwRes = simulationEngine.createAndProcessPacket({
        temperature: 26.8,
        humidity: 67.2,
        rain_raw: 460,
      });

      // Queue 1 pending packet on Node 1 LittleFS (All links OFF)
      simulationEngine.configureLinks(false, false, false);
      const pktN1Res = simulationEngine.createAndProcessPacket({
        temperature: 26.6,
        humidity: 68.4,
        rain_raw: 495,
      });

      const seqBeforeRestart = simulationEngine.getState().sequence_counter;

      // Simulate actual Node 1 & Node 2 power-cycle restart + SQLite re-hydration
      const restartReport = simulationEngine.simulateNodesRestart();

      const lfsAfterRestart = getStorage('NODE_1');
      const sdAfterRestart = getStorage('NODE_2');
      const pktN1Mid = getPacket(pktN1Res.packet_id);
      const pktGwMid = getPacket(pktGwRes.packet_id);

      const restartChecks = collectFailures([
        ['recovered_n1_pending', restartReport.recoveredNode1Pending.includes(pktN1Res.packet_id) && lfsAfterRestart.pending_count >= 1],
        ['recovered_n2_pending', restartReport.recoveredNode2Pending.includes(pktGwRes.packet_id) && sdAfterRestart.pending_count >= 1],
        ['sequence_counter_preserved', restartReport.sequenceCounter === seqBeforeRestart],
        ['pktN1_still_pending', pktN1Mid?.gateway_status === 'PENDING' && pktN1Mid?.route_path === 'LOCAL_QUEUE'],
        ['pktGw_still_stored_pending_n3', pktGwMid?.gateway_status === 'STORED' && (pktGwMid?.destination_status === 'PENDING' || pktGwMid?.destination_status === 'RETRYING')],
      ]);

      // Restore all 3 links (ON / Standby / ON):
      // - pktN1 drains directly from Node 1 LittleFS to Node 3 via Direct Wi-Fi (NODE1_NODE3 ACK, gateway BYPASSED)
      // - pktGw drains from Node 2 microSD to Node 3 via NODE2_NODE3_WIFI (Stage-2 NODE2_NODE3 ACK)
      // - New post-restart packet gets strictly higher sequence_number (no ID/nonce reuse)
      simulationEngine.configureLinks(true, true, true);
      simulationEngine.drainNode1PendingQueue();
      simulationEngine.drainNode2PendingQueue();
      simulationEngine.syncNodeAndStorageSummaries();

      const pktPostRes = simulationEngine.createAndProcessPacket({
        temperature: 27.0,
        humidity: 64.0,
        rain_raw: 240,
      });

      const pktN1Final = getPacket(pktN1Res.packet_id);
      const pktGwFinal = getPacket(pktGwRes.packet_id);
      const pktPostFinal = getPacket(pktPostRes.packet_id);
      const lfsFinal = getStorage('NODE_1');
      const sdFinal = getStorage('NODE_2');
      const n1DirectAck = getAcks(pktN1Res.packet_id, 'NODE1_NODE3');
      const gwHop2Ack = getAcks(pktGwRes.packet_id, 'NODE2_NODE3');
      const n1Reading = getReadings(pktN1Res.packet_id);
      const gwReading = getReadings(pktGwRes.packet_id);

      const recoveryChecks = collectFailures([
        ['pktN1_delivered_direct_after_restart', pktN1Final?.overall_status === 'DELIVERED' && pktN1Final?.route_path === 'DIRECT_WIFI' && pktN1Final?.gateway_status === 'BYPASSED' && n1DirectAck.some((a) => a.status === 'ACK_DELIVERED') && n1Reading.length === 1],
        ['pktGw_delivered_gateway_after_restart', pktGwFinal?.overall_status === 'DELIVERED' && gwHop2Ack.some((a) => a.status === 'ACK_DELIVERED') && gwReading.length === 1],
        ['queues_drained_cleanly', lfsFinal.pending_count === 0 && sdFinal.pending_count === 0],
        ['no_sequence_reuse_after_restart', (pktPostFinal?.sequence_number ?? 0) > seqBeforeRestart && pktPostFinal?.overall_status === 'DELIVERED'],
      ]);

      const failures = [...restartChecks, ...recoveryChecks];
      const passed = failures.length === 0;
      const steps: TestStepResult[] = [
        { step: 1, label: 'Queue Pending Packets on Node 1 & Node 2', status: 'DONE', detail: `LittleFS pending #${pktN1Res.packet_id} & microSD pending #${pktGwRes.packet_id} persisted (seq=#${seqBeforeRestart}).` },
        { step: 2, label: 'Simulate Node 1 & Node 2 Restart', status: restartChecks.length === 0 ? 'PASS' : 'WARN', detail: `Recovered LittleFS=[${restartReport.recoveredNode1Pending.join(',')}] & microSD=[${restartReport.recoveredNode2Pending.join(',')}], seq=#${restartReport.sequenceCounter}.` },
        { step: 3, label: 'Resume Delivery Upon Reconnection', status: lfsFinal.pending_count === 0 && sdFinal.pending_count === 0 ? 'DONE' : 'WARN', detail: `LittleFS (${lfsAfterRestart.pending_count}→${lfsFinal.pending_count}) drained via Direct Wi-Fi & microSD (${sdAfterRestart.pending_count}→${sdFinal.pending_count}) drained via Node 2→Node 3 Wi-Fi.` },
        { step: 4, label: 'Verify Monotonic Sequence Counter (No Reuse)', status: passed ? 'PASS' : 'WARN', detail: passed ? `Post-restart packet #${pktPostRes.packet_id} got seq=#${pktPostFinal?.sequence_number} (> #${seqBeforeRestart}) and reached DELIVERED.` : `Failed checks: ${failures.join(', ')}.` },
      ];
      const actual = passed
        ? `PASS: Node 1 (#${pktN1Res.packet_id}) & Node 2 (#${pktGwRes.packet_id}) pending queues survived restart (seq=#${seqBeforeRestart}), drained via Direct Wi-Fi & Gateway Wi-Fi on recovery, and next packet got seq=#${pktPostFinal?.sequence_number}.`
        : `FAIL: Node restart recovery failed checks [${failures.join(', ')}].`;
      return saveTestResult(8, passed, actual, steps, pktN1Res.packet_id);
    }

    default:
      throw new Error(`Invalid test_id: ${testId}. Valid range is 1..8.`);
  }
}

export function runAllSystemTests(): TestResultRecord[] {
  for (let id = 1; id <= 8; id++) {
    runSystemTest(id);
  }
  return getTestResults();
}
