export type OperatingMode = 'simulation' | 'hardware';

export type NavSectionId =
  | 'overview'
  | 'sensors'
  | 'nodes'
  | 'communication'
  | 'packets'
  | 'storage'
  | 'security'
  | 'ml'
  | 'history'
  | 'testing'
  | 'hardware'
  | 'settings';

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

export interface NodeRecord {
  id: number;
  node_id: string;
  mode: OperatingMode;
  name: string;
  role: string;
  status: string;
  link_mode: string;
  rssi: number | null;
  queue_count: number;
  storage_status: string;
  lcd_status: string | null;
  last_heartbeat: string | null;
  metadata: Record<string, unknown>;
  updated_at: string;
}

export interface SensorReading {
  id: number;
  mode: OperatingMode;
  packet_id: number | null;
  node_id: string;
  temperature: number;
  humidity: number;
  rain_raw: number;
  rain_category: 'DRY' | 'NORMAL' | 'HEAVY';
  priority: number;
  authenticated: number;
  is_anomaly: number;
  anomaly_score: number;
  data_source?: DataSource | string;
  recorded_at: string;
}

export type LinkHopId =
  | 'NODE1_NODE3_WIFI'
  | 'NODE1_NODE2_LORA'
  | 'NODE2_NODE3_WIFI'
  | 'LEGACY_UNCLASSIFIED';

export type RoutePath =
  | 'DIRECT_WIFI'
  | 'LORA_GATEWAY'
  | 'LOCAL_QUEUE'
  | 'LEGACY_TWO_HOP'
  | 'LEGACY_UNCLASSIFIED';

export type RssiSource =
  | 'AP_STATION_RSSI'
  | 'PEER_TO_PEER_RSSI'
  | 'LORA_PKT_RSSI'
  | 'SIMULATED_LINK_RSSI'
  | 'UNSPECIFIED';

export type DataSource = 'SIMULATED' | 'ESP32_HARDWARE' | 'CSV_IMPORT' | 'LEGACY_UNCLASSIFIED';

export interface PacketRecord {
  id: number;
  mode: OperatingMode;
  packet_id: number;
  sequence_number: number;
  protocol_version: number;
  source_node: number;
  destination_node: number;
  priority: number;
  comm_mode: string;
  route_path?: RoutePath | string;
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
  node1_acked?: number;
  node2_acked?: number;
  payload_preview_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface NetworkMetric {
  id: number;
  mode: OperatingMode;
  link_hop?: LinkHopId | string;
  rssi: number;
  rssi_variation: number;
  rssi_source?: RssiSource | string;
  packet_loss_ratio: number;
  ack_latency_ms: number;
  retry_count: number;
  queue_depth: number;
  link_mode: string;
  node2_to_node3_status: string;
  data_source?: DataSource | string;
  recorded_at: string;
}

export interface CommEvent {
  id: number;
  mode: OperatingMode;
  event_type: string;
  link_hop: string;
  comm_mode: string;
  packet_id: number | null;
  details: string;
  rssi: number | null;
  latency_ms: number | null;
  created_at: string;
}

export interface AckRecord {
  id: number;
  mode: OperatingMode;
  packet_id: number;
  link_hop: string;
  sender_node: number;
  receiver_node: number;
  status: string;
  error_code: string | null;
  latency_ms: number;
  authenticated_ack: number;
  created_at: string;
}

export interface StorageRecord {
  id: number;
  mode: OperatingMode;
  node_id: string;
  storage_type: string;
  status: string;
  capacity_gb: number | null;
  pending_count: number;
  stored_count: number;
  sequence_counter: number;
  storage_errors: number;
  files: string[];
  updated_at: string;
}

export interface SecurityEvent {
  id: number;
  mode: OperatingMode;
  packet_id: number | null;
  event_type: string;
  endpoint: string;
  status: string;
  nonce_hex: string | null;
  key_version: string;
  details: string;
  created_at: string;
}

export interface AlertRecord {
  id: number;
  mode: OperatingMode;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  category: string;
  message: string;
  related_node: string;
  is_read: number;
  created_at: string;
}

export interface SimulationState {
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
  sequence_counter: number;
  last_temp: number;
  last_humidity: number;
  last_rain_raw: number;
  updated_at: string;
}

export interface LinkStatusEntry {
  link_hop: LinkHopId;
  label: string;
  active: boolean;
  status: string;
  queue_depth?: number;
  latest_metric: NetworkMetric | null;
}

export interface MeasurementSpec {
  target_ml_link: string;
  links: LinkHopId[];
  rssi_policy: Record<string, string>;
  rssi_variation_definition: string;
  packet_loss_window_attempts: number;
  packet_loss_formula: string;
  ack_timeout_ms: number;
  retry_limit: number;
  retry_counting_rule: string;
  matching_ack_latency_rule: string;
  queue_depth_definition: string;
}

export interface CommunicationResponse {
  mode: OperatingMode;
  active_link_filter?: LinkHopId | string;
  metrics: NetworkMetric[];
  metrics_by_link?: Record<LinkHopId, NetworkMetric[]>;
  measurement_spec?: MeasurementSpec;
  events: CommEvent[];
  acknowledgements: AckRecord[];
}

export interface SystemStatusResponse {
  mode: OperatingMode;
  is_demo_mode: boolean;
  timestamp: string;
  overall_status: string;
  active_comm_mode: string;
  node2_to_node3_status: string;
  links?: {
    node1_node3_wifi: LinkStatusEntry;
    node1_node2_lora: LinkStatusEntry;
    node2_node3_wifi: LinkStatusEntry;
  };
  summary: {
    total_created: number;
    received_by_node2: number;
    delivered_to_node3: number;
    delivered_direct_wifi?: number;
    delivered_via_gateway?: number;
    pending_packets: number;
    pending_node1_littlefs: number;
    pending_node2_microsd: number;
    duplicate_packets: number;
    failed_auth_count: number;
    unread_alerts: number;
  };
  nodes: NodeRecord[];
  latest_sensor: SensorReading | null;
  previous_sensor: SensorReading | null;
  latest_metric: NetworkMetric | null;
  simulation: SimulationState | null;
  settings: SystemSettings;
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
  initial_config: {
    node1_wifi: string;
    node1_lora: string;
    node2_node3_wifi: string;
  };
  status: string;
  passed: boolean | null;
  expected_result: string;
  actual_result: string | null;
  steps: TestStepResult[];
  packet_id: number | null;
  executed_at: string | null;
}

export type NetworkQualityClass = 'GOOD' | 'MODERATE' | 'POOR';
export type MLDataSource = 'SIMULATED' | 'ESP32_HARDWARE' | 'CSV_IMPORT';
export type ClassificationStatus = 'READY' | 'UNAVAILABLE' | 'STALE' | 'INSUFFICIENT_DATA';
export type SchedulingStatus = 'READY' | 'UNAVAILABLE' | 'STALE' | 'INSUFFICIENT_DATA' | 'CENSORED';
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
  wifi_availability_history: number;
  connection_duration: number;
  hour: number;
  day_of_week: number;
}

export interface ClassificationPredictionRecord {
  id: number;
  mode: OperatingMode;
  link_hop: 'NODE2_NODE3_WIFI';
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
  link_hop: 'NODE2_NODE3_WIFI';
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
  link_hop: 'NODE2_NODE3_WIFI';
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
  link_hop: 'NODE2_NODE3_WIFI';
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
  link_hop: 'NODE2_NODE3_WIFI';
  status: 'AVAILABLE' | 'OFFLINE' | 'DEGRADED';
  model_version: string;
  last_heartbeat_at: string;
  service_name?: string;
  note?: string;
}

export interface MLNetworkResponse {
  mode: OperatingMode;
  data_source: MLDataSource;
  target_link: 'NODE2_NODE3_WIFI';
  enabled: boolean;
  advisory_notice: string;
  latest_features: NetworkMetric | null;
  classification_features: ClassificationFeatures | null;
  scheduling_features: SchedulingFeatures | null;
  scheduling_context: {
    current_link_state: string | null;
    availability_window_samples: number;
    day_of_week_convention: string;
    timezone: string;
  };
  sample_count: number;
  raw_sample_count?: number;
  source_counts?: Record<MLDataSource, { total: number; ml_ready: number }>;
  classification: {
    model_type: 'NETWORK_QUALITY';
    link_hop: 'NODE2_NODE3_WIFI';
    availability: ModelAvailabilityState;
    is_stale: boolean;
    stale_reason: string | null;
    insufficient_data: boolean;
    age_seconds: number | null;
    model_version: string | null;
    prediction_timestamp: string | null;
    data_source: MLDataSource;
    latest_prediction: ClassificationPredictionRecord | null;
    history: ClassificationPredictionRecord[];
    evaluation: ClassificationEvaluationMetrics | null;
    heartbeat: ExternalModelHeartbeat | null;
  };
  scheduling: {
    model_type: 'TRANSMISSION_SCHEDULING';
    link_hop: 'NODE2_NODE3_WIFI';
    advisory_only: true;
    availability: ModelAvailabilityState;
    is_stale: boolean;
    stale_reason: string | null;
    insufficient_data: boolean;
    censored: boolean;
    age_seconds: number | null;
    model_version: string | null;
    prediction_timestamp: string | null;
    data_source: MLDataSource;
    latest_prediction: SchedulingPredictionRecord | null;
    history: SchedulingPredictionRecord[];
    actual_vs_predicted: Array<{
      id: number;
      timestamp: string;
      predicted_wait_seconds: number;
      actual_wait_seconds: number;
      error_seconds: number;
      model_version: string;
    }>;
    evaluation: SchedulingEvaluationMetrics | null;
    heartbeat: ExternalModelHeartbeat | null;
  };
}

export interface MLFeaturesResponse {
  mode: OperatingMode;
  data_source: MLDataSource;
  link_hop: 'NODE2_NODE3_WIFI';
  sample_count: number;
  raw_sample_count?: number;
  source_counts?: Record<MLDataSource, { total: number; ml_ready: number }>;
  sufficient_for_classification: boolean;
  sufficient_for_scheduling: boolean;
  min_scheduling_samples: number;
  latest_metric: NetworkMetric | null;
  classification_features: ClassificationFeatures | null;
  scheduling_features: SchedulingFeatures | null;
  scheduling_context: {
    current_link_state: string | null;
    availability_window_samples: number;
    day_of_week_convention: string;
    timezone: string;
  };
  recent_metrics: NetworkMetric[];
}

export interface HistoryMLPredictionItem {
  id: number;
  mode: OperatingMode;
  link_hop: 'NODE2_NODE3_WIFI';
  model_type: 'NETWORK_QUALITY' | 'TRANSMISSION_SCHEDULING';
  predicted_class: string;
  confidence: number;
  predicted_wait_seconds: number | null;
  actual_wait_seconds: number | null;
  observation_censored: number;
  model_version: string | null;
  data_source: string | null;
  prediction_timestamp: string | null;
  model_status: string;
  created_at: string;
}

export interface PacketDetailResponse {
  mode: OperatingMode;
  packet: PacketRecord;
  acknowledgements: AckRecord[];
  security_events: SecurityEvent[];
  communication_events: CommEvent[];
  authenticated_reading: SensorReading | null;
}

export interface CsvImportBatch {
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

export interface CsvUploadResponse {
  ok: boolean;
  batch: CsvImportBatch;
  ml_inference: {
    triggered: boolean;
    classification_status: string;
    scheduling_status: string;
    note: string;
  };
}

export interface HistoryResponse {
  mode: OperatingMode;
  active_data_source: DataSource;
  sensors: SensorReading[];
  metrics: NetworkMetric[];
  packets: PacketRecord[];
  security_events: SecurityEvent[];
  ml_predictions: HistoryMLPredictionItem[];
  communication_events: CommEvent[];
  provenance_counts?: {
    network_metrics: Record<DataSource, number>;
    sensor_readings: Record<DataSource, number>;
  };
  csv_imports?: CsvImportBatch[];
}

export interface QueuesResponse {
  mode: OperatingMode;
  queues: {
    node1_pending: PacketRecord[];
    node2_received: PacketRecord[];
    node2_pending_node3: PacketRecord[];
    node3_delivered: PacketRecord[];
  };
  counts: {
    node1_pending: number;
    node2_received: number;
    node2_pending_node3: number;
    node3_delivered: number;
  };
}

