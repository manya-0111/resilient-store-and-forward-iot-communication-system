import type {
  OperatingMode,
  SystemStatusResponse,
  NodeRecord,
  SensorReading,
  PacketRecord,
  PacketDetailResponse,
  QueuesResponse,
  NetworkMetric,
  CommEvent,
  AckRecord,
  StorageRecord,
  SecurityEvent,
  AlertRecord,
  TestResultRecord,
  MLNetworkResponse,
  MLFeaturesResponse,
  HistoryMLPredictionItem,
  HistoryResponse,
  CsvImportBatch,
  CsvUploadResponse,
  DataSource,
  MLDataSource,
  SystemSettings,
  SimulationState,
  LinkHopId,
  CommunicationResponse,
} from '../types/iot';

const API_BASE = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL || '').replace(/\/+$/, '');

function withBase(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withBase(url), {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  });
  if (!res.ok) {
    let errText = `HTTP ${res.status}`;
    try {
      const json = await res.json();
      errText = json.error || errText;
    } catch {
      // ignore non-json error body
    }
    throw new Error(errText);
  }
  return res.json() as Promise<T>;
}

export const iotApi = {
  getHealth: () =>
    request<{
      status: string;
      database: string;
      database_file: string;
      active_mode: OperatingMode;
      ml_network_status: string;
      ml_network_quality_status: string;
      ml_scheduling_status: string;
      security_algorithm: string;
      timestamp: string;
    }>('/api/health'),

  getStatus: (mode?: OperatingMode) =>
    request<SystemStatusResponse>(`/api/status${mode ? `?mode=${mode}` : ''}`),

  getSensorsHistory: (mode: OperatingMode, limit = 80) =>
    request<{ mode: OperatingMode; readings: SensorReading[] }>(
      `/api/sensors/history?mode=${mode}&limit=${limit}`
    ),

  getCommunication: (mode: OperatingMode, limit = 60, linkHop?: LinkHopId) => {
    const q = new URLSearchParams({ mode, limit: String(limit) });
    if (linkHop) q.set('link_hop', linkHop);
    return request<CommunicationResponse>(`/api/communication?${q.toString()}`);
  },

  getPackets: (params: {
    mode: OperatingMode;
    view?: string;
    status?: string;
    priority?: string;
    comm_mode?: string;
    route_path?: string;
    search?: string;
  }) => {
    const q = new URLSearchParams({ mode: params.mode });
    if (params.view) q.set('view', params.view);
    if (params.status && params.status !== 'ALL') q.set('status', params.status);
    if (params.priority && params.priority !== 'ALL') q.set('priority', params.priority);
    if (params.comm_mode && params.comm_mode !== 'ALL') q.set('comm_mode', params.comm_mode);
    if (params.route_path && params.route_path !== 'ALL') q.set('route_path', params.route_path);
    if (params.search) q.set('search', params.search);
    return request<{ mode: OperatingMode; packets: PacketRecord[] }>(`/api/packets?${q.toString()}`);
  },

  getNodes: (mode: OperatingMode) =>
    request<{ mode: OperatingMode; nodes: NodeRecord[] }>(`/api/nodes?mode=${mode}`),

  getPacketDetail: (mode: OperatingMode, packetId: number) =>
    request<PacketDetailResponse>(`/api/packets/${packetId}?mode=${mode}`),

  getQueues: (mode: OperatingMode) =>
    request<QueuesResponse>(`/api/queues?mode=${mode}`),

  getStorage: (mode: OperatingMode) =>
    request<{
      mode: OperatingMode;
      storage: StorageRecord[];
      node1_pending_packets: Array<{ packet_id: number; priority: number; created_at: string }>;
      node2_pending_node3_packets: Array<{ packet_id: number; priority: number; created_at: string }>;
    }>(`/api/storage?mode=${mode}`),

  getSecurity: (mode: OperatingMode) =>
    request<{
      mode: OperatingMode;
      metadata: {
        algorithm: string;
        nonce_bits: number;
        tag_bits: number;
        key_version: string;
        key_source: string;
        encryption_endpoint: string;
        gateway_behavior: string;
        decryption_endpoint: string;
        unique_nonces_tracked: number;
      };
      metrics: {
        encrypted_packet_count: number;
        auth_success_count: number;
        auth_failed_count: number;
        rejected_packet_count: number;
        unique_nonce_verified: boolean;
        unique_nonces_count: number;
      };
      events: SecurityEvent[];
    }>(`/api/security?mode=${mode}`),

  getMLNetwork: (mode: OperatingMode, limit = 60, dataSource?: MLDataSource) => {
    const q = new URLSearchParams({ mode, limit: String(limit) });
    if (dataSource) q.set('data_source', dataSource);
    return request<MLNetworkResponse>(`/api/ml/network?${q.toString()}`);
  },

  getMLFeatures: (mode: OperatingMode, limit = 60, dataSource?: MLDataSource) => {
    const q = new URLSearchParams({ mode, limit: String(limit) });
    if (dataSource) q.set('data_source', dataSource);
    return request<MLFeaturesResponse>(`/api/ml/features?${q.toString()}`);
  },

  getHistory: (mode: OperatingMode, from?: string, to?: string, dataSource?: DataSource) => {
    const q = new URLSearchParams({ mode });
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (dataSource) q.set('data_source', dataSource);
    return request<HistoryResponse>(`/api/history?${q.toString()}`);
  },

  uploadHardwareCsv: (payload: {
    filename: string;
    csv_text: string;
    default_link_hop: LinkHopId;
  }) =>
    request<CsvUploadResponse>('/api/csv/upload', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getCsvImports: (limit = 30) =>
    request<{ imports: CsvImportBatch[] }>(`/api/csv/imports?limit=${limit}`),

  getAlerts: (mode: OperatingMode) =>
    request<{ mode: OperatingMode; alerts: AlertRecord[] }>(`/api/alerts?mode=${mode}`),

  markAlertsRead: (mode: OperatingMode, id?: number) =>
    request<{ ok: boolean }>('/api/alerts/read', {
      method: 'POST',
      body: JSON.stringify({ mode, id }),
    }),

  getTests: () =>
    request<{
      tests: TestResultRecord[];
      summary: { total: number; passed: number; failed: number; not_run: number };
    }>('/api/tests'),

  runTest: (testId?: number) =>
    request<{
      ok: boolean;
      result?: TestResultRecord;
      tests: TestResultRecord[];
      summary: { total: number; passed: number; failed: number; not_run: number };
    }>('/api/tests/run', {
      method: 'POST',
      body: JSON.stringify(testId ? { test_id: testId } : { all: true }),
    }),

  resetTests: () =>
    request<{
      ok: boolean;
      tests: TestResultRecord[];
      summary: { total: number; passed: number; failed: number; not_run: number };
    }>('/api/tests/reset', { method: 'POST' }),

  simStart: () =>
    request<{ ok: boolean; simulation: SimulationState }>('/api/simulation/start', { method: 'POST' }),

  simPause: () =>
    request<{ ok: boolean; simulation: SimulationState }>('/api/simulation/pause', { method: 'POST' }),

  simResume: () =>
    request<{ ok: boolean; simulation: SimulationState }>('/api/simulation/resume', { method: 'POST' }),

  simReset: () =>
    request<{ ok: boolean; simulation: SimulationState }>('/api/simulation/reset', { method: 'POST' }),

  simControl: (action: string, payload?: Record<string, unknown>) =>
    request<{ ok: boolean; action: string; message: string; state: SimulationState; packet_id?: number }>(
      '/api/simulation/control',
      {
        method: 'POST',
        body: JSON.stringify({ action, ...(payload || {}) }),
      }
    ),

  getSettings: () =>
    request<{
      settings: SystemSettings;
      security: Record<string, unknown>;
      hardware_ack_note: string;
    }>('/api/settings'),

  updateSettings: (updates: Partial<SystemSettings>) =>
    request<{ ok: boolean; settings: SystemSettings }>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(updates),
    }),

  csvExportUrl: (
    mode: OperatingMode,
    type: 'sensors' | 'network' | 'packets' | 'security',
    linkHop?: LinkHopId,
    dataSource?: DataSource
  ) => {
    const q = new URLSearchParams({ mode, type });
    if (type === 'network' && linkHop) {
      q.set('link_hop', linkHop);
    }
    if (dataSource && (type === 'sensors' || type === 'network')) {
      q.set('data_source', dataSource);
    }
    return withBase(`/api/export/csv?${q.toString()}`);
  },
};
