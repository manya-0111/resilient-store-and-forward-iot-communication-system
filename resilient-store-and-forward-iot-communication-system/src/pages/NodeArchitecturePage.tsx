import React, { useEffect, useState } from 'react';
import { iotApi } from '../services/api';
import type { PacketRecord, SystemStatusResponse } from '../types/iot';

interface Props {
  status: SystemStatusResponse;
  refreshTick: number;
}

export const NodeArchitecturePage: React.FC<Props> = ({ status, refreshTick }) => {
  const [recentPackets, setRecentPackets] = useState<PacketRecord[]>([]);
  const [activeTab, setActiveTab] = useState<'ALL' | 'NODE_1' | 'NODE_2' | 'NODE_3'>('ALL');
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let active = true;
    iotApi
      .getPackets({ mode: status.mode })
      .then((res) => {
        if (active) {
          setRecentPackets(res.packets.slice(0, 12));
          setError(null);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load node packet telemetry.');
        }
      });
    return () => {
      active = false;
    };
  }, [status.mode, refreshTick, retryCount]);

  const node1 = status.nodes.find((n) => n.node_id === 'NODE_1');
  const node2 = status.nodes.find((n) => n.node_id === 'NODE_2');
  const node3 = status.nodes.find((n) => n.node_id === 'NODE_3');
  const n1 = (node1?.metadata || {}) as Record<string, unknown>;
  const n2 = (node2?.metadata || {}) as Record<string, unknown>;
  const n3 = (node3?.metadata || {}) as Record<string, unknown>;

  const latestPkt = recentPackets[0];
  const node1Connected = node1?.status === 'ONLINE' || node1?.status === 'STALE_DATA';
  const node2Connected = node2?.status === 'ONLINE' || node2?.status === 'STALE_DATA';
  const node2Bypassed = Boolean(n2.bypassed_on_direct_wifi);
  const directDelivered = status.summary.delivered_direct_wifi ?? 0;
  const gwDelivered = status.summary.delivered_via_gateway ?? 0;

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-rose-950/50 border border-rose-700/60 rounded-xl px-4 py-3 flex items-center justify-between gap-4 text-xs">
          <span className="font-mono text-rose-300">Node Architecture API Error: {error}</span>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-3 py-1 rounded-md bg-rose-700 hover:bg-rose-600 text-white font-medium whitespace-nowrap cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Node Focus Segmented Filter */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Three-Node ESP32 Architecture Telemetry</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Scenario A Direct Wi-Fi (N1→N3) bypasses Node 2 · Scenario B LoRa fallback routes through Node 2 microSD without decryption · Node 1 & Node 3 are exclusive AES-128-GCM endpoints
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#111C30] border border-[#1E2E4A] rounded-lg">
          {(['ALL', 'NODE_1', 'NODE_2', 'NODE_3'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === tab
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {tab === 'ALL' ? 'All Nodes' : tab.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {/* NODE 1 */}
      {(activeTab === 'ALL' || activeTab === 'NODE_1') && (
        <section className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2 pb-4 border-b border-[#1E2E4A]">
            <div>
              <h3 className="text-base font-semibold text-slate-100">
                Node 1 — Sensor & Dual-Path Transmitter (ESP32)
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Reads DHT11 & Raindrop sensors, encrypts once with AES-128-GCM, transmits Direct Wi-Fi to Node 3 (preferred), falls back to LoRa→Node 2, or retains locally in LittleFS when offline
              </p>
            </div>
            <span
              className={`text-xs font-mono ${
                node1?.status === 'ONLINE' ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {node1?.status === 'ONLINE' ? '● ONLINE' : `✖ ${node1?.status || 'NOT_CONNECTED'}`}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            <div className="p-3.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
              <div className="text-slate-400">Latest Packet Generated</div>
              <div className="font-mono text-base text-slate-100 mt-1 tabular-nums">
                {latestPkt ? `#${latestPkt.packet_id}` : '—'}
              </div>
              <div className="font-mono text-[11px] text-slate-500 mt-1">
                {latestPkt
                  ? `${latestPkt.route_path || latestPkt.comm_mode} · ${latestPkt.priority === 1 ? 'P1 Heavy Rain' : 'P2 Routine'}`
                  : '—'}
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
              <div className="text-slate-400">Active Transmit Path</div>
              <div className="font-mono text-base text-sky-400 mt-1">
                {status.active_comm_mode === 'WIFI'
                  ? 'DIRECT_WIFI (N1→N3)'
                  : status.active_comm_mode === 'LORA'
                    ? 'LORA_FALLBACK (N1→N2)'
                    : status.active_comm_mode}
              </div>
              <div className="font-mono text-[11px] text-slate-500 mt-1">
                Wi-Fi: {String(n1.wifi_status || 'N/A')} · LoRa: {String(n1.lora_status || 'N/A')}
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
              <div className="text-slate-400">Encryption Endpoint</div>
              <div
                className={`font-mono text-base mt-1 ${
                  node1Connected ? 'text-emerald-400' : 'text-slate-400'
                }`}
              >
                {node1Connected ? String(n1.encryption || 'AES-128-GCM') : 'NOT_CONNECTED'}
              </div>
              <div className="font-mono text-[11px] text-slate-500 mt-1">
                {node1Connected
                  ? 'Unique 96-bit nonce · Retries reuse ciphertext'
                  : 'Awaiting Node 1 ESP32 packet telemetry'}
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
              <div className="text-slate-400">Node 1 LittleFS Queue</div>
              <div className="font-mono text-base text-amber-400 mt-1 tabular-nums">
                {status.summary.pending_node1_littlefs} pending
              </div>
              <div className="font-mono text-[11px] text-slate-500 mt-1 tabular-nums">
                {node1?.storage_status || 'NOT_REPORTED'} · Seq #{String(n1.sequence_counter ?? status.simulation?.sequence_counter ?? 0)}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* NODE 2 */}
      {(activeTab === 'ALL' || activeTab === 'NODE_2') && (
        <section className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2 pb-4 border-b border-[#1E2E4A]">
            <div>
              <h3 className="text-base font-semibold text-slate-100">
                Node 2 — Fallback Store-and-Forward Gateway (ESP32)
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Receives LoRa fallback packets from Node 1, deduplicates, flushes ciphertext to 16 GB microSD before Stage-1 ACK (N2→N1), and forwards over Wi-Fi to Node 3 only. Bypassed during Direct Wi-Fi.
              </p>
            </div>
            <span className="text-xs font-mono text-sky-400">
              {node2Bypassed
                ? '○ Bypassed on Direct Wi-Fi · Zero-Knowledge Standby'
                : 'Zero-Knowledge Forwarding · Never Decrypts Payload'}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            <div className="p-3.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
              <div className="text-slate-400">LoRa Stored (microSD)</div>
              <div className="font-mono text-base text-sky-400 mt-1 tabular-nums">
                {status.summary.received_by_node2}
              </div>
              <div className="font-mono text-[11px] text-slate-500 mt-1">
                SD: {node2?.storage_status || 'NOT_REPORTED'} · Direct Wi-Fi bypasses SD
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
              <div className="text-slate-400">Duplicate Suppression</div>
              <div className="font-mono text-base text-amber-300 mt-1 tabular-nums">
                {status.summary.duplicate_packets} suppressed
              </div>
              <div className="font-mono text-[11px] text-slate-500 mt-1">
                Re-ACKs Node 1 (Stage-1) without double-storing
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
              <div className="text-slate-400">Node 3 Forward Queue</div>
              <div className="font-mono text-base text-amber-400 mt-1 tabular-nums">
                {status.summary.pending_node2_microsd} queued
              </div>
              <div className="font-mono text-[11px] text-slate-500 mt-1">
                NODE2_NODE3_WIFI: {status.node2_to_node3_status}
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
              <div className="text-slate-400">Radio Interfaces</div>
              <div className="font-mono text-base text-slate-100 mt-1">
                {node2Connected
                  ? `LoRa RX · Wi-Fi TX (N3)`
                  : 'NOT_CONNECTED'}
              </div>
              <div className="font-mono text-[11px] text-slate-500 mt-1">
                LoRa: {String(n2.lora_ingress || n2.lora_transceiver || 'NOT_REPORTED')} · GW Wi-Fi:{' '}
                {String(n2.wifi_forward_to_node3 || status.node2_to_node3_status)}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* NODE 3 */}
      {(activeTab === 'ALL' || activeTab === 'NODE_3') && (
        <section className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2 pb-4 border-b border-[#1E2E4A]">
            <div>
              <h3 className="text-base font-semibold text-slate-100">
                Node 3 — Destination Receiver, LCD & LittleFS Storage (ESP32)
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Accepts Direct Wi-Fi from Node 1 (Scenario A) and Gateway Wi-Fi from Node 2 (Scenario B), verifies AES-128-GCM tag & AAD, persists verified data to Node 3 LittleFS, updates I2C LCD, and sends matching ACKs
              </p>
            </div>
            <span
              className={`text-xs font-mono ${
                node3?.status === 'ONLINE' ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {node3?.status === 'ONLINE' ? '● ONLINE' : `✖ ${node3?.status || 'NOT_CONNECTED'}`}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-5 items-stretch">
            {/* Realistic I2C 16x2 Hardware LCD Module Representation */}
            <div className="p-4 rounded-lg bg-[#06121A] border border-[#234357] flex flex-col justify-between">
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span>I2C 16×2 LCD (SDA 21 / SCL 22)</span>
                <span className="text-emerald-400">{node3?.lcd_status || 'STANDBY'}</span>
              </div>
              <div className="my-3 p-3.5 rounded bg-[#0A251B] border border-[#144734] font-mono text-base tracking-wider text-emerald-300 leading-relaxed">
                <div>{String(n3.lcd_line1 || 'AWAITING AUTH')}</div>
                <div>{String(n3.lcd_line2 || 'PACKET DATA')}</div>
              </div>
              <div className="text-[11px] text-slate-400">
                Invalid/tampered packets are rejected prior to LittleFS write & LCD update.
              </div>
            </div>

            <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
              <div className="p-3.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
                <div className="text-slate-400">AES-128-GCM Delivered</div>
                <div className="font-mono text-xl text-emerald-400 mt-1 tabular-nums">
                  {status.summary.delivered_to_node3}
                </div>
                <div className="font-mono text-[11px] text-slate-500 mt-1 tabular-nums">
                  Direct {directDelivered} · GW {gwDelivered}
                </div>
              </div>

              <div className="p-3.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
                <div className="text-slate-400">Node 3 LittleFS Storage</div>
                <div
                  className={`font-mono text-xl mt-1 ${
                    node3?.storage_status === 'MOUNTED' ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                >
                  {node3?.storage_status || 'NOT_REPORTED'}
                </div>
                <div className="font-mono text-[11px] text-slate-500 mt-1 tabular-nums">
                  {String(n3.littlefs_stored_readings ?? status.summary.delivered_to_node3)} verified readings saved
                </div>
              </div>

              <div className="p-3.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
                <div className="text-slate-400">Rejected / Auth Failures</div>
                <div className="font-mono text-xl text-rose-400 mt-1 tabular-nums">
                  {status.summary.failed_auth_count}
                </div>
                <div className="font-mono text-[11px] text-slate-500 mt-1">
                  No LCD / LittleFS write · No ACK
                </div>
              </div>

              <div className="p-3.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A] sm:col-span-3">
                <div className="text-slate-400">Dual-Path ACK & Non-Blocking Analytics Resilience</div>
                <div className="text-slate-200 mt-1">
                  Node 3 returns Direct ACKs (N3→N1) for Scenario A packets and Stage-2 Delivery ACKs (N3→N2) for Scenario B gateway packets, while persisting verified readings to Node 3 LittleFS and forwarding copies over HTTP POST to the SQLite backend. If the dashboard server is offline, LCD display, LittleFS logging, and hardware ACKs continue uninterrupted.
                </div>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
};
