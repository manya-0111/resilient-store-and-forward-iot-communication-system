import React, { useEffect, useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { iotApi } from '../services/api';
import type {
  CsvUploadResponse,
  DataSource,
  HistoryResponse,
  LinkHopId,
  OperatingMode,
} from '../types/iot';

interface Props {
  mode: OperatingMode;
  refreshTick: number;
}

const HISTORY_LINK_OPTIONS: Array<{ id: LinkHopId; label: string; color: string }> = [
  { id: 'NODE2_NODE3_WIFI', label: 'NODE2_NODE3_WIFI (GW Wi-Fi · ML)', color: 'text-emerald-400' },
  { id: 'NODE1_NODE3_WIFI', label: 'NODE1_NODE3_WIFI (Direct Wi-Fi)', color: 'text-sky-400' },
  { id: 'NODE1_NODE2_LORA', label: 'NODE1_NODE2_LORA (LoRa Fallback)', color: 'text-amber-400' },
  { id: 'LEGACY_UNCLASSIFIED', label: 'LEGACY_UNCLASSIFIED (Pre-Migration)', color: 'text-slate-400' },
];

const DATA_SOURCE_OPTIONS: Array<{ id: DataSource; label: string }> = [
  { id: 'SIMULATED', label: 'SIMULATED' },
  { id: 'ESP32_HARDWARE', label: 'ESP32_HARDWARE' },
  { id: 'CSV_IMPORT', label: 'CSV_IMPORT' },
];

export const HistoricalDataPage: React.FC<Props> = ({ mode, refreshTick }) => {
  const [rangePreset, setRangePreset] = useState<'all' | '1h' | '24h' | 'custom'>('all');
  const [selectedLink, setSelectedLink] = useState<LinkHopId>('NODE2_NODE3_WIFI');
  const [selectedSource, setSelectedSource] = useState<DataSource>(
    mode === 'hardware' ? 'ESP32_HARDWARE' : 'SIMULATED'
  );
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [data, setData] = useState<HistoryResponse | null>(null);

  // Single Hardware CSV upload workflow state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [defaultUploadHop, setDefaultUploadHop] = useState<LinkHopId>('NODE2_NODE3_WIFI');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<CsvUploadResponse | null>(null);

  useEffect(() => {
    setSelectedSource(mode === 'hardware' ? 'ESP32_HARDWARE' : 'SIMULATED');
  }, [mode]);

  useEffect(() => {
    let fromIso = '';
    let toIso = '';
    if (rangePreset === '1h') {
      fromIso = new Date(Date.now() - 3600 * 1000).toISOString();
    } else if (rangePreset === '24h') {
      fromIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    } else if (rangePreset === 'custom') {
      if (customFrom) {
        const dFrom = new Date(customFrom);
        if (Number.isFinite(dFrom.getTime())) fromIso = dFrom.toISOString();
      }
      if (customTo) {
        const dTo = new Date(customTo);
        if (Number.isFinite(dTo.getTime())) toIso = dTo.toISOString();
      }
    }

    let active = true;
    iotApi
      .getHistory(mode, fromIso, toIso, selectedSource)
      .then((res) => {
        if (active) {
          setData(res);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load historical SQLite records.');
        }
      });
    return () => {
      active = false;
    };
  }, [mode, rangePreset, customFrom, customTo, selectedSource, refreshTick, retryCount]);

  const handleUploadCsv = async () => {
    if (!selectedFile) {
      setUploadError('Please select a .csv file first.');
      return;
    }
    if (selectedFile.size > 5 * 1024 * 1024) {
      setUploadError('CSV file exceeds the 5 MB upload limit.');
      return;
    }
    setUploading(true);
    setUploadError(null);
    setUploadSuccess(null);
    try {
      const csvText = await selectedFile.text();
      const result = await iotApi.uploadHardwareCsv({
        filename: selectedFile.name,
        csv_text: csvText,
        default_link_hop: defaultUploadHop,
      });
      setUploadSuccess(result);
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      // Switch view directly to CSV_IMPORT so imported rows appear immediately and stay isolated
      setSelectedSource('CSV_IMPORT');
      if (result.batch.ml_ready_n2n3_count > 0) {
        setSelectedLink('NODE2_NODE3_WIFI');
      } else {
        setSelectedLink(result.batch.default_link_hop);
      }
      setRetryCount((c) => c + 1);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to import CSV file.');
    } finally {
      setUploading(false);
    }
  };

  const allMetrics = data?.metrics || [];

  const dbNetworkCounts = data?.provenance_counts?.network_metrics;
  const dbSensorCounts = data?.provenance_counts?.sensor_readings;
  const totalBySource: Record<DataSource, number> = {
    SIMULATED: (dbNetworkCounts?.SIMULATED ?? 0) + (dbSensorCounts?.SIMULATED ?? 0),
    ESP32_HARDWARE: (dbNetworkCounts?.ESP32_HARDWARE ?? 0) + (dbSensorCounts?.ESP32_HARDWARE ?? 0),
    CSV_IMPORT: (dbNetworkCounts?.CSV_IMPORT ?? 0) + (dbSensorCounts?.CSV_IMPORT ?? 0),
    LEGACY_UNCLASSIFIED:
      (dbNetworkCounts?.LEGACY_UNCLASSIFIED ?? 0) + (dbSensorCounts?.LEGACY_UNCLASSIFIED ?? 0),
  };

  // Count per-link breakdown within the active isolated data source
  const provenanceCounts = allMetrics.reduce(
    (acc, m) => {
      const ds =
        m.data_source ||
        (m.link_hop === 'LEGACY_UNCLASSIFIED'
          ? 'LEGACY_UNCLASSIFIED'
          : selectedSource);
      if (ds === 'ESP32_HARDWARE') acc.hardware += 1;
      else if (ds === 'CSV_IMPORT') acc.csvImport += 1;
      else if (ds === 'LEGACY_UNCLASSIFIED') acc.legacy += 1;
      else acc.simulated += 1;
      return acc;
    },
    { simulated: 0, hardware: 0, csvImport: 0, legacy: 0 }
  );

  const linkCounts = allMetrics.reduce(
    (acc, m) => {
      const hop = (m.link_hop || 'LEGACY_UNCLASSIFIED') as LinkHopId;
      acc[hop] = (acc[hop] || 0) + 1;
      return acc;
    },
    {
      NODE1_NODE3_WIFI: 0,
      NODE1_NODE2_LORA: 0,
      NODE2_NODE3_WIFI: 0,
      LEGACY_UNCLASSIFIED: 0,
    } as Record<LinkHopId, number>
  );

  // Strictly isolate historical network charts to a single selected link_hop (never mix Wi-Fi, LoRa, and Legacy!)
  const filteredMetrics = allMetrics.filter(
    (m) => (m.link_hop || 'LEGACY_UNCLASSIFIED') === selectedLink
  );

  const sensorSeries = (data?.sensors || []).map((s) => ({
    time: new Date(s.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    temperature: s.temperature,
    humidity: s.humidity,
    rain_raw: s.rain_raw,
  }));

  const metricSeries = filteredMetrics.map((m) => ({
    time: new Date(m.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    rssi: m.rssi,
    latency: m.ack_latency_ms,
    lossPct: Number((m.packet_loss_ratio * 100).toFixed(1)),
    retries: m.retry_count,
    queue: m.queue_depth,
  }));

  const deliveredCount = (data?.packets || []).filter((p) => p.overall_status === 'DELIVERED').length;
  const directWifiPackets = (data?.packets || []).filter((p) => p.route_path === 'DIRECT_WIFI').length;
  const loraGatewayPackets = (data?.packets || []).filter((p) => p.route_path === 'LORA_GATEWAY').length;
  const totalPackets = data?.packets.length || 0;
  const deliveryRate = totalPackets > 0 ? ((deliveredCount / totalPackets) * 100).toFixed(1) : '0.0';
  const totalRetries = (data?.packets || []).reduce((acc, p) => acc + p.retry_count, 0);
  const loraSwitchCount = (data?.communication_events || []).filter((e) => e.event_type === 'LORA_FALLBACK').length;

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-rose-950/50 border border-rose-700/60 rounded-xl px-4 py-3 flex items-center justify-between gap-4 text-xs">
          <span className="font-mono text-rose-300">History API Error: {error}</span>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-3 py-1 rounded-md bg-rose-700 hover:bg-rose-600 text-white font-medium whitespace-nowrap cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Filter & CSV Export Bar */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-[#0B1324] border border-[#1E2E4A] rounded-lg">
            {([
              { id: 'all', label: 'All SQLite History' },
              { id: '1h', label: 'Last 1 Hour' },
              { id: '24h', label: 'Last 24 Hours' },
              { id: 'custom', label: 'Custom Range' },
            ] as const).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setRangePreset(p.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  rangePreset === p.id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {rangePreset === 'custom' && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <input
                type="datetime-local"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="px-2.5 py-1.5 rounded-md bg-[#0B1324] border border-[#2A3F63] text-slate-200 font-mono"
              />
              <span className="text-slate-500">to</span>
              <input
                type="datetime-local"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="px-2.5 py-1.5 rounded-md bg-[#0B1324] border border-[#2A3F63] text-slate-200 font-mono"
              />
            </div>
          )}
        </div>

        {/* Working CSV Downloads */}
        <div className="flex flex-wrap items-center gap-2">
          {([
            { type: 'sensors', label: 'Sensors CSV', linkHop: undefined },
            { type: 'network', label: 'N2→N3 Wi-Fi CSV (ML)', linkHop: 'NODE2_NODE3_WIFI' as LinkHopId },
            { type: 'network', label: 'All Network CSV', linkHop: undefined },
            { type: 'packets', label: 'Packets CSV', linkHop: undefined },
            { type: 'security', label: 'Security CSV', linkHop: undefined },
          ] as const).map((exp) => (
            <a
              key={exp.label}
              href={iotApi.csvExportUrl(mode, exp.type, exp.linkHop, selectedSource)}
              download
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[#0B1324] hover:bg-slate-800 text-sky-300 border border-[#2A3F63] transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              {exp.label}
            </a>
          ))}
        </div>
      </div>

      {/* Upload Hardware CSV Option (Persisted under data_source = CSV_IMPORT) */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-0.5">
            <h3 className="text-sm font-semibold text-slate-100">Upload Hardware CSV</h3>
            <p className="text-xs text-slate-400">
              Import captured ESP32 network (<span className="font-mono text-slate-300">rssi, recorded_at</span> + optional ML features) or sensor (<span className="font-mono text-slate-300">temperature, humidity, rain_raw, recorded_at</span>) CSV files. Imported rows are persisted as <span className="font-mono text-cyan-300">CSV_IMPORT</span> and kept separate from <span className="font-mono text-emerald-400">ESP32_HARDWARE</span> and <span className="font-mono text-amber-300">SIMULATED</span>.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-[#0B1324] border border-[#2A3F63] text-xs text-slate-200 cursor-pointer hover:border-sky-500">
              <span className="font-mono truncate max-w-[200px]">
                {selectedFile ? selectedFile.name : 'Choose .csv file...'}
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  setSelectedFile(file);
                  setUploadError(null);
                  setUploadSuccess(null);
                }}
              />
            </label>

            <select
              aria-label="Default link_hop for network CSV rows missing link_hop"
              value={defaultUploadHop}
              onChange={(e) => setDefaultUploadHop(e.target.value as LinkHopId)}
              className="px-2.5 py-1.5 rounded-md bg-[#0B1324] border border-[#2A3F63] text-xs font-mono text-slate-200"
            >
              <option value="NODE2_NODE3_WIFI">Default Link: NODE2_NODE3_WIFI</option>
              <option value="NODE1_NODE3_WIFI">Default Link: NODE1_NODE3_WIFI</option>
              <option value="NODE1_NODE2_LORA">Default Link: NODE1_NODE2_LORA</option>
            </select>

            <button
              type="button"
              disabled={!selectedFile || uploading}
              onClick={handleUploadCsv}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                !selectedFile || uploading
                  ? 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-500 text-white'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              {uploading ? 'Importing CSV...' : 'Import CSV'}
            </button>
          </div>
        </div>

        {uploadError && (
          <div className="px-3.5 py-2 rounded-lg bg-rose-950/50 border border-rose-700/60 text-xs font-mono text-rose-300">
            {uploadError}
          </div>
        )}

        {uploadSuccess && (
          <div className="px-3.5 py-2 rounded-lg bg-emerald-950/40 border border-emerald-700/60 text-xs font-mono text-emerald-300 flex flex-wrap items-center justify-between gap-2">
            <span>
              Imported batch #{uploadSuccess.batch.id} ({uploadSuccess.batch.filename}):{' '}
              {uploadSuccess.batch.network_rows} network row(s), {uploadSuccess.batch.sensor_rows} sensor row(s),{' '}
              {uploadSuccess.batch.ml_ready_n2n3_count} ML-ready NODE2_NODE3_WIFI row(s) saved as CSV_IMPORT.
            </span>
            <span className="text-slate-300">{uploadSuccess.ml_inference.note}</span>
          </div>
        )}

        {(data?.csv_imports?.length ?? 0) > 0 && (
          <div className="pt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono text-slate-400">
            <span className="text-slate-300 font-sans font-medium">Persisted CSV Batches:</span>
            {data!.csv_imports!.slice(0, 5).map((b) => (
              <span key={b.id} className="text-cyan-300/90">
                #{b.id} {b.filename} ({b.network_rows} net / {b.sensor_rows} sens)
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Data Provenance Isolation & Single-Link Chart Selector Bar */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-[#0B1324] border border-[#1E2E4A] rounded-lg">
          {HISTORY_LINK_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setSelectedLink(opt.id)}
              className={`px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                selectedLink === opt.id
                  ? opt.id === 'LEGACY_UNCLASSIFIED'
                    ? 'bg-slate-600 text-white'
                    : 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {opt.id} ({linkCounts[opt.id]})
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-[#0B1324] border border-[#1E2E4A] rounded-lg text-xs font-mono tabular-nums">
          {DATA_SOURCE_OPTIONS.map((src) => {
            const count = totalBySource[src.id];
            const active = selectedSource === src.id;
            return (
              <button
                key={src.id}
                type="button"
                onClick={() => setSelectedSource(src.id)}
                className={`px-2.5 py-1 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? src.id === 'CSV_IMPORT'
                      ? 'bg-cyan-700 text-white'
                      : src.id === 'ESP32_HARDWARE'
                        ? 'bg-emerald-700 text-white'
                        : 'bg-amber-700 text-white'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {src.label}: {count}
              </button>
            );
          })}
          {provenanceCounts.legacy > 0 && (
            <span className="px-2 text-slate-400">LEGACY: {provenanceCounts.legacy}</span>
          )}
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 text-xs font-mono tabular-nums">
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-slate-400 font-sans">Delivery Success Rate</div>
          <div className="text-2xl text-emerald-400 font-semibold mt-1">{deliveryRate}%</div>
          <div className="text-[11px] text-slate-500 mt-1">
            Direct {directWifiPackets} · LoRa GW {loraGatewayPackets}
          </div>
        </div>
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-slate-400 font-sans">Cumulative Retries</div>
          <div className="text-2xl text-amber-300 font-semibold mt-1">{totalRetries}</div>
          <div className="text-[11px] text-slate-500 mt-1">At-least-once retransmits</div>
        </div>
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-slate-400 font-sans">LoRa Fallbacks</div>
          <div className="text-2xl text-sky-400 font-semibold mt-1">{loraSwitchCount}</div>
          <div className="text-[11px] text-slate-500 mt-1">Direct Wi-Fi → LoRa switches</div>
        </div>
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-slate-400 font-sans">Security Events</div>
          <div className="text-2xl text-slate-100 font-semibold mt-1">{data?.security_events.length ?? 0}</div>
          <div className="text-[11px] text-slate-500 mt-1">Encrypt / verify / reject</div>
        </div>
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-slate-400 font-sans">Selected Link Samples</div>
          <div className="text-2xl text-sky-400 font-semibold mt-1">{filteredMetrics.length}</div>
          <div className="text-[11px] text-slate-500 mt-1 truncate">{selectedLink}</div>
        </div>
      </div>

      {/* Multi-Chart Historical Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-slate-100 mb-4">Historical Temperature & Humidity</h3>
          <div className="h-60">
            {sensorSeries.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">
                No historical sensor records in SQLite for this mode/range.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={sensorSeries}>
                  <CartesianGrid stroke="#1E2E4A" strokeDasharray="3 3" />
                  <XAxis dataKey="time" stroke="#64748B" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#64748B" tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0D1526',
                      border: '1px solid #1E2E4A',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <Line type="monotone" dataKey="temperature" name="Temp (°C)" stroke="#38BDF8" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="humidity" name="Humidity (%)" stroke="#60A5FA" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
            <h3 className="text-sm font-semibold text-slate-100">
              Historical Packet Loss (%) & Queue Depth — {selectedLink}
            </h3>
            <span className="text-[11px] font-mono text-slate-400">Single-link isolated</span>
          </div>
          <div className="h-60">
            {metricSeries.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">
                No {selectedLink} metrics in SQLite for this mode/range.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={metricSeries}>
                  <CartesianGrid stroke="#1E2E4A" strokeDasharray="3 3" />
                  <XAxis dataKey="time" stroke="#64748B" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#64748B" tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0D1526',
                      border: '1px solid #1E2E4A',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <Bar dataKey="lossPct" name="Loss (%)" fill="#F59E0B" />
                  <Bar dataKey="queue" name="Queue Depth" fill="#3B82F6" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-slate-100 mb-4">Historical Raindrop Surface Wetness (Raw ADC)</h3>
          <div className="h-56">
            {sensorSeries.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">
                No raindrop records in SQLite for this mode/range.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={sensorSeries}>
                  <CartesianGrid stroke="#1E2E4A" strokeDasharray="3 3" />
                  <XAxis dataKey="time" stroke="#64748B" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#64748B" tick={{ fontSize: 11 }} domain={[0, 1024]} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0D1526',
                      border: '1px solid #1E2E4A',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <Line type="monotone" dataKey="rain_raw" name="Rain ADC" stroke="#3B82F6" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
            <h3 className="text-sm font-semibold text-slate-100">
              Historical ACK Latency (ms) — {selectedLink}
            </h3>
            <span className="text-[11px] font-mono text-slate-400">Single-link isolated</span>
          </div>
          <div className="h-56">
            {metricSeries.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">
                No {selectedLink} latency history in SQLite for this mode/range.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={metricSeries}>
                  <CartesianGrid stroke="#1E2E4A" strokeDasharray="3 3" />
                  <XAxis dataKey="time" stroke="#64748B" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#64748B" tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0D1526',
                      border: '1px solid #1E2E4A',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <Line type="monotone" dataKey="latency" name="ACK Latency (ms)" stroke="#38BDF8" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Historical Security & Anomaly Audit Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[#1E2E4A] flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-slate-100">Security History (SQLite)</h3>
            <span className="text-xs font-mono text-slate-500">{data?.security_events.length ?? 0} records</span>
          </div>
          <div className="max-h-64 overflow-y-auto divide-y divide-[#1E2E4A] text-xs font-mono">
            {!data || data.security_events.length === 0 ? (
              <div className="p-6 text-center text-slate-500 font-sans">No security events in selected range.</div>
            ) : (
              data.security_events.slice(0, 20).map((ev) => (
                <div key={ev.id} className="px-4 py-2.5 flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <span className={ev.status === 'REJECTED' ? 'text-rose-400' : 'text-emerald-400'}>
                      {ev.event_type} ({ev.status})
                    </span>
                    <span className="text-slate-500"> · Pkt #{ev.packet_id ?? '—'}</span>
                    <div className="text-slate-400 font-sans truncate mt-0.5">{ev.details}</div>
                  </div>
                  <span className="text-[11px] text-slate-500 shrink-0 tabular-nums">
                    {new Date(ev.created_at).toLocaleTimeString()}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[#1E2E4A] flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-slate-100">
              Historical ML Predictions · NODE2_NODE3_WIFI
            </h3>
            <span className="text-xs font-mono text-slate-500">
              {data?.ml_predictions.length ?? 0} records
            </span>
          </div>
          <div className="max-h-64 overflow-y-auto divide-y divide-[#1E2E4A] text-xs font-mono">
            {!data || data.ml_predictions.length === 0 ? (
              <div className="p-6 text-center text-slate-500 font-sans">
                No external Python ML predictions recorded for NODE2_NODE3_WIFI in selected range.
              </div>
            ) : (
              data.ml_predictions.slice(0, 20).map((ev) => (
                <div key={ev.id} className="px-4 py-2.5 flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <span className="text-sky-400">
                      {ev.model_type === 'NETWORK_QUALITY'
                        ? `QUALITY: ${ev.model_status === 'READY' ? ev.predicted_class : ev.model_status}`
                        : `WAIT: ${
                            ev.model_status === 'READY' && ev.predicted_wait_seconds !== null
                              ? `${ev.predicted_wait_seconds}s`
                              : ev.model_status
                          }`}
                    </span>
                    <span className="text-slate-500">
                      {' '}
                      · {ev.data_source || '—'} · {ev.model_version || 'unreported'}
                    </span>
                    <div className="text-slate-400 font-sans truncate mt-0.5">
                      {ev.model_type === 'TRANSMISSION_SCHEDULING'
                        ? ev.actual_wait_seconds !== null
                          ? `Actual wait observed: ${ev.actual_wait_seconds}s`
                          : ev.observation_censored
                            ? 'Right-censored observation'
                            : 'Advisory wait prediction (awaiting reconnection)'
                        : `Confidence ${(ev.confidence * 100).toFixed(1)}%`}
                    </div>
                  </div>
                  <span className="text-[11px] text-slate-500 shrink-0 tabular-nums">
                    {new Date(ev.prediction_timestamp || ev.created_at).toLocaleTimeString()}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
