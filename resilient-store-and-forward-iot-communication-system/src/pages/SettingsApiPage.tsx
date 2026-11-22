import React, { useEffect, useState } from 'react';
import { iotApi } from '../services/api';
import type { OperatingMode, SystemSettings } from '../types/iot';

interface Props {
  settings: SystemSettings;
  onSettingsUpdated: () => void;
}

const API_CATALOG = [
  ['GET', '/api/health', 'Backend, SQLite WAL, ML & Security status'],
  ['GET', '/api/status', 'Unified dashboard KPIs, nodes, sensors & link modes'],
  ['GET', '/api/nodes', 'Per-node status and heartbeat health'],
  ['GET', '/api/sensors/latest', 'Latest authenticated Node 3 environmental reading'],
  ['GET', '/api/sensors/history', 'Time-series sensor readings from SQLite'],
  ['POST', '/api/node1/sensor-data', 'Node 1 heartbeat, RSSI, retry & LittleFS telemetry'],
  ['POST', '/api/node1/packet', 'Node 1 encrypted AES-128-GCM packet envelope'],
  ['POST', '/api/node1/ack', 'Node 1 Hop-1 ACK confirmation event'],
  ['POST', '/api/node2/packet-received', 'Node 2 microSD durable storage & duplicate check'],
  ['POST', '/api/node2/network-metrics', 'Node 2 → Node 3 Wi-Fi RF metrics ingestion (NODE2_NODE3_WIFI)'],
  ['POST', '/api/node2/storage-status', 'Node 2 16 GB microSD capacity & error reporting'],
  ['POST', '/api/node2/forward', 'Node 2 → Node 3 forwarding attempt status'],
  ['POST', '/api/node3/packet-received', 'Node 3 authenticated/decrypted reading ingestion'],
  ['POST', '/api/node3/authentication', 'Node 3 AES-GCM verification success/rejection log'],
  ['POST', '/api/node3/ack', 'Node 3 Hop-2 delivery ACK'],
  ['GET', '/api/packets', 'Searchable & filterable packet ledger'],
  ['GET', '/api/packets/pending', 'Node 1 LittleFS & Node 2 microSD pending queues'],
  ['GET', '/api/packets/:packetId', 'Per-packet envelope, hop ACKs, security events & auth reading'],
  ['GET', '/api/queues', 'All 4 logical store-and-forward queues'],
  ['GET', '/api/storage', 'LittleFS and 16 GB microSD filesystem states'],
  ['GET', '/api/security', 'AES-128-GCM counters, nonce uniqueness & events'],
  ['GET', '/api/ml/network', 'Network Quality & Scheduling ML predictions and evaluations (NODE2_NODE3_WIFI)'],
  ['GET', '/api/ml/features', 'Live 6 & 10 feature vectors extracted strictly from NODE2_NODE3_WIFI'],
  ['POST', '/api/ml/network/classification', 'Ingest external Python Random Forest Classifier prediction'],
  ['POST', '/api/ml/network/scheduling', 'Ingest external Python Random Forest Regressor scheduling prediction'],
  ['POST', '/api/ml/network/evaluation', 'Ingest confusion matrix or MAE/RMSE evaluation metrics'],
  ['POST', '/api/ml/network/status', 'Update external Python ML service availability heartbeat'],
  ['GET', '/api/history', 'Date-filtered SQLite historical analytics'],
  ['GET', '/api/alerts', 'System alerts & read/unread status'],
  ['GET / POST', '/api/tests · /api/tests/run', 'All 8 PDF Page 12 state-changing test cases'],
  ['POST', '/api/simulation/*', 'Start, pause, resume, reset & fault injection controls'],
  ['GET', '/api/export/csv', 'CSV download for sensors, network, packets, security'],
];

export const SettingsApiPage: React.FC<Props> = ({ settings, onSettingsUpdated }) => {
  const [health, setHealth] = useState<{
    status: string;
    database: string;
    database_file: string;
    active_mode: OperatingMode;
    ml_network_status: string;
    ml_network_quality_status: string;
    ml_scheduling_status: string;
    security_algorithm: string;
    timestamp: string;
  } | null>(null);

  const [form, setForm] = useState<SystemSettings>(settings);
  const [dirty, setDirty] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthLatencyMs, setHealthLatencyMs] = useState<number | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);

  const settingsKey = JSON.stringify(settings);

  useEffect(() => {
    if (!dirty) {
      setForm(settings);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);

  const checkHealth = async () => {
    setCheckingHealth(true);
    const started = performance.now();
    try {
      const res = await iotApi.getHealth();
      setHealth(res);
      setHealthLatencyMs(Math.round(performance.now() - started));
      setHealthError(null);
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : 'Unable to reach /api/health.');
    } finally {
      setCheckingHealth(false);
    }
  };

  useEffect(() => {
    checkHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.active_mode]);

  const updateForm = (patch: Partial<SystemSettings>) => {
    setDirty(true);
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.rain_heavy_threshold <= form.rain_normal_threshold) {
      setSavedMsg('Error: Heavy rain threshold must be greater than Normal rain threshold.');
      return;
    }
    setSaving(true);
    try {
      await iotApi.updateSettings(form);
      setDirty(false);
      setSavedMsg(
        'Settings saved to SQLite. Note: physical ESP32 nodes apply changes only after firmware acknowledges sync.'
      );
      onSettingsUpdated();
      checkHealth();
    } catch (err) {
      setSavedMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {healthError && (
        <div className="bg-rose-950/50 border border-rose-700/60 rounded-xl px-4 py-3 flex items-center justify-between gap-4 text-xs">
          <span className="font-mono text-rose-300">Health Check Error: {healthError}</span>
          <button
            type="button"
            onClick={checkHealth}
            className="px-3 py-1 rounded-md bg-rose-700 hover:bg-rose-600 text-white font-medium whitespace-nowrap cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Backend & Database Health */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-mono">
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="text-slate-400 font-sans">Backend API Health</div>
            <div className={`text-lg font-semibold mt-1 ${healthError ? 'text-rose-400' : 'text-emerald-400'}`}>
              {healthError ? 'UNREACHABLE' : health?.status || 'CHECKING...'}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
              {healthLatencyMs !== null ? `RTT ${healthLatencyMs} ms · REST /api/*` : 'REST /api/* active'}
            </div>
          </div>
          <button
            type="button"
            disabled={checkingHealth}
            onClick={checkHealth}
            className="mt-3 px-2.5 py-1 text-[11px] font-sans font-medium rounded bg-[#0B1324] hover:bg-slate-800 border border-[#2A3F63] text-sky-300 transition-colors cursor-pointer disabled:opacity-50 w-fit"
          >
            {checkingHealth ? 'Checking...' : 'Test API Health'}
          </button>
        </div>
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-slate-400 font-sans">SQLite Persistence</div>
          <div className="text-lg text-sky-400 font-semibold mt-1">{health?.database || 'CHECKING...'}</div>
          <div className="text-[11px] text-slate-500 mt-1 truncate">{health?.database_file || 'resilient_iot.db'}</div>
        </div>
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-slate-400 font-sans">Network ML (NODE2_NODE3_WIFI)</div>
          <div className="text-xs text-amber-300 font-semibold mt-1.5">
            {form.ml_network_enabled
              ? `Clf: ${health?.ml_network_quality_status || 'CHECKING'} · Sch: ${health?.ml_scheduling_status || 'CHECKING'}`
              : 'ML DISABLED'}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">External Python RF models · Advisory only</div>
        </div>
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-slate-400 font-sans">Security Provisioning</div>
          <div className="text-lg text-emerald-400 font-semibold mt-1">{health?.security_algorithm || 'AES-128-GCM'}</div>
          <div className="text-[11px] text-slate-500 mt-1">Secret keys strictly server-side</div>
        </div>
      </div>

      {/* Operating Mode & Threshold Configuration Form */}
      <form onSubmit={handleSubmit} className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-6 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-[#1E2E4A]">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Operating Mode & Protocol Thresholds</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Simulation Mode and Live Hardware Mode maintain strictly separated SQLite records and never mix.
            </p>
          </div>
          <div className="flex items-center gap-1 p-1 bg-[#0B1324] border border-[#1E2E4A] rounded-lg">
            {(['simulation', 'hardware'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => updateForm({ active_mode: m })}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  form.active_mode === m ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {m === 'simulation' ? 'Simulation (DEMO MODE)' : 'Live Hardware Mode'}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
          <label className="block text-slate-300">
            ACK Timeout (ms)
            <input
              type="number"
              min={300}
              max={15000}
              value={form.ack_timeout_ms}
              onChange={(e) => updateForm({ ack_timeout_ms: Number(e.target.value) })}
              className="mt-1.5 w-full px-3 py-2 rounded-md bg-[#0B1324] border border-[#2A3F63] font-mono text-slate-100"
            />
          </label>

          <label className="block text-slate-300">
            Max Retry Limit
            <input
              type="number"
              min={1}
              max={10}
              value={form.retry_limit}
              onChange={(e) => updateForm({ retry_limit: Number(e.target.value) })}
              className="mt-1.5 w-full px-3 py-2 rounded-md bg-[#0B1324] border border-[#2A3F63] font-mono text-slate-100"
            />
          </label>

          <label className="block text-slate-300">
            Hysteresis Good Samples (→ Wi-Fi)
            <input
              type="number"
              min={1}
              max={10}
              value={form.hysteresis_good_samples}
              onChange={(e) => updateForm({ hysteresis_good_samples: Number(e.target.value) })}
              className="mt-1.5 w-full px-3 py-2 rounded-md bg-[#0B1324] border border-[#2A3F63] font-mono text-slate-100"
            />
          </label>

          <label className="block text-slate-300">
            Hysteresis Bad Samples (→ LoRa)
            <input
              type="number"
              min={1}
              max={10}
              value={form.hysteresis_bad_samples}
              onChange={(e) => updateForm({ hysteresis_bad_samples: Number(e.target.value) })}
              className="mt-1.5 w-full px-3 py-2 rounded-md bg-[#0B1324] border border-[#2A3F63] font-mono text-slate-100"
            />
          </label>

          <label className="block text-slate-300">
            Poor Wi-Fi RSSI Threshold (dBm)
            <input
              type="number"
              min={-105}
              max={-45}
              value={form.wifi_rssi_poor_threshold}
              onChange={(e) => updateForm({ wifi_rssi_poor_threshold: Number(e.target.value) })}
              className="mt-1.5 w-full px-3 py-2 rounded-md bg-[#0B1324] border border-[#2A3F63] font-mono text-slate-100"
            />
          </label>

          <label className="block text-slate-300">
            Poor Wi-Fi Loss Threshold (0.05–0.90)
            <input
              type="number"
              step={0.05}
              min={0.05}
              max={0.9}
              value={form.wifi_loss_poor_threshold}
              onChange={(e) => updateForm({ wifi_loss_poor_threshold: Number(e.target.value) })}
              className="mt-1.5 w-full px-3 py-2 rounded-md bg-[#0B1324] border border-[#2A3F63] font-mono text-slate-100"
            />
          </label>

          <label className="block text-slate-300">
            Poor Wi-Fi Latency Threshold (ms)
            <input
              type="number"
              min={50}
              max={5000}
              step={10}
              value={form.wifi_latency_poor_threshold}
              onChange={(e) => updateForm({ wifi_latency_poor_threshold: Number(e.target.value) })}
              className="mt-1.5 w-full px-3 py-2 rounded-md bg-[#0B1324] border border-[#2A3F63] font-mono text-slate-100"
            />
          </label>

          <label className="block text-slate-300">
            Sampling Interval (ms)
            <input
              type="number"
              min={1200}
              max={15000}
              step={100}
              value={form.sampling_interval_ms}
              onChange={(e) => updateForm({ sampling_interval_ms: Number(e.target.value) })}
              className="mt-1.5 w-full px-3 py-2 rounded-md bg-[#0B1324] border border-[#2A3F63] font-mono text-slate-100"
            />
          </label>

          <label className="block text-slate-300">
            Normal Rain Threshold (Raw ADC)
            <input
              type="number"
              min={50}
              max={800}
              value={form.rain_normal_threshold}
              onChange={(e) => updateForm({ rain_normal_threshold: Number(e.target.value) })}
              className="mt-1.5 w-full px-3 py-2 rounded-md bg-[#0B1324] border border-[#2A3F63] font-mono text-slate-100"
            />
          </label>

          <label className="block text-slate-300">
            Heavy Rain Threshold (Raw ADC)
            <input
              type="number"
              min={200}
              max={1000}
              value={form.rain_heavy_threshold}
              onChange={(e) => updateForm({ rain_heavy_threshold: Number(e.target.value) })}
              className="mt-1.5 w-full px-3 py-2 rounded-md bg-[#0B1324] border border-[#2A3F63] font-mono text-slate-100"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 pt-3 border-t border-[#1E2E4A]">
          <p className="text-xs text-slate-400">
            AES-128-GCM keys are provisioned via server environment variables (`IOT_AES_KEY_HEX`) and never exposed here.
          </p>
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Apply Configuration'}
          </button>
        </div>

        {savedMsg && <div className="text-xs font-mono text-sky-300">{savedMsg}</div>}
      </form>

      {/* API Endpoint Catalog */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-[#1E2E4A]">
          <h3 className="text-sm font-semibold text-slate-100">REST API Endpoint Reference</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[#1E2E4A] bg-[#0B1324] text-slate-400">
                <th className="py-2.5 px-4">Method</th>
                <th className="py-2.5 px-4">Endpoint</th>
                <th className="py-2.5 px-4">Responsibility</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1E2E4A]">
              {API_CATALOG.map(([method, endpoint, desc]) => (
                <tr key={endpoint}>
                  <td className="py-2 px-4 font-mono text-sky-400 whitespace-nowrap">{method}</td>
                  <td className="py-2 px-4 font-mono text-slate-200 whitespace-nowrap">{endpoint}</td>
                  <td className="py-2 px-4 text-slate-400">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
