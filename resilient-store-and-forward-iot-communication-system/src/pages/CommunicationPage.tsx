import React, { useEffect, useState } from 'react';
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
  AckRecord,
  CommEvent,
  LinkHopId,
  MeasurementSpec,
  NetworkMetric,
  SystemStatusResponse,
} from '../types/iot';

interface Props {
  status: SystemStatusResponse;
  refreshTick: number;
}

const LINK_META: Record<
  LinkHopId,
  {
    shortTitle: string;
    fullTitle: string;
    subtitle: string;
    accentColor: string;
    strokeHex: string;
    rssiDomain: [number, number];
    badgeLabel: string;
  }
> = {
  NODE1_NODE3_WIFI: {
    shortTitle: 'NODE1_NODE3_WIFI',
    fullTitle: 'Link 1: Node 1 → Node 3 (Direct Wi-Fi)',
    subtitle: 'Preferred Scenario A path · Completely bypasses Node 2 & microSD',
    accentColor: 'text-sky-400',
    strokeHex: '#38BDF8',
    rssiDomain: [-105, -35],
    badgeLabel: 'Preferred Direct Path',
  },
  NODE1_NODE2_LORA: {
    shortTitle: 'NODE1_NODE2_LORA',
    fullTitle: 'Link 2: Node 1 → Node 2 (Bidirectional LoRa)',
    subtitle: 'Fallback Scenario B Hop-1 · Flushes ciphertext to Node 2 microSD',
    accentColor: 'text-amber-400',
    strokeHex: '#F59E0B',
    rssiDomain: [-130, -50],
    badgeLabel: 'Fallback LoRa Hop-1',
  },
  NODE2_NODE3_WIFI: {
    shortTitle: 'NODE2_NODE3_WIFI',
    fullTitle: 'Link 3: Node 2 → Node 3 (Gateway Wi-Fi)',
    subtitle: 'Fallback Scenario B Hop-2 · Exclusive ML feature target stream',
    accentColor: 'text-emerald-400',
    strokeHex: '#10B981',
    rssiDomain: [-105, -35],
    badgeLabel: 'ML Target Link',
  },
  LEGACY_UNCLASSIFIED: {
    shortTitle: 'LEGACY_UNCLASSIFIED',
    fullTitle: 'Legacy Unclassified Network Metrics',
    subtitle: 'Preserved pre-migration records · Isolated from the 3 physical links & ML',
    accentColor: 'text-slate-400',
    strokeHex: '#94A3B8',
    rssiDomain: [-115, -40],
    badgeLabel: 'Historical Legacy',
  },
};

const PHYSICAL_LINKS: LinkHopId[] = ['NODE1_NODE3_WIFI', 'NODE1_NODE2_LORA', 'NODE2_NODE3_WIFI'];

function formatRssiSource(src?: string): string {
  if (!src) return 'UNSPECIFIED';
  switch (src) {
    case 'AP_STATION_RSSI':
      return 'AP_STATION_RSSI (WiFi.RSSI to AP)';
    case 'PEER_TO_PEER_RSSI':
      return 'PEER_TO_PEER_RSSI (Direct RF)';
    case 'LORA_PKT_RSSI':
      return 'LORA_PKT_RSSI (SX127x Packet)';
    case 'SIMULATED_LINK_RSSI':
      return 'SIMULATED_LINK_RSSI';
    default:
      return src;
  }
}

function formatDataSourceBadge(ds?: string): { label: string; cls: string } {
  if (ds === 'ESP32_HARDWARE') return { label: 'ESP32_HARDWARE', cls: 'text-emerald-400' };
  if (ds === 'LEGACY_UNCLASSIFIED') return { label: 'LEGACY_UNCLASSIFIED', cls: 'text-slate-400' };
  return { label: ds || 'SIMULATED', cls: 'text-amber-300' };
}

function formatAckStageLabel(ack: AckRecord): { stage: string; tone: string } {
  if (ack.link_hop === 'NODE1_NODE3' || (ack.sender_node === 3 && ack.receiver_node === 1)) {
    return { stage: 'Direct ACK (N3→N1)', tone: 'text-sky-400' };
  }
  if (ack.link_hop === 'NODE1_NODE2' || (ack.sender_node === 2 && ack.receiver_node === 1)) {
    return { stage: 'Stage-1 Storage ACK (N2→N1)', tone: 'text-amber-400' };
  }
  if (ack.link_hop === 'NODE2_NODE3' || (ack.sender_node === 3 && ack.receiver_node === 2)) {
    return { stage: 'Stage-2 Final ACK (N3→N2)', tone: 'text-emerald-400' };
  }
  return { stage: `${ack.link_hop} (N${ack.sender_node}→N${ack.receiver_node})`, tone: 'text-slate-300' };
}

export const CommunicationPage: React.FC<Props> = ({ status, refreshTick }) => {
  const [selectedLink, setSelectedLink] = useState<LinkHopId>('NODE2_NODE3_WIFI');
  const [metricsByLink, setMetricsByLink] = useState<Record<LinkHopId, NetworkMetric[]>>({
    NODE1_NODE3_WIFI: [],
    NODE1_NODE2_LORA: [],
    NODE2_NODE3_WIFI: [],
    LEGACY_UNCLASSIFIED: [],
  });
  const [measurementSpec, setMeasurementSpec] = useState<MeasurementSpec | null>(null);
  const [events, setEvents] = useState<CommEvent[]>([]);
  const [acks, setAcks] = useState<AckRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let active = true;
    iotApi
      .getCommunication(status.mode, 60, selectedLink)
      .then((res) => {
        if (active) {
          if (res.metrics_by_link) {
            setMetricsByLink(res.metrics_by_link);
          } else {
            setMetricsByLink((prev) => ({
              ...prev,
              [selectedLink]: res.metrics,
            }));
          }
          if (res.measurement_spec) {
            setMeasurementSpec(res.measurement_spec);
          }
          setEvents(res.events);
          setAcks(res.acknowledgements);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load communication telemetry.');
        }
      });
    return () => {
      active = false;
    };
  }, [status.mode, selectedLink, refreshTick, retryCount]);

  const activeSeries = metricsByLink[selectedLink] || [];
  const activeMeta = LINK_META[selectedLink];
  const latestSelected = activeSeries.length > 0 ? activeSeries[activeSeries.length - 1] : null;
  const legacyCount = metricsByLink.LEGACY_UNCLASSIFIED.length;

  const getLinkCardData = (hop: LinkHopId) => {
    const series = metricsByLink[hop] || [];
    const latestFromSeries = series.length > 0 ? series[series.length - 1] : null;
    if (hop === 'NODE1_NODE3_WIFI') {
      const entry = status.links?.node1_node3_wifi;
      return {
        statusText: entry?.status || (status.active_comm_mode === 'WIFI' ? 'CONNECTED' : 'OFFLINE'),
        active: entry?.active ?? status.active_comm_mode === 'WIFI',
        latest: latestFromSeries || entry?.latest_metric || null,
        queueLabel: 'Node 1 LittleFS Queue',
        queueValue: status.summary.pending_node1_littlefs,
        sampleCount: series.length,
      };
    }
    if (hop === 'NODE1_NODE2_LORA') {
      const entry = status.links?.node1_node2_lora;
      return {
        statusText: entry?.status || (status.active_comm_mode === 'LORA' ? 'ACTIVE_FALLBACK' : 'STANDBY'),
        active: entry?.active ?? status.active_comm_mode === 'LORA',
        latest: latestFromSeries || entry?.latest_metric || null,
        queueLabel: 'Node 1 LittleFS Queue',
        queueValue: status.summary.pending_node1_littlefs,
        sampleCount: series.length,
      };
    }
    const entry = status.links?.node2_node3_wifi;
    return {
      statusText: entry?.status || status.node2_to_node3_status,
      active: entry?.active ?? status.node2_to_node3_status === 'CONNECTED',
      latest: latestFromSeries || entry?.latest_metric || null,
      queueLabel: 'Node 2 microSD Queue',
      queueValue: entry?.queue_depth ?? status.summary.pending_node2_microsd,
      sampleCount: series.length,
    };
  };

  const chartData = activeSeries.map((m) => ({
    time: new Date(m.recorded_at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
    rssi: m.rssi,
    latency: m.ack_latency_ms,
    lossPct: Number((m.packet_loss_ratio * 100).toFixed(1)),
    retries: m.retry_count,
    queue: m.queue_depth,
  }));

  const selectedDataSource = formatDataSourceBadge(latestSelected?.data_source);

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-rose-950/50 border border-rose-700/60 rounded-xl px-4 py-3 flex items-center justify-between gap-4 text-xs">
          <span className="font-mono text-rose-300">Communication API Error: {error}</span>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-3 py-1 rounded-md bg-rose-700 hover:bg-rose-600 text-white font-medium whitespace-nowrap cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Three Independent Physical Link Status Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {PHYSICAL_LINKS.map((hop) => {
          const meta = LINK_META[hop];
          const info = getLinkCardData(hop);
          const isSelected = selectedLink === hop;
          const ds = formatDataSourceBadge(info.latest?.data_source);
          const statusColor =
            info.statusText === 'CONNECTED' || info.statusText === 'ACTIVE_FALLBACK'
              ? hop === 'NODE1_NODE2_LORA'
                ? 'text-amber-400'
                : hop === 'NODE1_NODE3_WIFI'
                  ? 'text-sky-400'
                  : 'text-emerald-400'
              : info.statusText === 'STANDBY' || info.statusText === 'RETRYING' || info.statusText === 'DEGRADED'
                ? 'text-amber-300'
                : 'text-rose-400';

          return (
            <button
              key={hop}
              type="button"
              onClick={() => setSelectedLink(hop)}
              className={`text-left bg-[#111C30] rounded-xl p-5 border transition-colors cursor-pointer ${
                isSelected
                  ? 'border-blue-500 ring-1 ring-blue-500/40'
                  : 'border-[#1E2E4A] hover:border-[#2E4670]'
              }`}
            >
              <div className="flex items-start justify-between gap-2 pb-3 border-b border-[#1E2E4A]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-[11px] font-mono font-semibold ${meta.accentColor}`}>
                      {meta.shortTitle}
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">· {meta.badgeLabel}</span>
                  </div>
                  <h3 className="text-sm font-semibold text-slate-100 mt-1">{meta.fullTitle}</h3>
                  <p className="text-xs text-slate-400 mt-0.5">{meta.subtitle}</p>
                </div>
                <span className={`text-xs font-mono font-semibold shrink-0 ${statusColor}`}>
                  {info.statusText === 'CONNECTED' || info.statusText === 'ACTIVE_FALLBACK'
                    ? `● ${info.statusText}`
                    : info.statusText === 'STANDBY' || info.statusText === 'RETRYING'
                      ? `▲ ${info.statusText}`
                      : `✖ ${info.statusText}`}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-3 text-xs font-mono tabular-nums">
                <div>
                  <div className="text-slate-400">RSSI</div>
                  <div className="text-base text-slate-100 mt-1">
                    {info.latest ? `${info.latest.rssi} dBm` : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">RSSI Var</div>
                  <div className="text-base text-slate-100 mt-1">
                    {info.latest ? `±${info.latest.rssi_variation} dB` : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Loss (20-tx)</div>
                  <div className="text-base text-slate-100 mt-1">
                    {info.latest ? `${(info.latest.packet_loss_ratio * 100).toFixed(1)}%` : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">ACK Latency</div>
                  <div className="text-base text-slate-100 mt-1">
                    {info.latest ? `${info.latest.ack_latency_ms} ms` : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Retries</div>
                  <div className="text-base text-slate-100 mt-1">
                    {info.latest ? info.latest.retry_count : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400 truncate">{info.queueLabel}</div>
                  <div className="text-base text-amber-300 mt-1">{info.queueValue}</div>
                </div>
              </div>

              <div className="mt-3 pt-3 border-t border-[#1E2E4A] flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
                <span className="text-slate-400 truncate">
                  {info.latest ? formatRssiSource(info.latest.rssi_source) : 'Awaiting link metric'}
                </span>
                <span className={ds.cls}>{info.latest ? ds.label : 'NO SAMPLES'}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Independent Link Chart Selector Bar (Never Mixes Wi-Fi & LoRa) */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-[#0B1324] border border-[#1E2E4A] rounded-lg">
          {PHYSICAL_LINKS.map((hop) => (
            <button
              key={hop}
              type="button"
              onClick={() => setSelectedLink(hop)}
              className={`px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                selectedLink === hop
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {hop} ({metricsByLink[hop]?.length ?? 0})
            </button>
          ))}
          {legacyCount > 0 && (
            <button
              type="button"
              onClick={() => setSelectedLink('LEGACY_UNCLASSIFIED')}
              className={`px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                selectedLink === 'LEGACY_UNCLASSIFIED'
                  ? 'bg-slate-600 text-white'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              LEGACY_UNCLASSIFIED ({legacyCount})
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
          <span className={activeMeta.accentColor}>Active Chart Stream: {selectedLink}</span>
          <span className="text-slate-600">·</span>
          <span className={selectedDataSource.cls}>{selectedDataSource.label}</span>
          <span className="text-slate-600">·</span>
          <span className="text-slate-400">Wi-Fi & LoRa strictly isolated</span>
        </div>
      </div>

      {/* Single-Link Charts: RSSI, ACK Latency, Packet Loss & Retries */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
            <h3 className="text-sm font-semibold text-slate-100">
              {selectedLink === 'NODE1_NODE2_LORA' ? 'LoRa Packet RSSI (dBm)' : 'Wi-Fi RSSI (dBm)'} — {selectedLink}
            </h3>
            <span className="text-[11px] font-mono text-slate-400">
              {latestSelected ? formatRssiSource(latestSelected.rssi_source) : 'No samples'}
            </span>
          </div>
          <div className="h-56">
            {chartData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">
                No {selectedLink} RSSI samples recorded in {status.mode} mode.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid stroke="#1E2E4A" strokeDasharray="3 3" />
                  <XAxis dataKey="time" stroke="#64748B" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#64748B" tick={{ fontSize: 11 }} domain={activeMeta.rssiDomain} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0D1526',
                      border: '1px solid #1E2E4A',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="rssi"
                    name={`${selectedLink} RSSI (dBm)`}
                    stroke={activeMeta.strokeHex}
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
            <h3 className="text-sm font-semibold text-slate-100">
              Matching ACK Latency (ms) & Queue Depth — {selectedLink}
            </h3>
            <span className="text-[11px] font-mono text-slate-400">
              Timeout {measurementSpec?.ack_timeout_ms ?? status.settings.ack_timeout_ms} ms
            </span>
          </div>
          <div className="h-56">
            {chartData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">
                No {selectedLink} ACK latency metrics recorded in {status.mode} mode.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
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
                  <Bar dataKey="latency" name="ACK Latency (ms)" fill="#3B82F6" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="queue" name="Link Queue Depth" fill="#10B981" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5 lg:col-span-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
            <h3 className="text-sm font-semibold text-slate-100">
              Packet Loss (%) & Retransmission Count — {selectedLink}
            </h3>
            <span className="text-xs font-mono text-slate-500">
              {chartData.length} SQLite samples · Rolling {measurementSpec?.packet_loss_window_attempts ?? 20}-attempt window
            </span>
          </div>
          <div className="h-48">
            {chartData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">
                No {selectedLink} packet loss or retry metrics recorded in {status.mode} mode.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
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
                  <Bar dataKey="lossPct" name="Packet Loss (%)" fill="#F59E0B" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="retries" name="Retry Count" fill="#EF4444" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Measurement Provenance & Policy Summary (From Backend Measurement Spec) */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5 grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
        <div>
          <h4 className="font-semibold text-slate-100 font-mono">RSSI Provenance Policy</h4>
          <p className="text-slate-400 mt-1.5 leading-relaxed">
            <span className="font-mono text-sky-300">AP_STATION_RSSI</span> reflects ESP32-to-router signal (<span className="font-mono">WiFi.RSSI()</span>) and is never mislabeled as <span className="font-mono text-emerald-300">PEER_TO_PEER_RSSI</span>. LoRa uses <span className="font-mono text-amber-300">LORA_PKT_RSSI</span>.
          </p>
        </div>
        <div>
          <h4 className="font-semibold text-slate-100 font-mono">Loss Window & Retry Rule</h4>
          <p className="text-slate-400 mt-1.5 leading-relaxed">
            {measurementSpec?.packet_loss_formula ||
              'Rolling 20-attempt window computed strictly per link_hop.'}{' '}
            Hysteresis: {status.settings.hysteresis_good_samples} good / {status.settings.hysteresis_bad_samples} bad samples; Retry limit {measurementSpec?.retry_limit ?? status.settings.retry_limit}.
          </p>
        </div>
        <div>
          <h4 className="font-semibold text-slate-100 font-mono">Matching ACK Latency & ML Isolation</h4>
          <p className="text-slate-400 mt-1.5 leading-relaxed">
            {measurementSpec?.matching_ack_latency_rule ||
              'Measured only when ACK packet_id, sender, and receiver match.'}{' '}
            Only <span className="font-mono text-emerald-400">NODE2_NODE3_WIFI</span> feeds advisory ML models.
          </p>
        </div>
      </div>

      {/* Interactive Communication Timeline & ACK Ledger */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-[#111C30] border border-[#1E2E4A] rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-[#1E2E4A] flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-slate-100">Communication Event Timeline</h3>
            <span className="text-xs font-mono text-slate-500">{events.length} recent events</span>
          </div>
          <div className="max-h-96 overflow-y-auto divide-y divide-[#1E2E4A]">
            {events.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">No communication events logged yet.</div>
            ) : (
              events.map((ev) => {
                const color =
                  ev.event_type.includes('FAILURE') || ev.event_type.includes('LOST') || ev.event_type.includes('OFFLINE') || ev.event_type.includes('DISCONNECTED')
                    ? 'text-rose-400'
                    : ev.event_type.includes('LORA') || ev.event_type.includes('DUPLICATE') || ev.event_type.includes('PENDING')
                      ? 'text-amber-400'
                      : 'text-emerald-400';
                return (
                  <div key={ev.id} className="px-5 py-3 text-xs flex flex-col sm:flex-row sm:items-baseline justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2 font-mono">
                        <span className={color}>{ev.event_type}</span>
                        <span className="text-slate-500">·</span>
                        <span className="text-slate-300">{ev.link_hop.replace(/_/g, ' ')}</span>
                        <span className="text-slate-500">·</span>
                        <span className="text-sky-400">{ev.comm_mode}</span>
                        {ev.packet_id !== null && (
                          <>
                            <span className="text-slate-500">·</span>
                            <span className="text-slate-200">Pkt #{ev.packet_id}</span>
                          </>
                        )}
                      </div>
                      <p className="text-slate-400 mt-1">{ev.details}</p>
                    </div>
                    <span className="text-[11px] font-mono text-slate-500 shrink-0 tabular-nums">
                      {new Date(ev.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-[#1E2E4A] flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-slate-100">ACK Verification Ledger</h3>
            <span className="text-xs font-mono text-slate-500">{acks.length} records</span>
          </div>
          <div className="max-h-96 overflow-y-auto divide-y divide-[#1E2E4A]">
            {acks.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">No ACK records yet.</div>
            ) : (
              acks.map((a) => {
                const stageInfo = formatAckStageLabel(a);
                return (
                  <div key={a.id} className="px-4 py-3 text-xs font-mono tabular-nums">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-200">Pkt #{a.packet_id}</span>
                      <span
                        className={
                          a.status.includes('LOST') || a.status.includes('REJECTED')
                            ? 'text-rose-400'
                            : a.status.includes('DUPLICATE')
                              ? 'text-amber-400'
                              : 'text-emerald-400'
                        }
                      >
                        {a.status}
                      </span>
                    </div>
                    <div className={`text-[11px] mt-0.5 ${stageInfo.tone}`}>{stageInfo.stage}</div>
                    <div className="text-[11px] text-slate-500 mt-1 flex justify-between">
                      <span>{a.latency_ms} ms</span>
                      <span>{new Date(a.created_at).toLocaleTimeString()}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
