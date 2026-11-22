import React, { useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { iotApi } from '../services/api';
import type { OperatingMode, SecurityEvent } from '../types/iot';

interface Props {
  mode: OperatingMode;
  refreshTick: number;
  onRefresh: () => void;
}

export const SecurityMonitoringPage: React.FC<Props> = ({ mode, refreshTick, onRefresh }) => {
  const [data, setData] = useState<{
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
  } | null>(null);
  const [tamperMsg, setTamperMsg] = useState<string | null>(null);
  const [tamperTarget, setTamperTarget] = useState<'ciphertext' | 'tag'>('ciphertext');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let active = true;
    iotApi
      .getSecurity(mode)
      .then((res) => {
        if (active) {
          setData(res);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load cryptographic telemetry.');
        }
      });
    return () => {
      active = false;
    };
  }, [mode, refreshTick, retryCount]);

  const handleSimulateTamper = async () => {
    setBusy(true);
    try {
      const res = await iotApi.simControl('trigger_tamper', { target: tamperTarget });
      setTamperMsg(res.message);
      onRefresh();
    } catch (err) {
      setTamperMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-rose-950/50 border border-rose-700/60 rounded-xl px-4 py-3 flex items-center justify-between gap-4 text-xs">
          <span className="font-mono text-rose-300">Security API Error: {error}</span>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-3 py-1 rounded-md bg-rose-700 hover:bg-rose-600 text-white font-medium whitespace-nowrap cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}
      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-xs text-slate-400">Encrypted Packets</div>
          <div className="text-2xl font-mono font-semibold text-sky-400 tabular-nums mt-1.5">
            {data?.metrics.encrypted_packet_count ?? 0}
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-1">AES-128-GCM</div>
        </div>

        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-xs text-slate-400">Auth Verified (Node 3)</div>
          <div className="text-2xl font-mono font-semibold text-emerald-400 tabular-nums mt-1.5">
            {data?.metrics.auth_success_count ?? 0}
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-1">GCM tag + AAD valid</div>
        </div>

        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-xs text-slate-400">Failed Authentication</div>
          <div className="text-2xl font-mono font-semibold text-rose-400 tabular-nums mt-1.5">
            {data?.metrics.auth_failed_count ?? 0}
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-1">Blocked before LCD</div>
        </div>

        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-xs text-slate-400">Rejected Packets</div>
          <div className="text-2xl font-mono font-semibold text-rose-300 tabular-nums mt-1.5">
            {data?.metrics.rejected_packet_count ?? 0}
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-1">No success ACK sent</div>
        </div>

        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-xs text-slate-400">96-bit Nonce Uniqueness</div>
          <div
            className={`text-xl font-mono font-semibold mt-1.5 ${
              data?.metrics.unique_nonce_verified ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {data?.metrics.unique_nonce_verified ? '● VERIFIED' : '✖ COLLISION'}
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-1 tabular-nums">
            {data?.metrics.unique_nonces_count ?? 0} distinct nonces
          </div>
        </div>
      </div>

      {/* End-to-End Architecture & Tamper Demo */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-3 text-xs">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-semibold text-slate-100">
              AES-128-GCM End-to-End Security Architecture
            </h3>
          </div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <div>
              <dt className="text-slate-400">Encryption Endpoint</dt>
              <dd className="font-mono text-slate-200 mt-0.5">{data?.metadata.encryption_endpoint}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Decryption Endpoint</dt>
              <dd className="font-mono text-emerald-300 mt-0.5">{data?.metadata.decryption_endpoint}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Gateway Behavior (Node 2)</dt>
              <dd className="font-mono text-sky-300 mt-0.5">{data?.metadata.gateway_behavior}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Key Provisioning & Version</dt>
              <dd className="font-mono text-slate-200 mt-0.5">
                {data?.metadata.key_version} · {data?.metadata.key_source} (Never exposed)
              </dd>
            </div>
          </dl>
          <p className="text-slate-400 pt-2 border-t border-[#1E2E4A] leading-relaxed">
            Retries always retransmit the exact same encrypted packet bytes (same nonce, ciphertext, and tag). Secret AES keys are strictly isolated on the server/device and are never persisted in SQLite, sent over Wi-Fi/LoRa, or displayed in browser views.
          </p>
        </div>

        <div className="border-t lg:border-t-0 lg:border-l border-[#1E2E4A] pt-4 lg:pt-0 lg:pl-6 flex flex-col justify-between space-y-3">
          <div>
            <h4 className="text-sm font-semibold text-slate-100">Tamper Verification Test</h4>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              Flip a byte in transit before Node 3 verification. Node 3 must reject the GCM tag, refuse LCD display, omit success ACK, and log a critical security alert.
            </p>
            <div className="mt-3 flex items-center gap-1 p-1 bg-[#0B1324] border border-[#1E2E4A] rounded-lg">
              {([
                { id: 'ciphertext', label: 'Tamper Ciphertext' },
                { id: 'tag', label: 'Tamper Auth Tag' },
              ] as const).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setTamperTarget(opt.id)}
                  className={`flex-1 px-2.5 py-1.5 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    tamperTarget === opt.id
                      ? 'bg-rose-700 text-white'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            disabled={busy || mode === 'hardware'}
            onClick={handleSimulateTamper}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-rose-600 hover:bg-rose-500 text-white transition-colors cursor-pointer disabled:opacity-50"
          >
            <ShieldAlert className="w-4 h-4" />
            {tamperTarget === 'tag' ? 'Inject Auth Tag Tamper' : 'Inject Ciphertext Tamper'}
          </button>
          {mode === 'hardware' && (
            <div className="text-[11px] font-mono text-amber-400">
              Switch to Simulation Mode to run synthetic tamper injection.
            </div>
          )}
          {tamperMsg && <div className="text-xs font-mono text-rose-300">{tamperMsg}</div>}
        </div>
      </div>

      {/* Security Event Log */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-[#1E2E4A] flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-slate-100">Cryptographic & Security Event Log</h3>
          <span className="text-xs font-mono text-slate-500">{data?.events.length ?? 0} events</span>
        </div>
        <div className="max-h-96 overflow-y-auto divide-y divide-[#1E2E4A]">
          {!data || data.events.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">No security events logged in current mode.</div>
          ) : (
            data.events.map((ev) => (
              <div key={ev.id} className="px-5 py-3 text-xs flex flex-col sm:flex-row sm:items-baseline justify-between gap-2">
                <div>
                  <div className="flex flex-wrap items-center gap-2 font-mono">
                    <span
                      className={
                        ev.status === 'REJECTED'
                          ? 'text-rose-400 font-semibold'
                          : ev.status === 'AUTHENTICATED'
                            ? 'text-emerald-400'
                            : 'text-sky-400'
                      }
                    >
                      {ev.status === 'REJECTED' ? '✖' : '●'} {ev.event_type} ({ev.status})
                    </span>
                    <span className="text-slate-500">·</span>
                    <span className="text-slate-300">{ev.endpoint}</span>
                    {ev.packet_id !== null && (
                      <>
                        <span className="text-slate-500">·</span>
                        <span className="text-slate-200">Pkt #{ev.packet_id}</span>
                      </>
                    )}
                    {ev.nonce_hex && (
                      <>
                        <span className="text-slate-500">·</span>
                        <span className="text-slate-400">nonce:{ev.nonce_hex.slice(0, 12)}…</span>
                      </>
                    )}
                  </div>
                  <p className="text-slate-400 mt-1">{ev.details}</p>
                </div>
                <span className="text-[11px] font-mono text-slate-500 shrink-0 tabular-nums">
                  {new Date(ev.created_at).toLocaleTimeString()}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
