import React, { useEffect, useState } from 'react';
import { HardDrive, FolderOpen } from 'lucide-react';
import { iotApi } from '../services/api';
import type { OperatingMode, StorageRecord } from '../types/iot';

interface Props {
  mode: OperatingMode;
  refreshTick: number;
}

export const StorageManagementPage: React.FC<Props> = ({ mode, refreshTick }) => {
  const [storage, setStorage] = useState<StorageRecord[]>([]);
  const [n1Pending, setN1Pending] = useState<Array<{ packet_id: number; priority: number; created_at: string }>>([]);
  const [n2Pending, setN2Pending] = useState<Array<{ packet_id: number; priority: number; created_at: string }>>([]);
  const [queueCounts, setQueueCounts] = useState<{
    node1_pending: number;
    node2_received: number;
    node2_pending_node3: number;
    node3_delivered: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.all([iotApi.getStorage(mode), iotApi.getQueues(mode)])
      .then(([res, qRes]) => {
        if (active) {
          setStorage(res.storage);
          setN1Pending(res.node1_pending_packets);
          setN2Pending(res.node2_pending_node3_packets);
          setQueueCounts(qRes.counts);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load storage & queue telemetry.');
        }
      });
    return () => {
      active = false;
    };
  }, [mode, refreshTick, retryCount]);

  const lfs1 = storage.find((s) => s.node_id === 'NODE_1');
  const sd2 = storage.find((s) => s.node_id === 'NODE_2');
  const lfs3 = storage.find((s) => s.node_id === 'NODE_3');
  const sdReported = sd2 && sd2.status !== 'NOT_REPORTED';

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-rose-950/50 border border-rose-700/60 rounded-xl px-4 py-3 flex items-center justify-between gap-4 text-xs">
          <span className="font-mono text-rose-300">Storage API Error: {error}</span>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-3 py-1 rounded-md bg-rose-700 hover:bg-rose-600 text-white font-medium whitespace-nowrap cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Live 4-Queue Summary Strip (/api/queues) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-mono tabular-nums">
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-slate-400 font-sans">Queue 1 · Node 1 Pending (LittleFS)</div>
          <div className="text-2xl text-amber-300 font-semibold mt-1">
            {queueCounts?.node1_pending ?? n1Pending.length}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Offline / un-ACKed retention</div>
        </div>
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-slate-400 font-sans">Queue 2 · Node 2 Stored (microSD)</div>
          <div className="text-2xl text-sky-400 font-semibold mt-1">
            {sd2?.stored_count ?? queueCounts?.node2_received ?? 0}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">LoRa fallback only (Direct bypasses)</div>
        </div>
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-slate-400 font-sans">Queue 3 · Node 2 Pending → Node 3</div>
          <div className="text-2xl text-amber-400 font-semibold mt-1">
            {queueCounts?.node2_pending_node3 ?? n2Pending.length}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Awaiting Stage-2 N3→N2 ACK</div>
        </div>
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
          <div className="text-slate-400 font-sans">Queue 4 · Node 3 Saved (LittleFS)</div>
          <div className="text-2xl text-emerald-400 font-semibold mt-1">
            {lfs3?.stored_count ?? queueCounts?.node3_delivered ?? 0}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Direct Wi-Fi + Gateway delivered</div>
        </div>
      </div>

      {/* All Three Hardware Storage Subsystems */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* NODE 1 - LITTLEFS */}
        <section className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-6 space-y-5">
          <div className="flex items-baseline justify-between gap-2 pb-4 border-b border-[#1E2E4A]">
            <div className="flex items-center gap-2.5">
              <HardDrive className="w-4 h-4 text-sky-400 shrink-0" />
              <div>
                <h3 className="text-base font-semibold text-slate-100">Node 1 — LittleFS Flash</h3>
                <p className="text-xs text-slate-400">Offline store-and-forward queue & sequence state</p>
              </div>
            </div>
            <span
              className={`text-xs font-mono shrink-0 ${
                lfs1?.status === 'MOUNTED' ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              {lfs1?.status || 'NOT_REPORTED'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs font-mono tabular-nums">
            <div>
              <div className="text-slate-400 font-sans">Pending Queue</div>
              <div className="text-xl text-amber-300 mt-1">{lfs1?.pending_count ?? 0}</div>
            </div>
            <div>
              <div className="text-slate-400 font-sans">Sequence Counter</div>
              <div className="text-xl text-slate-100 mt-1">#{lfs1?.sequence_counter ?? 0}</div>
            </div>
            <div>
              <div className="text-slate-400 font-sans">Retire Policy</div>
              <div className="text-xs text-sky-400 mt-1.5">Direct N3 or Stage-1 N2 ACK</div>
            </div>
            <div>
              <div className="text-slate-400 font-sans">Storage Errors</div>
              <div className={`text-xl mt-1 ${(lfs1?.storage_errors ?? 0) > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                {lfs1?.storage_errors ?? 0}
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-[#1E2E4A]">
            <h4 className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
              <FolderOpen className="w-3.5 h-3.5 text-slate-400" />
              Node 1 LittleFS Filesystem Layout
            </h4>
            <div className="bg-[#080E1A] border border-[#1E2E4A] rounded-lg p-3 font-mono text-xs text-slate-300 space-y-1 max-h-40 overflow-y-auto">
              {lfs1 && lfs1.files.length > 0 ? (
                lfs1.files.map((f, idx) => <div key={idx}>{f}</div>)
              ) : (
                <div className="text-slate-500">Awaiting LittleFS telemetry from ESP32 Node 1.</div>
              )}
            </div>
          </div>

          <div className="pt-4 border-t border-[#1E2E4A]">
            <h4 className="text-xs font-semibold text-slate-300 mb-2">
              Stored Pending Packet IDs ({n1Pending.length})
            </h4>
            {n1Pending.length === 0 ? (
              <div className="text-xs text-slate-500">
                All Node 1 packets acknowledged (Direct N3 ACK or Stage-1 N2 ACK). Queue clear.
              </div>
            ) : (
              <div className="flex flex-wrap gap-3 font-mono text-xs text-amber-300 tabular-nums">
                {n1Pending.map((p) => (
                  <span key={p.packet_id}>
                    #{p.packet_id} ({p.priority === 1 ? 'P1' : 'P2'})
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* NODE 2 - 16 GB microSD */}
        <section className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-6 space-y-5">
          <div className="flex items-baseline justify-between gap-2 pb-4 border-b border-[#1E2E4A]">
            <div className="flex items-center gap-2.5">
              <HardDrive className="w-4 h-4 text-blue-400 shrink-0" />
              <div>
                <h3 className="text-base font-semibold text-slate-100">Node 2 — 16 GB microSD</h3>
                <p className="text-xs text-slate-400">FAT32 LoRa fallback archive & Node 3 forward queue</p>
              </div>
            </div>
            <span
              className={`text-xs font-mono shrink-0 ${
                sd2?.status === 'MOUNTED' ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              {sd2?.status || 'NOT_REPORTED'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs font-mono tabular-nums">
            <div>
              <div className="text-slate-400 font-sans">Configured Capacity</div>
              <div className="text-xl text-slate-100 mt-1">
                {sdReported && sd2?.capacity_gb ? `${sd2.capacity_gb} GB` : 'Not Reported'}
              </div>
              {!sdReported && (
                <div className="text-[11px] text-slate-500 mt-0.5">16 GB FAT32 spec</div>
              )}
            </div>
            <div>
              <div className="text-slate-400 font-sans">Encrypted Stored</div>
              <div className="text-xl text-sky-400 mt-1">{sd2?.stored_count ?? 0}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">LoRa fallback only</div>
            </div>
            <div>
              <div className="text-slate-400 font-sans">Node 3 Pending</div>
              <div className="text-xl text-amber-300 mt-1">{sd2?.pending_count ?? 0}</div>
            </div>
            <div>
              <div className="text-slate-400 font-sans">Storage Errors</div>
              <div className={`text-xl mt-1 ${(sd2?.storage_errors ?? 0) > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                {sd2?.storage_errors ?? 0}
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-[#1E2E4A]">
            <h4 className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
              <FolderOpen className="w-3.5 h-3.5 text-slate-400" />
              Node 2 microSD Persistent Gateway Files
            </h4>
            <div className="bg-[#080E1A] border border-[#1E2E4A] rounded-lg p-3 font-mono text-xs text-slate-300 space-y-1 max-h-40 overflow-y-auto">
              {sd2 && sd2.files.length > 0 ? (
                sd2.files.map((f, idx) => <div key={idx}>{f}</div>)
              ) : (
                <div className="text-slate-500">Awaiting microSD telemetry from ESP32 Node 2.</div>
              )}
            </div>
          </div>

          <div className="pt-4 border-t border-[#1E2E4A]">
            <h4 className="text-xs font-semibold text-slate-300 mb-2">
              Node 3 Pending Forwarding Queue ({n2Pending.length})
            </h4>
            {n2Pending.length === 0 ? (
              <div className="text-xs text-slate-500">
                All gateway-buffered packets delivered to Node 3. Direct Wi-Fi packets bypass microSD.
              </div>
            ) : (
              <div className="flex flex-wrap gap-3 font-mono text-xs text-amber-300 tabular-nums">
                {n2Pending.map((p) => (
                  <span key={p.packet_id}>
                    #{p.packet_id} ({p.priority === 1 ? 'P1' : 'P2'})
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* NODE 3 - LITTLEFS */}
        <section className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-6 space-y-5">
          <div className="flex items-baseline justify-between gap-2 pb-4 border-b border-[#1E2E4A]">
            <div className="flex items-center gap-2.5">
              <HardDrive className="w-4 h-4 text-emerald-400 shrink-0" />
              <div>
                <h3 className="text-base font-semibold text-slate-100">Node 3 — LittleFS Flash</h3>
                <p className="text-xs text-slate-400">Authenticated receiver log & LCD recovery cache</p>
              </div>
            </div>
            <span
              className={`text-xs font-mono shrink-0 ${
                lfs3?.status === 'MOUNTED' ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              {lfs3?.status || 'NOT_REPORTED'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs font-mono tabular-nums">
            <div>
              <div className="text-slate-400 font-sans">Authenticated Stored</div>
              <div className="text-xl text-emerald-400 mt-1">{lfs3?.stored_count ?? 0}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">Direct Wi-Fi + Gateway</div>
            </div>
            <div>
              <div className="text-slate-400 font-sans">Last Verified Seq</div>
              <div className="text-xl text-slate-100 mt-1">#{lfs3?.sequence_counter ?? 0}</div>
            </div>
            <div>
              <div className="text-slate-400 font-sans">Pending Local Writes</div>
              <div className="text-xl text-slate-200 mt-1">{lfs3?.pending_count ?? 0}</div>
            </div>
            <div>
              <div className="text-slate-400 font-sans">Storage Errors</div>
              <div className={`text-xl mt-1 ${(lfs3?.storage_errors ?? 0) > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                {lfs3?.storage_errors ?? 0}
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-[#1E2E4A]">
            <h4 className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
              <FolderOpen className="w-3.5 h-3.5 text-slate-400" />
              Node 3 LittleFS Receiver Filesystem Layout
            </h4>
            <div className="bg-[#080E1A] border border-[#1E2E4A] rounded-lg p-3 font-mono text-xs text-slate-300 space-y-1 max-h-40 overflow-y-auto">
              {lfs3 && lfs3.files.length > 0 ? (
                lfs3.files.map((f, idx) => <div key={idx}>{f}</div>)
              ) : (
                <div className="text-slate-500">
                  Awaiting LittleFS telemetry from ESP32 Node 3 (POST /api/node3/storage-status).
                </div>
              )}
            </div>
          </div>

          <div className="pt-4 border-t border-[#1E2E4A]">
            <h4 className="text-xs font-semibold text-slate-300 mb-2">Receiver Durability Policy</h4>
            <p className="text-xs text-slate-400 leading-relaxed">
              Only AES-128-GCM verified readings are persisted to Node 3 LittleFS and displayed on the I2C LCD. Tampered or unauthenticated packets are rejected prior to storage and never generate a delivery ACK.
            </p>
          </div>
        </section>
      </div>

      {/* Store-and-Forward Durability Guarantees */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5 grid grid-cols-1 md:grid-cols-3 gap-5 text-xs">
        <div>
          <h4 className="font-semibold text-slate-100">Direct Wi-Fi Bypass Integrity</h4>
          <p className="text-slate-400 mt-1 leading-relaxed">
            Scenario A direct Wi-Fi packets go straight from Node 1 to Node 3 LittleFS and never write to Node 2 microSD. Node 1 retires the packet only on matching direct N3→N1 ACK.
          </p>
        </div>
        <div>
          <h4 className="font-semibold text-slate-100">Flush Before Stage-1 ACK</h4>
          <p className="text-slate-400 mt-1 leading-relaxed">
            During Scenario B LoRa fallback, Node 2 flushes opaque ciphertext to microSD before sending Stage-1 ACK (N2→N1), and clears its forward queue only after Stage-2 ACK (N3→N2).
          </p>
        </div>
        <div>
          <h4 className="font-semibold text-slate-100">Three-Node Restart Recovery</h4>
          <p className="text-slate-400 mt-1 leading-relaxed">
            Node 1 LittleFS, Node 2 microSD, and Node 3 LittleFS preserve sequence counters, offline queues, and verified display state across power-cycles without reusing AES-GCM nonces.
          </p>
        </div>
      </div>
    </div>
  );
};
