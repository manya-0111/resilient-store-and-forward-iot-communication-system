import React, { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { iotApi } from '../services/api';
import type { AckRecord, OperatingMode, PacketDetailResponse, PacketRecord } from '../types/iot';

interface Props {
  mode: OperatingMode;
  refreshTick: number;
}

const QUEUE_VIEWS = [
  { id: 'all', label: 'All Packets' },
  { id: 'direct_wifi', label: 'Direct Wi-Fi (Scenario A)' },
  { id: 'lora_fallback', label: 'LoRa Fallback (Scenario B)' },
  { id: 'node1_pending', label: 'Offline Pending (LittleFS)' },
  { id: 'node2_received', label: 'Node 2 Received (microSD)' },
  { id: 'node2_pending_node3', label: 'Node 2 Pending → Node 3' },
  { id: 'node3_delivered', label: 'Node 3 Delivered' },
] as const;

function formatRouteLabel(pkt: PacketRecord): { label: string; tone: string } {
  const rp = pkt.route_path || (pkt.gateway_status === 'BYPASSED' ? 'DIRECT_WIFI' : '');
  if (rp === 'DIRECT_WIFI') return { label: 'Scenario A · Direct Wi-Fi', tone: 'text-sky-400' };
  if (rp === 'LORA_GATEWAY') return { label: 'Scenario B · LoRa→N2→N3', tone: 'text-amber-400' };
  if (rp === 'LOCAL_QUEUE') return { label: 'Scenario C · LittleFS Hold', tone: 'text-rose-400' };
  if (rp === 'LEGACY_TWO_HOP') return { label: 'Legacy · Two-Hop', tone: 'text-slate-400' };
  if (rp === 'LEGACY_UNCLASSIFIED') return { label: 'Legacy · Unclassified', tone: 'text-slate-400' };
  return { label: `N${pkt.source_node}→N${pkt.destination_node}`, tone: 'text-slate-300' };
}

function formatAckStage(pkt: PacketRecord): { label: string; tone: string } {
  if (pkt.destination_status === 'REJECTED' || pkt.encryption_status === 'AUTH_FAILED') {
    return { label: 'Auth Rejected (No ACK)', tone: 'text-rose-400' };
  }
  const rp = pkt.route_path || (pkt.gateway_status === 'BYPASSED' ? 'DIRECT_WIFI' : '');
  const n1Ack = Boolean(pkt.node1_acked);
  const n2Ack = Boolean(pkt.node2_acked);

  if (rp === 'DIRECT_WIFI') {
    if (n1Ack && pkt.destination_status === 'DELIVERED') {
      return { label: 'Direct ACK (N3→N1)', tone: 'text-emerald-400' };
    }
    return { label: 'Awaiting Direct N3 ACK', tone: 'text-amber-300' };
  }
  if (rp === 'LOCAL_QUEUE' || (!n1Ack && pkt.gateway_status === 'PENDING')) {
    return { label: 'Offline Pending (LittleFS)', tone: 'text-rose-300' };
  }
  if (n1Ack && n2Ack && pkt.destination_status === 'DELIVERED') {
    return { label: 'Stage 1 (N2) + Stage 2 (N3)', tone: 'text-emerald-400' };
  }
  if (n1Ack && !n2Ack) {
    return { label: 'Stage 1 Only (N2 Stored)', tone: 'text-amber-400' };
  }
  return { label: 'Awaiting Stage-1 ACK', tone: 'text-slate-400' };
}

function formatAuditAckDescription(ack: AckRecord): string {
  if (ack.link_hop === 'NODE1_NODE3' || (ack.sender_node === 3 && ack.receiver_node === 1)) {
    return 'Scenario A · Direct Delivery ACK (Node 3 → Node 1)';
  }
  if (ack.link_hop === 'NODE1_NODE2' || (ack.sender_node === 2 && ack.receiver_node === 1)) {
    return 'Scenario B · Stage-1 Gateway Storage ACK (Node 2 → Node 1)';
  }
  if (ack.link_hop === 'NODE2_NODE3' || (ack.sender_node === 3 && ack.receiver_node === 2)) {
    return 'Scenario B · Stage-2 Final Delivery ACK (Node 3 → Node 2)';
  }
  return `${ack.link_hop} (Node ${ack.sender_node} → Node ${ack.receiver_node})`;
}

export const PacketManagementPage: React.FC<Props> = ({ mode, refreshTick }) => {
  const [view, setView] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [priorityFilter, setPriorityFilter] = useState<string>('ALL');
  const [commFilter, setCommFilter] = useState<string>('ALL');
  const [routeFilter, setRouteFilter] = useState<string>('ALL');
  const [search, setSearch] = useState<string>('');
  const [packets, setPackets] = useState<PacketRecord[]>([]);
  const [selected, setSelected] = useState<PacketRecord | null>(null);
  const [detail, setDetail] = useState<PacketDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let active = true;
    iotApi
      .getPackets({
        mode,
        view,
        status: statusFilter,
        priority: priorityFilter,
        comm_mode: commFilter,
        route_path: routeFilter,
        search,
      })
      .then((res) => {
        if (active) {
          setPackets(res.packets);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load packets from backend API.');
        }
      });
    return () => {
      active = false;
    };
  }, [mode, view, statusFilter, priorityFilter, commFilter, routeFilter, search, refreshTick, retryCount]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let active = true;
    setDetailLoading(true);
    setDetailError(null);
    iotApi
      .getPacketDetail(mode, selected.packet_id)
      .then((res) => {
        if (active) {
          setDetail(res);
          setDetailLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setDetailError(err instanceof Error ? err.message : 'Failed to load packet audit trail.');
          setDetailLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [mode, selected]);

  const statusTone = (st: string) => {
    if (st === 'DELIVERED' || st === 'AUTHENTICATED') return 'text-emerald-400';
    if (st === 'BYPASSED') return 'text-slate-400';
    if (st === 'REJECTED' || st === 'AUTH_FAILED') return 'text-rose-400';
    if (st === 'PENDING' || st === 'RETRYING' || st === 'DUPLICATE_SUPPRESSED') return 'text-amber-400';
    return 'text-sky-400';
  };

  return (
    <div className="space-y-5">
      {error && (
        <div className="bg-rose-950/50 border border-rose-700/60 rounded-xl px-4 py-3 flex items-center justify-between gap-4 text-xs">
          <span className="font-mono text-rose-300">Packets API Error: {error}</span>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-3 py-1 rounded-md bg-rose-700 hover:bg-rose-600 text-white font-medium whitespace-nowrap cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Queue & Scenario View Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-[#111C30] border border-[#1E2E4A] rounded-lg w-fit">
        {QUEUE_VIEWS.map((q) => (
          <button
            key={q.id}
            type="button"
            onClick={() => setView(q.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              view === q.id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            {q.label}
          </button>
        ))}
      </div>

      {/* Filter Bar */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search packet ID, nonce, or status..."
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-md bg-[#0B1324] border border-[#2A3F63] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        <select
          aria-label="Filter by route path"
          value={routeFilter}
          onChange={(e) => setRouteFilter(e.target.value)}
          className="px-3 py-1.5 text-xs rounded-md bg-[#0B1324] border border-[#2A3F63] text-slate-200"
        >
          <option value="ALL">All Routes / Scenarios</option>
          <option value="DIRECT_WIFI">Scenario A: DIRECT_WIFI (N1→N3)</option>
          <option value="LORA_GATEWAY">Scenario B: LORA_GATEWAY (N1→N2→N3)</option>
          <option value="LOCAL_QUEUE">Scenario C: LOCAL_QUEUE (Offline)</option>
          <option value="LEGACY_TWO_HOP">Legacy: LEGACY_TWO_HOP</option>
          <option value="LEGACY_UNCLASSIFIED">Legacy: LEGACY_UNCLASSIFIED</option>
        </select>

        <select
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 text-xs rounded-md bg-[#0B1324] border border-[#2A3F63] text-slate-200"
        >
          <option value="ALL">All Statuses</option>
          <option value="CREATED">CREATED</option>
          <option value="ENCRYPTED">ENCRYPTED</option>
          <option value="PENDING">PENDING</option>
          <option value="TRANSMITTED">TRANSMITTED</option>
          <option value="GATEWAY_STORED">GATEWAY_STORED</option>
          <option value="FORWARDED">FORWARDED</option>
          <option value="DELIVERED">DELIVERED</option>
          <option value="RETRYING">RETRYING</option>
          <option value="REJECTED">REJECTED</option>
        </select>

        <select
          aria-label="Filter by priority"
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          className="px-3 py-1.5 text-xs rounded-md bg-[#0B1324] border border-[#2A3F63] text-slate-200"
        >
          <option value="ALL">All Priorities</option>
          <option value="1">Priority 1 (Heavy Rain)</option>
          <option value="2">Priority 2 (Routine)</option>
        </select>

        <select
          aria-label="Filter by communication mode"
          value={commFilter}
          onChange={(e) => setCommFilter(e.target.value)}
          className="px-3 py-1.5 text-xs rounded-md bg-[#0B1324] border border-[#2A3F63] text-slate-200"
        >
          <option value="ALL">All Comm Modes</option>
          <option value="WIFI">Wi-Fi</option>
          <option value="LORA">LoRa</option>
          <option value="OFFLINE">Offline</option>
        </select>
      </div>

      {/* Packet Table */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-[#1E2E4A] bg-[#0B1324] text-slate-400 font-medium">
                <th className="py-3 px-4 whitespace-nowrap">Packet ID</th>
                <th className="py-3 px-3 whitespace-nowrap">Route / Scenario</th>
                <th className="py-3 px-3 whitespace-nowrap">Priority</th>
                <th className="py-3 px-3 whitespace-nowrap">Comm</th>
                <th className="py-3 px-3 whitespace-nowrap">Gateway (N2)</th>
                <th className="py-3 px-3 whitespace-nowrap">Destination (N3)</th>
                <th className="py-3 px-3 whitespace-nowrap">ACK Stage</th>
                <th className="py-3 px-3 whitespace-nowrap text-right">Retries</th>
                <th className="py-3 px-4 whitespace-nowrap">Created</th>
                <th className="py-3 px-4 whitespace-nowrap text-right">Inspect</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1E2E4A] font-mono tabular-nums">
              {packets.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-10 text-center text-slate-500 font-sans">
                    No packets match the active filters in {mode === 'hardware' ? 'Live Hardware Mode' : 'Simulation Mode'}.
                  </td>
                </tr>
              ) : (
                packets.map((pkt) => {
                  const routeInfo = formatRouteLabel(pkt);
                  const ackInfo = formatAckStage(pkt);
                  return (
                    <tr
                      key={pkt.id}
                      onClick={() => setSelected(pkt)}
                      className="hover:bg-[#16243E] transition-colors cursor-pointer"
                    >
                      <td className="py-2.5 px-4 text-slate-100 font-semibold">#{pkt.packet_id}</td>
                      <td className={`py-2.5 px-3 whitespace-nowrap ${routeInfo.tone}`}>
                        {routeInfo.label}
                      </td>
                      <td className={`py-2.5 px-3 whitespace-nowrap ${pkt.priority === 1 ? 'text-rose-400' : 'text-slate-300'}`}>
                        {pkt.priority === 1 ? 'P1 HIGH' : 'P2 Routine'}
                      </td>
                      <td className="py-2.5 px-3 text-sky-400">{pkt.comm_mode}</td>
                      <td className={`py-2.5 px-3 whitespace-nowrap ${statusTone(pkt.gateway_status)}`}>
                        {pkt.gateway_status === 'BYPASSED' ? 'BYPASSED (Direct)' : pkt.gateway_status}
                      </td>
                      <td className={`py-2.5 px-3 whitespace-nowrap ${statusTone(pkt.destination_status)}`}>
                        {pkt.destination_status}
                      </td>
                      <td className={`py-2.5 px-3 whitespace-nowrap ${ackInfo.tone}`}>
                        {ackInfo.label}
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-300">{pkt.retry_count}</td>
                      <td className="py-2.5 px-4 text-slate-400 whitespace-nowrap">
                        {new Date(pkt.created_at).toLocaleTimeString()}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(pkt);
                          }}
                          className="text-blue-400 hover:text-blue-300 font-sans font-medium cursor-pointer"
                        >
                          Envelope
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Packet Envelope Metadata & SQLite Audit Trail Inspector Modal */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-[#0D1526] border border-[#1E2E4A] rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-[#1E2E4A] flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-base font-semibold text-slate-100">
                  Packet #{selected.packet_id} · AES-128-GCM Envelope & Audit Trail
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Secret AES key is never stored, transmitted, or exposed in the UI or logs.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close packet inspector"
                onClick={() => setSelected(null)}
                className="p-1.5 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs overflow-y-auto">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono tabular-nums">
                <div>
                  <div className="text-slate-400 font-sans">Route / Path</div>
                  <div className={`mt-0.5 ${formatRouteLabel(selected).tone}`}>
                    {selected.route_path || 'LEGACY_UNCLASSIFIED'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400 font-sans">ACK Stage</div>
                  <div className={`mt-0.5 ${formatAckStage(selected).tone}`}>
                    {formatAckStage(selected).label}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400 font-sans">Priority</div>
                  <div className="text-slate-100 mt-0.5">
                    {selected.priority === 1 ? '1 (Heavy Rain)' : '2 (Routine)'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400 font-sans">Proto / Key</div>
                  <div className="text-slate-100 mt-0.5">
                    v{selected.protocol_version} · {selected.key_version}
                  </div>
                </div>
              </div>

              <div className="space-y-2.5 pt-3 border-t border-[#1E2E4A] font-mono">
                <div>
                  <div className="text-slate-400 font-sans mb-1">Unique 96-bit (12-byte) Nonce (Visible in Header; Not Secret)</div>
                  <div className="p-2.5 rounded bg-[#080E1A] border border-[#1E2E4A] text-sky-300 break-all">
                    {selected.nonce}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400 font-sans mb-1">Authenticated Metadata (AAD)</div>
                  <div className="p-2.5 rounded bg-[#080E1A] border border-[#1E2E4A] text-slate-200 break-all">
                    {selected.aad}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400 font-sans mb-1">
                    Encrypted Ciphertext ({selected.gateway_status === 'BYPASSED' ? 'Sent Direct to Node 3' : 'Opaque at Node 2 Gateway'})
                  </div>
                  <div className="p-2.5 rounded bg-[#080E1A] border border-[#1E2E4A] text-slate-300 break-all">
                    {selected.ciphertext}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400 font-sans mb-1">128-bit GCM Authentication Tag</div>
                  <div className="p-2.5 rounded bg-[#080E1A] border border-[#1E2E4A] text-emerald-300 break-all">
                    {selected.auth_tag}
                  </div>
                </div>
              </div>

              {/* Live SQLite Audit Trail */}
              <div className="pt-3 border-t border-[#1E2E4A] space-y-3">
                <div className="text-xs font-semibold text-slate-200">
                  SQLite Delivery & ACK Audit Trail (GET /api/packets/{selected.packet_id})
                </div>

                {detailLoading && (
                  <div className="text-slate-400 font-mono">Loading SQLite audit records...</div>
                )}
                {detailError && (
                  <div className="text-rose-400 font-mono">Audit fetch error: {detailError}</div>
                )}

                {detail && !detailLoading && (
                  <div className="space-y-3">
                    {/* Node 3 Authenticated Plaintext Policy Gate */}
                    <div className="p-3 rounded-lg bg-[#080E1A] border border-[#1E2E4A]">
                      <div className="text-slate-400 mb-1">Node 3 Authenticated Decryption Output</div>
                      {detail.packet.destination_status === 'DELIVERED' && detail.authenticated_reading ? (
                        <div className="font-mono text-emerald-300 tabular-nums">
                          Temp {detail.authenticated_reading.temperature.toFixed(1)} °C · Humidity{' '}
                          {detail.authenticated_reading.humidity.toFixed(1)} % · Rain ADC{' '}
                          {detail.authenticated_reading.rain_raw} ({detail.authenticated_reading.rain_category})
                        </div>
                      ) : (
                        <div className="font-mono text-amber-300">
                          {detail.packet.destination_status === 'REJECTED'
                            ? 'BLOCKED: AES-128-GCM verification failed at Node 3. Plaintext rejected and never displayed.'
                            : 'CIPHERTEXT ONLY: Not yet decrypted by Node 3. Node 2 gateway never holds the AES key.'}
                        </div>
                      )}
                    </div>

                    {/* Acknowledgements */}
                    <div className="p-3 rounded-lg bg-[#080E1A] border border-[#1E2E4A]">
                      <div className="text-slate-400 mb-1.5">
                        ACK Verification Trail ({detail.acknowledgements.length})
                      </div>
                      {detail.acknowledgements.length === 0 ? (
                        <div className="text-slate-500 font-mono">No ACK records recorded yet.</div>
                      ) : (
                        <div className="space-y-1.5 font-mono tabular-nums">
                          {detail.acknowledgements.map((a) => (
                            <div key={a.id} className="flex flex-wrap justify-between gap-2">
                              <span className="text-slate-300">{formatAuditAckDescription(a)}</span>
                              <span className={statusTone(a.status)}>
                                {a.status} ({a.latency_ms} ms)
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Security Events */}
                    <div className="p-3 rounded-lg bg-[#080E1A] border border-[#1E2E4A]">
                      <div className="text-slate-400 mb-1.5">
                        Cryptographic Events ({detail.security_events.length})
                      </div>
                      {detail.security_events.length === 0 ? (
                        <div className="text-slate-500 font-mono">No security events logged.</div>
                      ) : (
                        <div className="space-y-1 font-mono">
                          {detail.security_events.map((s) => (
                            <div key={s.id} className="flex justify-between gap-2">
                              <span className="text-slate-300">
                                {s.endpoint} · {s.event_type}
                              </span>
                              <span className={statusTone(s.status)}>{s.status}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-3 border-t border-[#1E2E4A] flex flex-wrap items-center justify-between gap-2 text-slate-400 font-mono">
                <span>Overall: {selected.overall_status}</span>
                <span>Gateway: {selected.gateway_status}</span>
                <span>Destination: {selected.destination_status}</span>
                <span>Duplicate: {selected.is_duplicate ? 'YES (Suppressed)' : 'NO'}</span>
                <span>Tampered: {selected.tampered ? 'YES (Rejected)' : 'NO'}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
