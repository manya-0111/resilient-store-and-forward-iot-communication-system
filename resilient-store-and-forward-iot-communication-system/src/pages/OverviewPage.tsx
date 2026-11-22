import React from 'react';
import { ArchitectureDiagram } from '../components/ArchitectureDiagram';
import type { SystemStatusResponse } from '../types/iot';

interface Props {
  status: SystemStatusResponse;
}

export const OverviewPage: React.FC<Props> = ({ status }) => {
  const { summary, latest_sensor, previous_sensor, nodes } = status;

  const tempDelta =
    latest_sensor && previous_sensor
      ? Number((latest_sensor.temperature - previous_sensor.temperature).toFixed(1))
      : null;
  const humDelta =
    latest_sensor && previous_sensor
      ? Number((latest_sensor.humidity - previous_sensor.humidity).toFixed(1))
      : null;

  const node1 = nodes.find((n) => n.node_id === 'NODE_1');
  const node2 = nodes.find((n) => n.node_id === 'NODE_2');
  const node3 = nodes.find((n) => n.node_id === 'NODE_3');

  const n1Meta = (node1?.metadata || {}) as Record<string, unknown>;
  const n2Meta = (node2?.metadata || {}) as Record<string, unknown>;
  const n3Meta = (node3?.metadata || {}) as Record<string, unknown>;

  const directCount = summary.delivered_direct_wifi ?? 0;
  const gatewayCount = summary.delivered_via_gateway ?? 0;
  const commDisplay =
    status.active_comm_mode === 'WIFI'
      ? 'DIRECT WI-FI'
      : status.active_comm_mode === 'LORA'
        ? 'LORA FALLBACK'
        : status.active_comm_mode;

  const kpis = [
    { label: 'Total Packets Created', value: summary.total_created, tone: 'text-slate-100', sub: 'Node 1 originated' },
    { label: 'Received by Node 2', value: summary.received_by_node2, tone: 'text-sky-400', sub: 'LoRa microSD (Direct bypasses)' },
    {
      label: 'Delivered to Node 3',
      value: summary.delivered_to_node3,
      tone: 'text-emerald-400',
      sub: `Direct ${directCount} · Gateway ${gatewayCount}`,
    },
    {
      label: 'Pending Packets',
      value: summary.pending_packets,
      tone: summary.pending_packets > 0 ? 'text-amber-400' : 'text-slate-100',
      sub: `LFS ${summary.pending_node1_littlefs} · SD ${summary.pending_node2_microsd}`,
    },
    { label: 'Duplicate Packets', value: summary.duplicate_packets, tone: 'text-amber-300', sub: 'Suppressed at Node 2' },
    {
      label: 'Failed Authentication',
      value: summary.failed_auth_count,
      tone: summary.failed_auth_count > 0 ? 'text-rose-400' : 'text-slate-100',
      sub: 'AES-GCM rejected',
    },
    {
      label: 'Active Comm Mode',
      value: commDisplay,
      tone:
        status.active_comm_mode === 'WIFI'
          ? 'text-sky-400'
          : status.active_comm_mode === 'LORA'
            ? 'text-amber-400'
            : 'text-rose-400',
      sub: `N2→N3 GW: ${status.node2_to_node3_status}`,
    },
    {
      label: 'Overall System Status',
      value: status.overall_status.replace(/_/g, ' '),
      tone:
        status.overall_status === 'NOMINAL'
          ? 'text-emerald-400'
          : status.overall_status === 'AWAITING_HARDWARE'
            ? 'text-slate-300'
            : 'text-amber-400',
      sub: status.is_demo_mode ? 'Demo simulation' : 'Live hardware mode',
    },
  ];

  return (
    <div className="space-y-6">
      {/* 8 Summary KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((item) => (
          <div
            key={item.label}
            className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4 flex flex-col justify-between"
          >
            <div className="text-xs text-slate-400">{item.label}</div>
            <div className={`text-2xl font-mono font-semibold tabular-nums mt-2 truncate ${item.tone}`}>
              {item.value}
            </div>
            <div className="text-[11px] font-mono text-slate-500 mt-1.5 tabular-nums">{item.sub}</div>
          </div>
        ))}
      </div>

      {/* Live Authenticated Sensor Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Temperature */}
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-200">Temperature (DHT11)</h3>
            <span className="text-xs font-mono text-slate-500">Routine Telemetry</span>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-mono font-semibold text-slate-100 tabular-nums">
              {latest_sensor ? latest_sensor.temperature.toFixed(1) : '—'}
            </span>
            <span className="text-sm font-mono text-slate-400">°C</span>
          </div>
          <div className="mt-3 pt-3 border-t border-[#1E2E4A] flex items-center justify-between text-xs font-mono text-slate-400 tabular-nums">
            <span>
              Trend:{' '}
              {tempDelta === null
                ? '—'
                : tempDelta > 0
                  ? `+${tempDelta.toFixed(1)} °C`
                  : `${tempDelta.toFixed(1)} °C`}
            </span>
            <span>
              {latest_sensor ? new Date(latest_sensor.recorded_at).toLocaleTimeString() : 'No reading'}
            </span>
          </div>
        </div>

        {/* Humidity */}
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-200">Humidity (DHT11)</h3>
            <span className="text-xs font-mono text-slate-500">Routine Telemetry</span>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-mono font-semibold text-slate-100 tabular-nums">
              {latest_sensor ? latest_sensor.humidity.toFixed(1) : '—'}
            </span>
            <span className="text-sm font-mono text-slate-400">% RH</span>
          </div>
          <div className="mt-3 pt-3 border-t border-[#1E2E4A] flex items-center justify-between text-xs font-mono text-slate-400 tabular-nums">
            <span>
              Trend:{' '}
              {humDelta === null
                ? '—'
                : humDelta > 0
                  ? `+${humDelta.toFixed(1)} %`
                  : `${humDelta.toFixed(1)} %`}
            </span>
            <span>
              {latest_sensor ? new Date(latest_sensor.recorded_at).toLocaleTimeString() : 'No reading'}
            </span>
          </div>
        </div>

        {/* Raindrop Sensor */}
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-200">Raindrop Sensor (Surface Wetness)</h3>
            <span
              className={`text-xs font-mono ${
                latest_sensor?.rain_category === 'HEAVY'
                  ? 'text-rose-400'
                  : latest_sensor?.rain_category === 'NORMAL'
                    ? 'text-amber-400'
                    : 'text-emerald-400'
              }`}
            >
              {latest_sensor
                ? latest_sensor.rain_category === 'HEAVY'
                  ? '✖ HIGH PRIORITY ALERT'
                  : '● Routine Priority'
                : 'Awaiting Data'}
            </span>
          </div>
          <div className="mt-3 flex items-baseline gap-3">
            <span className="text-3xl font-mono font-semibold text-slate-100 tabular-nums">
              {latest_sensor ? latest_sensor.rain_category : '—'}
            </span>
            <span className="text-xs font-mono text-slate-400 tabular-nums">
              Raw ADC: {latest_sensor ? latest_sensor.rain_raw : '—'}
            </span>
          </div>
          <div className="mt-3 pt-3 border-t border-[#1E2E4A] flex items-center justify-between text-xs font-mono text-slate-400 tabular-nums">
            <span>Priority: {latest_sensor ? (latest_sensor.priority === 1 ? 'P1 (High)' : 'P2 (Routine)') : '—'}</span>
            <span>Calibrated wetness class (not mm/hr)</span>
          </div>
        </div>
      </div>

      {/* Animated Architecture Diagram */}
      <ArchitectureDiagram status={status} />

      {/* Three ESP32 Node Status Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Node 1 */}
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <div className="flex items-center justify-between gap-2 pb-3 border-b border-[#1E2E4A]">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Node 1 · Sensor Transmitter</h3>
              <div className="text-xs text-slate-400 mt-0.5">ESP32 + DHT11 + Raindrop + Wi-Fi + LoRa + LittleFS</div>
            </div>
            <span
              className={`text-xs font-mono ${
                node1?.status === 'ONLINE' ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {node1?.status === 'ONLINE' ? '● Online' : `✖ ${node1?.status || 'Not Connected'}`}
            </span>
          </div>
          <dl className="mt-3 space-y-2 text-xs">
            <div className="flex justify-between">
              <dt className="text-slate-400">ESP32 Connection</dt>
              <dd className="font-mono text-slate-200">{node1?.status || 'NOT_CONNECTED'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Direct Wi-Fi (N1→N3)</dt>
              <dd className="font-mono text-slate-200">
                {String(n1Meta.wifi_status || 'NOT_CONNECTED')}
                {node1?.rssi !== null && node1?.rssi !== undefined ? ` (${node1.rssi} dBm)` : ''}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">LoRa Fallback (N1→N2)</dt>
              <dd className="font-mono text-slate-200">{String(n1Meta.lora_status || 'NOT_REPORTED')}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Sensors (DHT11 / Rain)</dt>
              <dd className="font-mono text-slate-200">
                {node1?.status === 'ONLINE' ? 'Active / Sampling' : 'Not Reported'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">LittleFS Status</dt>
              <dd className="font-mono text-slate-200">{node1?.storage_status || 'NOT_REPORTED'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Pending Local Packets</dt>
              <dd className="font-mono text-amber-300 tabular-nums">{summary.pending_node1_littlefs}</dd>
            </div>
          </dl>
        </div>

        {/* Node 2 */}
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <div className="flex items-center justify-between gap-2 pb-3 border-b border-[#1E2E4A]">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Node 2 · Fallback Gateway</h3>
              <div className="text-xs text-slate-400 mt-0.5">ESP32 + Bidirectional LoRa + Wi-Fi (N3) + 16 GB microSD</div>
            </div>
            <span
              className={`text-xs font-mono ${
                n2Meta.bypassed_on_direct_wifi
                  ? 'text-sky-400'
                  : node2?.status === 'ONLINE'
                    ? 'text-emerald-400'
                    : 'text-rose-400'
              }`}
            >
              {n2Meta.bypassed_on_direct_wifi
                ? '○ Bypassed'
                : node2?.status === 'ONLINE'
                  ? '● Online'
                  : `✖ ${node2?.status || 'Not Connected'}`}
            </span>
          </div>
          <dl className="mt-3 space-y-2 text-xs">
            <div className="flex justify-between">
              <dt className="text-slate-400">Direct Wi-Fi Role</dt>
              <dd className="font-mono text-sky-400">
                {n2Meta.bypassed_on_direct_wifi ? 'Bypassed (Standby)' : 'Active LoRa Gateway'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">LoRa Ingress (N1→N2)</dt>
              <dd className="font-mono text-slate-200">
                {String(n2Meta.lora_ingress || n2Meta.lora_transceiver || 'NOT_REPORTED')}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Wi-Fi Forward (N2→N3)</dt>
              <dd className="font-mono text-slate-200">
                {String(n2Meta.wifi_forward_to_node3 || status.node2_to_node3_status)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">microSD Status (16 GB)</dt>
              <dd className="font-mono text-slate-200">{node2?.storage_status || 'NOT_REPORTED'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Pending Node 3 Packets</dt>
              <dd className="font-mono text-amber-300 tabular-nums">{summary.pending_node2_microsd}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Ciphertext Decryption</dt>
              <dd className="font-mono text-sky-400">Never (Opaque Bytes)</dd>
            </div>
          </dl>
        </div>

        {/* Node 3 */}
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <div className="flex items-center justify-between gap-2 pb-3 border-b border-[#1E2E4A]">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Node 3 · Destination Receiver</h3>
              <div className="text-xs text-slate-400 mt-0.5">ESP32 + Wi-Fi + AES-128-GCM + I2C LCD + LittleFS</div>
            </div>
            <span
              className={`text-xs font-mono ${
                node3?.status === 'ONLINE' ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {node3?.status === 'ONLINE' ? '● Online' : `✖ ${node3?.status || 'Not Connected'}`}
            </span>
          </div>
          <dl className="mt-3 space-y-2 text-xs">
            <div className="flex justify-between">
              <dt className="text-slate-400">Wi-Fi Receiver (N1 & N2)</dt>
              <dd className="font-mono text-slate-200">{String(n3Meta.wifi_receiver || 'NOT_CONNECTED')}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">LittleFS Storage</dt>
              <dd className="font-mono text-emerald-300 tabular-nums">
                {node3?.storage_status || 'NOT_REPORTED'} ({String(n3Meta.littlefs_stored_readings ?? summary.delivered_to_node3)} saved)
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">AES-GCM Auth Engine</dt>
              <dd className="font-mono text-emerald-400">{String(n3Meta.aes_gcm || 'NOT_REPORTED')}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">I2C LCD Status</dt>
              <dd className="font-mono text-slate-200">{node3?.lcd_status || 'NOT_REPORTED'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Last Authenticated Reading</dt>
              <dd className="font-mono text-slate-200 tabular-nums">
                {latest_sensor
                  ? `${latest_sensor.temperature.toFixed(1)}°C / ${latest_sensor.humidity.toFixed(0)}% / ${latest_sensor.rain_category}`
                  : 'None'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Delivery ACKs</dt>
              <dd className="font-mono text-emerald-400 tabular-nums">
                Direct {directCount} · Stage-2 {gatewayCount}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
};
