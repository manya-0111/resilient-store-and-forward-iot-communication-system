import React, { useEffect, useState } from 'react';
import { Cpu } from 'lucide-react';
import { iotApi } from '../services/api';
import type { NodeRecord, SystemStatusResponse } from '../types/iot';

interface Props {
  status: SystemStatusResponse;
  refreshTick: number;
}

const NODE1_PINS = [
  { device: 'Raindrop AO', pin: 'GPIO 34', notes: 'ADC input; ensure analog output never exceeds 3.3 V ESP32 ADC range.' },
  { device: 'DHT11 DATA', pin: 'GPIO 4', notes: 'Use pull-up resistor if required by sensor module/library.' },
  { device: 'LoRa NSS / CS', pin: 'GPIO 5', notes: 'SPI chip select (fallback LoRa link to Node 2).' },
  { device: 'LoRa SCK / MISO / MOSI', pin: 'GPIO 18 / 19 / 23', notes: 'VSPI default pins on ESP32 DevKit V1.' },
  { device: 'LoRa RST / DIO0', pin: 'GPIO 14 / 26', notes: 'Bidirectional LoRa RX/TX events for Scenario B Stage-1 ACKs.' },
  { device: 'Wi-Fi + LittleFS', pin: 'Internal RF / Flash', notes: 'Preferred Direct Wi-Fi to Node 3; LittleFS retains packets when offline.' },
];

const NODE2_PINS = [
  { device: 'LoRa NSS / CS', pin: 'GPIO 5', notes: 'Separate SPI chip select from microSD (LoRa ingress from Node 1).' },
  { device: 'microSD CS', pin: 'GPIO 13', notes: 'Must be different from LoRa CS (16 GB FAT32 store-and-forward buffer).' },
  { device: 'Shared SCK / MISO / MOSI', pin: 'GPIO 18 / 19 / 23', notes: 'Shared SPI bus (confirm library support).' },
  { device: 'LoRa RST / DIO0', pin: 'GPIO 14 / 26', notes: 'Bidirectional LoRa transceiver sends Stage-1 storage ACKs to Node 1.' },
  { device: 'Wi-Fi Forwarder', pin: 'Internal RF', notes: 'Forwards microSD-buffered ciphertext to Node 3 only (NODE2_NODE3_WIFI). Bypassed on Direct Wi-Fi.' },
];

const NODE3_PINS = [
  { device: 'I2C LCD SDA', pin: 'GPIO 21', notes: 'ESP32 default I2C SDA (authenticated reading display).' },
  { device: 'I2C LCD SCL', pin: 'GPIO 22', notes: 'ESP32 default I2C SCL.' },
  { device: 'Wi-Fi Receiver', pin: 'Internal RF', notes: 'Receives Direct Wi-Fi from Node 1 (Scenario A) and Gateway Wi-Fi from Node 2 (Scenario B).' },
  { device: 'LittleFS Flash Storage', pin: 'Internal Flash', notes: 'Persists verified sensor readings, sequence state, and LCD recovery cache.' },
  { device: 'VCC / GND', pin: '3.3 V / 5 V + Level Shifter', notes: 'A 5 V backpack may pull SDA/SCL to 5 V; use level shifter to protect 3.3 V GPIOs.' },
];

export const HardwareStatusPage: React.FC<Props> = ({ status, refreshTick }) => {
  const [hwNodes, setHwNodes] = useState<NodeRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let active = true;
    iotApi
      .getNodes('hardware')
      .then((res) => {
        if (active) {
          setHwNodes(res.nodes);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load hardware node heartbeats.');
        }
      });
    return () => {
      active = false;
    };
  }, [refreshTick, retryCount]);

  const displayedNodes = hwNodes ?? (status.mode === 'hardware' ? status.nodes : []);
  const apiOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://<server-host>:3000';

  const formatHeartbeatAge = (iso: string | null) => {
    if (!iso) return 'Never connected';
    const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    return `${new Date(iso).toLocaleTimeString()} (${diffSec}s ago)`;
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-rose-950/50 border border-rose-700/60 rounded-xl px-4 py-3 flex items-center justify-between gap-4 text-xs">
          <span className="font-mono text-rose-300">Hardware Nodes API Error: {error}</span>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-3 py-1 rounded-md bg-rose-700 hover:bg-rose-600 text-white font-medium whitespace-nowrap cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Live Heartbeat Telemetry (Physical ESP32 Hardware Mode) */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 pb-4 border-b border-[#1E2E4A]">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-sky-400" />
            <h2 className="text-base font-semibold text-slate-100">
              Physical ESP32 Hardware Heartbeat Monitor (GET /api/nodes?mode=hardware)
            </h2>
          </div>
          <span className="text-xs font-mono text-slate-400">
            Online ≤ 25s · Stale 26–90s · Offline &gt; 90s · Not Connected = Never Reported
          </span>
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          {displayedNodes.map((node) => {
            const stColor =
              node.status === 'ONLINE'
                ? 'text-emerald-400'
                : node.status === 'STALE_DATA'
                  ? 'text-amber-400'
                  : 'text-rose-400';
            const storageLabel =
              node.node_id === 'NODE_1'
                ? 'LittleFS'
                : node.node_id === 'NODE_2'
                  ? '16 GB microSD'
                  : 'LittleFS';
            return (
              <div key={node.node_id} className="p-4 rounded-lg bg-[#0B1324] border border-[#1E2E4A] space-y-2">
                <div className="flex items-center justify-between font-mono">
                  <span className="text-slate-100 font-semibold">{node.node_id}</span>
                  <span className={stColor}>{node.status}</span>
                </div>
                <div className="text-slate-400">{node.role}</div>
                <div className="pt-2 border-t border-[#1E2E4A] font-mono text-[11px] text-slate-400 space-y-1 tabular-nums">
                  <div>Link Mode: {node.link_mode}</div>
                  <div>
                    Storage ({storageLabel}): {node.storage_status}
                  </div>
                  <div>Queue Count: {node.queue_count}</div>
                  <div>Last Heartbeat: {formatHeartbeatAge(node.last_heartbeat)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Hardware Reference Pin Plan */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-6 space-y-6">
        <div>
          <h3 className="text-base font-semibold text-slate-100">
            Hardware Reference Pin Plan — 3-ESP32 Dual-Path Topology (ESP32 DevKit V1)
          </h3>
          <p className="text-xs text-amber-300 mt-1">
            Warning: ESP32 GPIOs are strictly 3.3 V logic. Node 1 sends Direct Wi-Fi to Node 3 when available and falls back to bidirectional LoRa → Node 2 (microSD) → Wi-Fi → Node 3. Node 1 & Node 3 use LittleFS; Node 2 uses 16 GB microSD.
          </p>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          {[
            { title: 'Node 1 — Sensors, Wi-Fi, LoRa & LittleFS', rows: NODE1_PINS },
            { title: 'Node 2 — LoRa Gateway, microSD & Wi-Fi Forward', rows: NODE2_PINS },
            { title: 'Node 3 — Wi-Fi Receiver, I2C LCD & LittleFS', rows: NODE3_PINS },
          ].map((group) => (
            <div key={group.title} className="rounded-lg bg-[#0B1324] border border-[#1E2E4A] overflow-hidden">
              <div className="px-4 py-3 border-b border-[#1E2E4A] text-xs font-semibold text-slate-200">
                {group.title}
              </div>
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[#1E2E4A] text-slate-400">
                    <th className="py-2 px-3">Device / Subsystem</th>
                    <th className="py-2 px-3">ESP32</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E2E4A]">
                  {group.rows.map((r) => (
                    <tr key={r.device}>
                      <td className="py-2 px-3 align-top">
                        <div className="text-slate-200 font-medium">{r.device}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">{r.notes}</div>
                      </td>
                      <td className="py-2 px-3 align-top font-mono text-sky-300 whitespace-nowrap">
                        {r.pin}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>

      {/* Live ESP32 Firmware HTTP POST Integration Guide */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-6 space-y-3">
        <h3 className="text-sm font-semibold text-slate-100">
          ESP32 Live Hardware Mode API Ingestion Contract
        </h3>
        <p className="text-xs text-slate-400">
          Switch to <strong className="text-slate-200">Live Hardware Mode</strong> in Settings and point your ESP32 HTTPClient calls to these endpoints. Hardware telemetry is tagged <span className="font-mono text-emerald-400">ESP32_HARDWARE</span> and isolated from Simulation data. Always specify accurate <span className="font-mono text-sky-300">rssi_source</span> (<span className="font-mono">AP_STATION_RSSI</span> vs <span className="font-mono">PEER_TO_PEER_RSSI</span> vs <span className="font-mono">LORA_PKT_RSSI</span>).
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 font-mono text-[11px]">
          <pre className="p-3.5 rounded-lg bg-[#080E1A] border border-[#1E2E4A] text-slate-300 overflow-x-auto">
{`POST ${apiOrigin}/api/node1/packet
{
  "version": 1, "source": 1, "destination": 3,
  "packet_id": 101, "priority": 1,
  "comm_mode": "WIFI",
  "route_path": "DIRECT_WIFI",
  "nonce": "<24-hex>",
  "ciphertext": "<hex>",
  "tag": "<32-hex>"
}
# Or POST /api/network-metrics with
# link_hop: NODE1_NODE3_WIFI | NODE1_NODE2_LORA`}
          </pre>
          <pre className="p-3.5 rounded-lg bg-[#080E1A] border border-[#1E2E4A] text-slate-300 overflow-x-auto">
{`POST ${apiOrigin}/api/node2/network-metrics
{
  "link_hop": "NODE2_NODE3_WIFI",
  "rssi": -64,
  "rssi_source": "AP_STATION_RSSI",
  "rssi_variation": 2.1,
  "packet_loss_ratio": 0.04,
  "ack_latency_ms": 78,
  "retry_count": 0,
  "queue_depth": 1,
  "node2_to_node3_status": "CONNECTED"
}`}
          </pre>
          <pre className="p-3.5 rounded-lg bg-[#080E1A] border border-[#1E2E4A] text-slate-300 overflow-x-auto">
{`POST ${apiOrigin}/api/node3/packet-received
{
  "packet_id": 101, "route_path": "DIRECT_WIFI",
  "authenticated": true,
  "temperature": 28.5, "humidity": 65.0,
  "rain_raw": 850, "lcd_status": "ACTIVE",
  "littlefs_status": "MOUNTED"
}
# Dedicated LittleFS health update:
# POST /api/node3/storage-status`}
          </pre>
        </div>
      </div>
    </div>
  );
};
