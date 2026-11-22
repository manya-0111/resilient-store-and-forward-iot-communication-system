import React, { useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Wifi,
  WifiOff,
  Radio,
  ShieldAlert,
  CloudRain,
  Activity,
  Copy,
  RefreshCw,
  Zap,
} from 'lucide-react';
import { iotApi } from '../services/api';
import type { SimulationState } from '../types/iot';

interface Props {
  simulation: SimulationState | null;
  onRefresh: () => void;
}

export const SimulationToolbar: React.FC<Props> = ({ simulation, onRefresh }) => {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  if (!simulation) return null;

  const isRunning = Boolean(simulation.running && !simulation.paused);

  const runAction = async (fn: () => Promise<{ message?: string } | unknown>, fallbackMsg: string) => {
    setBusy(true);
    try {
      const res = (await fn()) as { message?: string };
      setFeedback(res?.message || fallbackMsg);
      onRefresh();
    } catch (err) {
      setFeedback(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#1E2E4A]">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-mono font-semibold text-amber-400">
            DEMO MODE · SIMULATION ENGINE
          </span>
          <span className="text-xs text-slate-400">
            {isRunning ? '● Running' : '▲ Paused'} · Seq #{simulation.sequence_counter} · Interval {(simulation.speed_ms / 1000).toFixed(1)}s
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isRunning ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction(() => iotApi.simPause(), 'Simulation paused.')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-slate-800 hover:bg-slate-700 text-slate-100 border border-[#2A3F63] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Pause className="w-3.5 h-3.5" />
              Pause
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction(() => iotApi.simResume(), 'Simulation resumed.')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 hover:bg-blue-500 text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              {simulation.running ? 'Resume' : 'Start'}
            </button>
          )}

          <select
            aria-label="Simulation speed"
            value={simulation.speed_ms}
            onChange={(e) =>
              runAction(
                () => iotApi.simControl('set_speed', { speed_ms: Number(e.target.value) }),
                'Updated simulation speed.'
              )
            }
            className="px-2.5 py-1.5 text-xs font-mono rounded-md bg-[#0B1324] text-slate-200 border border-[#2A3F63] focus:outline-none focus:border-blue-500"
          >
            <option value={1500}>Fast (1.5s)</option>
            <option value={3500}>Normal (3.5s)</option>
            <option value={6000}>Slow (6.0s)</option>
            <option value={10000}>Very Slow (10s)</option>
          </select>

          <button
            type="button"
            disabled={busy}
            onClick={() => runAction(() => iotApi.simReset(), 'Simulation reset to clean initial baseline.')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[#0B1324] hover:bg-slate-800 text-slate-300 border border-[#2A3F63] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
        </div>
      </div>

      {/* Interactive Link & Fault Controls */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => runAction(() => iotApi.simControl('toggle_node1_wifi'), 'Toggled Node 1 Wi-Fi.')}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            simulation.node1_wifi_on
              ? 'bg-sky-950/60 border-sky-700/60 text-sky-300 hover:bg-sky-900/60'
              : 'bg-rose-950/60 border-rose-700/60 text-rose-300 hover:bg-rose-900/60'
          }`}
        >
          {simulation.node1_wifi_on ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
          Direct Wi-Fi (N1→N3): {simulation.node1_wifi_on ? 'ON' : 'OFF'}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => runAction(() => iotApi.simControl('toggle_node1_lora'), 'Toggled Node 1 → Node 2 LoRa fallback.')}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            simulation.node1_lora_on
              ? 'bg-amber-950/50 border-amber-700/60 text-amber-300 hover:bg-amber-900/50'
              : 'bg-rose-950/60 border-rose-700/60 text-rose-300 hover:bg-rose-900/60'
          }`}
        >
          <Radio className="w-3.5 h-3.5" />
          LoRa Fallback (N1→N2): {simulation.node1_lora_on ? 'READY' : 'OFF'}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => runAction(() => iotApi.simControl('toggle_node2_node3_wifi'), 'Toggled Node 2 → Node 3 Gateway Wi-Fi.')}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            simulation.node2_node3_wifi_on
              ? 'bg-emerald-950/50 border-emerald-700/60 text-emerald-300 hover:bg-emerald-900/50'
              : 'bg-rose-950/60 border-rose-700/60 text-rose-300 hover:bg-rose-900/60'
          }`}
        >
          <Wifi className="w-3.5 h-3.5" />
          Gateway Wi-Fi (N2→N3): {simulation.node2_node3_wifi_on ? 'ON' : 'OFF'}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => runAction(() => iotApi.simControl('restore_all_links'), 'Restored all links.')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-[#0B1324] hover:bg-slate-800 text-emerald-300 border border-[#2A3F63] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Restore All Links
        </button>

        <span className="h-4 w-px bg-[#1E2E4A] mx-1 hidden sm:inline-block" aria-hidden="true" />

        <button
          type="button"
          disabled={busy}
          onClick={() => runAction(() => iotApi.simControl('generate_heavy_rain'), 'Generated heavy-rain alert.')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-600/40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <CloudRain className="w-3.5 h-3.5" />
          Heavy-Rain Alert
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => runAction(() => iotApi.simControl('generate_routine'), 'Generated routine reading.')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-[#0B1324] hover:bg-slate-800 text-slate-200 border border-[#2A3F63] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Activity className="w-3.5 h-3.5" />
          Routine Reading
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => runAction(() => iotApi.simControl('drop_ack'), 'Simulated dropped ACK.')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-[#0B1324] hover:bg-slate-800 text-amber-300 border border-[#2A3F63] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Copy className="w-3.5 h-3.5" />
          Drop ACK / Duplicate
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => runAction(() => iotApi.simControl('trigger_tamper'), 'Simulated ciphertext tamper.')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-rose-950/50 hover:bg-rose-900/50 text-rose-300 border border-rose-700/50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <ShieldAlert className="w-3.5 h-3.5" />
          Tamper Packet
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => runAction(() => iotApi.simControl('restart_node', { node: 'NODE_1' }), 'Simulated Node 1 restart.')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-[#0B1324] hover:bg-slate-800 text-slate-300 border border-[#2A3F63] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Zap className="w-3.5 h-3.5" />
          Restart Node 1
        </button>
      </div>

      {feedback && (
        <div className="mt-3 pt-2.5 border-t border-[#1E2E4A] text-xs font-mono text-sky-300 flex items-center justify-between gap-2">
          <span>{feedback}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-slate-400 hover:text-slate-200 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
};
