import React from 'react';
import type { SystemStatusResponse } from '../types/iot';

interface Props {
  status: SystemStatusResponse;
}

export const ArchitectureDiagram: React.FC<Props> = ({ status }) => {
  const node1 = status.nodes.find((n) => n.node_id === 'NODE_1');
  const node2 = status.nodes.find((n) => n.node_id === 'NODE_2');
  const node3 = status.nodes.find((n) => n.node_id === 'NODE_3');

  const n2Meta = (node2?.metadata || {}) as Record<string, unknown>;
  const n3Meta = (node3?.metadata || {}) as Record<string, unknown>;

  const directLink = status.links?.node1_node3_wifi;
  const loraLink = status.links?.node1_node2_lora;
  const gwLink = status.links?.node2_node3_wifi;

  const commMode = status.active_comm_mode; // WIFI | LORA | OFFLINE | NOT_CONNECTED
  const directActive = directLink ? directLink.active : commMode === 'WIFI';
  const loraActive = loraLink ? loraLink.active : commMode === 'LORA';
  const offlineActive = commMode === 'OFFLINE';
  const gwLinkStatus = gwLink?.status || status.node2_to_node3_status;
  const gwForwardActive = gwLinkStatus === 'CONNECTED' || gwLinkStatus === 'RETRYING';
  const node2Bypassed = Boolean(n2Meta.bypassed_on_direct_wifi ?? (directActive && status.summary.pending_node2_microsd === 0));

  const directDeliveryCount = status.summary.delivered_direct_wifi ?? 0;
  const gwDeliveryCount = status.summary.delivered_via_gateway ?? 0;

  const directColor = directActive
    ? 'text-sky-400'
    : directLink?.status === 'DEGRADED'
      ? 'text-amber-400'
      : 'text-rose-400';

  const loraColor = loraActive
    ? 'text-amber-400'
    : loraLink?.status === 'STANDBY'
      ? 'text-slate-400'
      : 'text-rose-400';

  const gwColor =
    gwLinkStatus === 'CONNECTED'
      ? 'text-emerald-400'
      : gwLinkStatus === 'RETRYING'
        ? 'text-amber-400'
        : 'text-rose-400';

  return (
    <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4 pb-5 border-b border-[#1E2E4A]">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Three-Node Dual-Path Resilient IoT Architecture
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Preferred: Direct Wi-Fi (Node 1 → Node 3, bypassing Node 2) · Fallback: LoRa → Node 2 microSD → Wi-Fi → Node 3 · Offline: Node 1 LittleFS
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs font-mono tabular-nums">
          <span className={directActive ? 'text-sky-400' : 'text-slate-400'}>
            Scenario A: Direct N3→N1 ACK
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className={loraActive ? 'text-amber-400' : 'text-slate-400'}>
            Scenario B: Stage-1 (N2) + Stage-2 (N3) ACK
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className={offlineActive ? 'text-rose-400' : 'text-slate-400'}>
            Scenario C: LittleFS Retain
          </span>
        </div>
      </div>

      {/* PREFERRED PATH (SCENARIO A): Direct Wi-Fi Node 1 -> Node 3 (Bypassing Node 2) */}
      <div
        className={`mt-5 rounded-lg p-3.5 border transition-colors ${
          directActive
            ? 'bg-sky-950/20 border-sky-700/60'
            : 'bg-[#0B1324] border-[#1E2E4A]'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sky-400 font-semibold">PREFERRED PATH · SCENARIO A</span>
            <span className="text-slate-500">·</span>
            <span className="text-slate-200">NODE1_NODE3_WIFI (Direct Wi-Fi, Node 2 Bypassed)</span>
          </div>
          <span className={`font-semibold ${directColor}`}>
            {directActive
              ? '● ACTIVE — BYPASSING NODE 2'
              : `✖ ${directLink?.status || (commMode === 'NOT_CONNECTED' ? 'NOT_CONNECTED' : 'OFFLINE')}`}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-1 lg:grid-cols-[150px_1fr_150px] items-center gap-3">
          <div className="text-xs font-mono text-sky-300">Node 1 (Wi-Fi TX)</div>
          <div className="flex flex-col items-center">
            <div className="relative w-full h-2.5 flex items-center">
              <div
                className={`w-full h-px ${
                  directActive
                    ? 'bg-sky-400/70'
                    : 'bg-slate-700 border-t border-dashed border-slate-600'
                }`}
              />
              {directActive && (
                <div className="absolute inset-0 overflow-hidden">
                  <div
                    className="w-4 h-1.5 rounded-sm mt-0.5 bg-sky-400"
                    style={{ animation: 'packetFlowRight 1.9s linear infinite' }}
                  />
                </div>
              )}
            </div>
            <div className="relative w-full h-2 mt-1 flex items-center">
              <div className={`w-full h-px ${directActive ? 'bg-emerald-600/70' : 'bg-slate-800'}`} />
              {directActive && (
                <div className="absolute inset-0 overflow-hidden">
                  <div
                    className="w-3 h-1 rounded-sm mt-0.5 bg-emerald-300"
                    style={{ animation: 'packetFlowLeft 2.1s linear infinite' }}
                  />
                </div>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-3 text-[10px] font-mono">
              <span className={directActive ? 'text-sky-300' : 'text-slate-500'}>
                AES-128-GCM Ciphertext → Direct to Node 3 (Zero microSD writes)
              </span>
              <span className="text-slate-600">|</span>
              <span className={directActive ? 'text-emerald-400' : 'text-slate-500'}>
                ← Direct Delivery ACK (Node 3 → Node 1)
              </span>
            </div>
          </div>
          <div className="text-xs font-mono text-emerald-300 lg:text-right">
            Node 3 (Wi-Fi RX)
          </div>
        </div>
      </div>

      {/* FALLBACK PATH (SCENARIO B) + THREE NODES + OBSERVER LAYER */}
      <div className="mt-5 grid grid-cols-1 lg:grid-cols-[1fr_115px_1fr_115px_1fr_84px_1fr] items-center gap-3">
        {/* NODE 1 */}
        <div
          className={`p-4 rounded-lg bg-[#0B1324] border ${
            offlineActive ? 'border-rose-600/70' : 'border-[#1E2E4A]'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-mono text-sky-400">NODE 1</span>
            <span
              className={`text-xs font-mono ${
                node1?.status === 'ONLINE' ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {node1?.status === 'ONLINE' ? '● Online' : `✖ ${node1?.status || 'Offline'}`}
            </span>
          </div>
          <h3 className="text-sm font-semibold text-slate-100 mt-1.5">Sensor & Transmitter</h3>
          <div className="mt-2.5 space-y-1 text-xs text-slate-400">
            <div>DHT11 + Raindrop · Wi-Fi + LoRa</div>
            <div>AES-128-GCM Encrypt (96-bit Nonce)</div>
            <div
              className={`font-mono tabular-nums pt-1 ${
                status.summary.pending_node1_littlefs > 0 || offlineActive
                  ? 'text-amber-300'
                  : 'text-slate-300'
              }`}
            >
              LittleFS ({node1?.storage_status || 'N/A'}): {status.summary.pending_node1_littlefs} pending
            </div>
            {offlineActive && (
              <div className="text-[11px] font-mono text-rose-400 pt-0.5">
                ✖ Scenario C: Local LittleFS Retention
              </div>
            )}
          </div>
        </div>

        {/* LINK 2: NODE 1 -> NODE 2 (LoRa Fallback) */}
        <div className="flex flex-col items-center justify-center py-2">
          <div className={`text-[11px] font-mono font-medium text-center ${loraColor}`}>
            {loraActive
              ? 'LoRa Fallback'
              : loraLink?.status === 'STANDBY'
                ? 'LoRa Standby'
                : 'LoRa Offline'}
          </div>
          <div className="relative w-full h-2.5 my-1.5 flex items-center">
            <div
              className={`w-full h-px ${
                loraActive
                  ? 'bg-amber-500/70'
                  : 'bg-slate-700 border-t border-dashed border-slate-600'
              }`}
            />
            {loraActive && (
              <div className="absolute inset-0 overflow-hidden">
                <div
                  className="w-3 h-1.5 rounded-sm mt-0.5 bg-amber-400"
                  style={{ animation: 'packetFlowRight 2.1s linear infinite' }}
                />
              </div>
            )}
          </div>
          <div className="relative w-full h-2 flex items-center">
            <div className={`w-full h-px ${loraActive ? 'bg-amber-700/70' : 'bg-slate-800'}`} />
            {loraActive && (
              <div className="absolute inset-0 overflow-hidden">
                <div
                  className="w-2.5 h-1 rounded-sm mt-0.5 bg-amber-300"
                  style={{ animation: 'packetFlowLeft 2.4s linear infinite' }}
                />
              </div>
            )}
          </div>
          <div className="text-[10px] font-mono text-slate-400 mt-1 text-center">
            ← Stage-1 Storage ACK
          </div>
        </div>

        {/* NODE 2 */}
        <div
          className={`p-4 rounded-lg bg-[#0B1324] border ${
            loraActive || status.summary.pending_node2_microsd > 0
              ? 'border-amber-600/60'
              : 'border-[#1E2E4A]'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-mono text-blue-400">NODE 2</span>
            <span
              className={`text-xs font-mono ${
                node2Bypassed
                  ? 'text-sky-400'
                  : node2?.status === 'ONLINE'
                    ? 'text-emerald-400'
                    : 'text-rose-400'
              }`}
            >
              {node2Bypassed
                ? '○ Bypassed (Standby)'
                : node2?.status === 'ONLINE'
                  ? '● Active GW'
                  : `✖ ${node2?.status || 'Offline'}`}
            </span>
          </div>
          <h3 className="text-sm font-semibold text-slate-100 mt-1.5">Fallback Gateway</h3>
          <div className="mt-2.5 space-y-1 text-xs text-slate-400">
            <div>LoRa RX (N1) · Wi-Fi TX (N3 Only)</div>
            <div>Deduplicate · Never Decrypts</div>
            <div className="font-mono text-slate-300 tabular-nums pt-1">
              microSD: {status.summary.received_by_node2} stored · {status.summary.pending_node2_microsd} queued
            </div>
          </div>
        </div>

        {/* LINK 3: NODE 2 -> NODE 3 (Gateway Wi-Fi — ML Target) */}
        <div className="flex flex-col items-center justify-center py-2">
          <div className={`text-[11px] font-mono font-medium text-center ${gwColor}`}>
            {gwLinkStatus === 'CONNECTED'
              ? 'GW Wi-Fi'
              : gwLinkStatus === 'RETRYING'
                ? 'Retrying'
                : 'Disconnected'}
          </div>
          <div className="relative w-full h-2.5 my-1.5 flex items-center">
            <div
              className={`w-full h-px ${
                gwForwardActive
                  ? 'bg-emerald-500/60'
                  : 'bg-rose-500/40 border-t border-dashed border-rose-500/60'
              }`}
            />
            {gwForwardActive && (loraActive || status.summary.pending_node2_microsd > 0) && (
              <div className="absolute inset-0 overflow-hidden">
                <div
                  className="w-3 h-1.5 rounded-sm mt-0.5 bg-emerald-400"
                  style={{ animation: 'packetFlowRight 2.2s linear infinite' }}
                />
              </div>
            )}
          </div>
          <div className="relative w-full h-2 flex items-center">
            <div className={`w-full h-px ${gwForwardActive ? 'bg-emerald-700/70' : 'bg-slate-800'}`} />
            {gwForwardActive && (loraActive || status.summary.pending_node2_microsd > 0) && (
              <div className="absolute inset-0 overflow-hidden">
                <div
                  className="w-2.5 h-1 rounded-sm mt-0.5 bg-emerald-300"
                  style={{ animation: 'packetFlowLeft 2.5s linear infinite' }}
                />
              </div>
            )}
          </div>
          <div className="text-[10px] font-mono text-emerald-400/90 mt-1 text-center">
            ← Stage-2 Delivery ACK
          </div>
          <div className="text-[9px] font-mono text-indigo-400 mt-0.5 text-center">
            ML Target Link
          </div>
        </div>

        {/* NODE 3 */}
        <div className="p-4 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-mono text-emerald-400">NODE 3</span>
            <span
              className={`text-xs font-mono ${
                node3?.status === 'ONLINE' ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {node3?.status === 'ONLINE' ? '● Online' : `✖ ${node3?.status || 'Offline'}`}
            </span>
          </div>
          <h3 className="text-sm font-semibold text-slate-100 mt-1.5">Destination Receiver</h3>
          <div className="mt-2.5 space-y-1 text-xs text-slate-400">
            <div>AES-128-GCM Verify · I2C LCD</div>
            <div className="font-mono text-slate-300 tabular-nums">
              LittleFS ({node3?.storage_status || 'NOT_REPORTED'}): {String(n3Meta.littlefs_stored_readings ?? status.summary.delivered_to_node3)} saved
            </div>
            <div className="font-mono text-emerald-300 tabular-nums pt-0.5">
              Direct {directDeliveryCount} · GW {gwDeliveryCount} · Rej {status.summary.failed_auth_count}
            </div>
          </div>
        </div>

        {/* LINK 3 -> ANALYTICS */}
        <div className="flex flex-col items-center justify-center py-2">
          <div className="text-[11px] font-mono text-slate-400">HTTP POST</div>
          <div className="relative w-full h-2.5 my-1.5 flex items-center">
            <div className="w-full h-px bg-blue-500/50" />
            {(directActive || gwForwardActive) && (
              <div className="absolute inset-0 overflow-hidden">
                <div
                  className="w-2.5 h-1.5 rounded-sm mt-0.5 bg-blue-400"
                  style={{ animation: 'packetFlowRight 2.6s linear infinite' }}
                />
              </div>
            )}
          </div>
          <div className="text-[10px] font-mono text-slate-500 text-center">
            Observer
          </div>
        </div>

        {/* SERVER + ML + DASHBOARD */}
        <div className="p-4 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-mono text-indigo-400">ANALYTICS</span>
            <span className="text-xs font-mono text-emerald-400">● Active</span>
          </div>
          <h3 className="text-sm font-semibold text-slate-100 mt-1.5">API · SQLite · ML</h3>
          <div className="mt-2.5 space-y-1 text-xs text-slate-400">
            <div>3 Independent Link Streams</div>
            <div>Advisory ML (N2→N3 Wi-Fi)</div>
            <div className="font-mono text-slate-300 pt-1">
              Never controls ACKs / routing
            </div>
          </div>
        </div>
      </div>

      {/* Explicit semantic rule bar */}
      <div className="mt-5 pt-4 border-t border-[#1E2E4A] grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
        <div className="flex items-start gap-2 text-slate-300">
          <span className="font-mono text-sky-400 shrink-0">Scenario A:</span>
          <span className="text-slate-400">
            Preferred Direct Wi-Fi (<span className="font-mono text-slate-300">N1→N3</span>) completely bypasses Node 2 and microSD. Node 3 verifies AES-GCM, saves to Node 3 LittleFS, and returns a direct <span className="font-mono text-emerald-300">N3→N1</span> ACK.
          </span>
        </div>
        <div className="flex items-start gap-2 text-slate-300">
          <span className="font-mono text-amber-400 shrink-0">Scenario B:</span>
          <span className="text-slate-400">
            LoRa fallback (<span className="font-mono text-slate-300">N1→N2</span>) flushes opaque ciphertext to Node 2 microSD (Stage-1 <span className="font-mono text-slate-300">N2→N1</span> ACK), then forwards over <span className="font-mono text-slate-300">N2→N3</span> Wi-Fi until Node 3 returns Stage-2 <span className="font-mono text-emerald-300">N3→N2</span> ACK.
          </span>
        </div>
        <div className="flex items-start gap-2 text-slate-300">
          <span className="font-mono text-rose-400 shrink-0">Scenario C:</span>
          <span className="text-slate-400">
            When both Direct Wi-Fi and LoRa are unavailable, Node 1 retains unacknowledged encrypted packets in <span className="font-mono text-slate-300">LittleFS</span> and replays them automatically upon link recovery.
          </span>
        </div>
      </div>
    </div>
  );
};
