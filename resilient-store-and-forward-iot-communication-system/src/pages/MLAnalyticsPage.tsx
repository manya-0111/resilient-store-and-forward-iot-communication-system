import React, { useEffect, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { iotApi } from '../services/api';
import type {
  MLDataSource,
  MLNetworkResponse,
  ModelAvailabilityState,
  NetworkQualityClass,
  OperatingMode,
} from '../types/iot';

interface Props {
  mode: OperatingMode;
  refreshTick: number;
  onRefresh: () => void;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ML_SOURCE_TABS: MLDataSource[] = ['SIMULATED', 'ESP32_HARDWARE', 'CSV_IMPORT'];

function availabilityTextClass(state: ModelAvailabilityState | undefined): string {
  switch (state) {
    case 'AVAILABLE':
      return 'text-emerald-400';
    case 'STALE':
      return 'text-amber-400';
    case 'CENSORED':
      return 'text-amber-300';
    case 'INSUFFICIENT_DATA':
      return 'text-sky-400';
    case 'DISABLED':
      return 'text-slate-400';
    case 'UNAVAILABLE':
    default:
      return 'text-rose-400';
  }
}

function qualityTextClass(cls: NetworkQualityClass | null | undefined): string {
  if (cls === 'GOOD') return 'text-emerald-400';
  if (cls === 'MODERATE') return 'text-amber-400';
  if (cls === 'POOR') return 'text-rose-400';
  return 'text-slate-400';
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export const MLAnalyticsPage: React.FC<Props> = ({ mode, refreshTick, onRefresh }) => {
  const [selectedSource, setSelectedSource] = useState<MLDataSource>(
    mode === 'hardware' ? 'ESP32_HARDWARE' : 'SIMULATED'
  );
  const [netML, setNetML] = useState<MLNetworkResponse | null>(null);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    setSelectedSource(mode === 'hardware' ? 'ESP32_HARDWARE' : 'SIMULATED');
  }, [mode]);

  useEffect(() => {
    let active = true;
    iotApi
      .getMLNetwork(mode, 60, selectedSource)
      .then((res) => {
        if (active) {
          setNetML(res);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load ML analytics telemetry.');
        }
      });
    return () => {
      active = false;
    };
  }, [mode, selectedSource, refreshTick, retryCount]);

  const toggleML = async (nextVal: boolean) => {
    setToggling(true);
    try {
      await iotApi.updateSettings({ ml_network_enabled: nextVal });
      setError(null);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update ML toggle.');
    } finally {
      setToggling(false);
    }
  };

  const clf = netML?.classification;
  const sch = netML?.scheduling;
  const clfFeat = netML?.classification_features;
  const schFeat = netML?.scheduling_features;
  const latestClf = clf?.latest_prediction;
  const latestSch = sch?.latest_prediction;

  const clfReady =
    Boolean(netML?.enabled) &&
    latestClf?.prediction_status === 'READY' &&
    latestClf.predicted_class !== null;

  const schReady =
    Boolean(netML?.enabled) &&
    latestSch?.prediction_status === 'READY' &&
    latestSch.predicted_wait_seconds !== null &&
    !latestSch.observation_censored;

  const clfHistoryChart = (clf?.history || [])
    .filter((h) => h.prediction_status === 'READY' && h.probabilities !== null)
    .map((h) => ({
      time: formatTimestamp(h.prediction_timestamp),
      GOOD: Number(((h.probabilities?.GOOD ?? 0) * 100).toFixed(1)),
      MODERATE: Number(((h.probabilities?.MODERATE ?? 0) * 100).toFixed(1)),
      POOR: Number(((h.probabilities?.POOR ?? 0) * 100).toFixed(1)),
    }));

  const schHistoryChart = (sch?.history || [])
    .filter(
      (h) =>
        h.prediction_status === 'READY' &&
        h.predicted_wait_seconds !== null &&
        !h.observation_censored
    )
    .map((h) => ({
      time: formatTimestamp(h.prediction_timestamp),
      predicted: h.predicted_wait_seconds,
      actual: h.actual_wait_seconds,
    }));

  const actualVsPredictedChart = (sch?.actual_vs_predicted || []).map((row) => ({
    time: formatTimestamp(row.timestamp),
    predicted: row.predicted_wait_seconds,
    actual: row.actual_wait_seconds,
  }));

  const dataSourceLabel = netML?.data_source || selectedSource;

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-rose-950/50 border border-rose-700/60 rounded-xl px-4 py-3 flex items-center justify-between gap-4 text-xs">
          <span className="font-mono text-rose-300">ML Integration API Error: {error}</span>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-3 py-1 rounded-md bg-rose-700 hover:bg-rose-600 text-white font-medium whitespace-nowrap cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Top Scope, Provenance & Advisory Policy Banner */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="space-y-2 max-w-4xl">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold text-slate-100">
              Network ML Integration Layer · Strictly Scoped to NODE2_NODE3_WIFI
            </span>
            <span className="font-mono text-sky-400">
              Data Source: {dataSourceLabel}
            </span>
            <span className="font-mono text-slate-400 tabular-nums">
              ML-Ready N2→N3 Samples: {netML?.sample_count ?? 0}
              {netML?.raw_sample_count && netML.raw_sample_count > (netML.sample_count ?? 0)
                ? ` (${netML.raw_sample_count} total N2→N3 rows)`
                : ''}
            </span>
          </div>
          <p className="text-slate-400">
            External Python Random Forest models evaluate Node 2 → Node 3 Wi-Fi exclusively and are strictly advisory. Core Wi-Fi/LoRa fallback, AES-128-GCM verification, ACK confirmation, retries, and persistent queues remain deterministic and unaffected if ML is unavailable.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-[#0B1324] border border-[#1E2E4A] rounded-lg font-mono text-xs tabular-nums">
            {ML_SOURCE_TABS.map((src) => {
              const cnt = netML?.source_counts?.[src]?.ml_ready ?? 0;
              const active = selectedSource === src;
              return (
                <button
                  key={src}
                  type="button"
                  onClick={() => setSelectedSource(src)}
                  className={`px-2.5 py-1 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? src === 'CSV_IMPORT'
                        ? 'bg-cyan-700 text-white'
                        : src === 'ESP32_HARDWARE'
                          ? 'bg-emerald-700 text-white'
                          : 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {src} ({cnt})
                </button>
              );
            })}
          </div>

          <button
            type="button"
            disabled={toggling}
            onClick={() => toggleML(!(netML?.enabled ?? true))}
            className={`px-3 py-1.5 rounded-md font-mono text-xs border cursor-pointer whitespace-nowrap shrink-0 ${
              netML?.enabled
                ? 'bg-emerald-950/50 border-emerald-700/60 text-emerald-300'
                : 'bg-slate-800 border-slate-700 text-slate-400'
            }`}
          >
            Network ML: {netML?.enabled ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* SECTION A: NETWORK QUALITY CLASSIFICATION (RANDOM FOREST CLASSIFIER) */}
      <section className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-[#1E2E4A]">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              A. Network Quality Classification (Random Forest Classifier)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Target Link: <span className="font-mono text-slate-300">NODE2_NODE3_WIFI</span> · Classes: GOOD / MODERATE / POOR · 6 link features
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs font-mono tabular-nums">
            <span>
              Status:{' '}
              <strong className={availabilityTextClass(clf?.availability)}>
                {clf?.availability ?? 'UNAVAILABLE'}
              </strong>
            </span>
            <span className="text-slate-300">
              Version: <strong>{clf?.model_version || '—'}</strong>
            </span>
            <span className="text-slate-300">
              Timestamp: <strong>{formatTimestamp(clf?.prediction_timestamp)}</strong>
              {clf?.age_seconds !== null && clf?.age_seconds !== undefined
                ? ` (${clf.age_seconds}s ago)`
                : ''}
            </span>
            <span className="text-sky-400">
              Source: <strong>{latestClf?.data_source || clf?.data_source || dataSourceLabel}</strong>
            </span>
          </div>
        </div>

        {clf?.stale_reason && (
          <div className="px-3.5 py-2.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A] text-xs font-mono text-amber-300">
            {clf.stale_reason}
          </div>
        )}

        {/* 6 Input Features Strip */}
        <div className="p-3.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A] flex flex-wrap items-center justify-between gap-4 text-xs font-mono tabular-nums">
          <span className="text-slate-400 font-sans font-medium">
            NODE2_NODE3_WIFI Classification Inputs (6):
          </span>
          {clfFeat ? (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-slate-200">
              <span>RSSI: <strong className="text-sky-400">{clfFeat.rssi} dBm</strong></span>
              <span>RSSI Var: <strong>{clfFeat.rssi_variation} dB</strong></span>
              <span>Packet Loss: <strong>{(clfFeat.packet_loss_ratio * 100).toFixed(1)}%</strong></span>
              <span>ACK Latency: <strong>{clfFeat.ack_latency_ms} ms</strong></span>
              <span>Retries: <strong>{clfFeat.retry_count}</strong></span>
              <span>Queue Depth: <strong>{clfFeat.queue_depth}</strong></span>
            </div>
          ) : (
            <span className="text-slate-500">Awaiting NODE2_NODE3_WIFI metrics in SQLite</span>
          )}
        </div>

        {/* Current Class & Probability Distribution */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="p-4 rounded-lg bg-[#0B1324] border border-[#1E2E4A] flex flex-col justify-between">
            <div className="text-xs text-slate-400">Predicted Network Quality</div>
            <div
              className={`text-2xl font-mono font-semibold mt-2 ${
                clfReady ? qualityTextClass(latestClf?.predicted_class) : 'text-slate-400'
              }`}
            >
              {clfReady
                ? latestClf?.predicted_class
                : clf?.availability === 'DISABLED'
                  ? 'DISABLED'
                  : clf?.availability ?? 'UNAVAILABLE'}
            </div>
            <div className="text-[11px] font-mono text-slate-500 mt-2 tabular-nums">
              {clfReady && latestClf?.confidence !== null
                ? `Top Class Confidence: ${(latestClf.confidence * 100).toFixed(1)}%`
                : 'No active prediction — missing values never fabricated'}
            </div>
          </div>

          <div className="lg:col-span-2 p-4 rounded-lg bg-[#0B1324] border border-[#1E2E4A] space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Class Probabilities (GOOD / MODERATE / POOR)</span>
              <span className="font-mono text-slate-500 text-[11px]">
                {clfReady && latestClf?.probabilities ? 'External RF Softmax' : 'Awaiting READY prediction'}
              </span>
            </div>
            {(['GOOD', 'MODERATE', 'POOR'] as const).map((cls) => {
              const prob =
                clfReady && latestClf?.probabilities ? latestClf.probabilities[cls] : null;
              const pct = prob !== null ? Number((prob * 100).toFixed(1)) : null;
              const barColor =
                cls === 'GOOD'
                  ? 'bg-emerald-500'
                  : cls === 'MODERATE'
                    ? 'bg-amber-500'
                    : 'bg-rose-500';
              return (
                <div key={cls} className="space-y-1">
                  <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                    <span className={qualityTextClass(cls)}>{cls}</span>
                    <span className="text-slate-200">{pct !== null ? `${pct}%` : '—'}</span>
                  </div>
                  <div className="h-2 rounded bg-slate-800/90 overflow-hidden">
                    {pct !== null && (
                      <div
                        className={`h-full ${barColor} transition-all duration-300`}
                        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Historical Network Quality & Classification Evaluation */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-1">
          <div className="p-4 rounded-lg bg-[#0B1324] border border-[#1E2E4A] space-y-3">
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-semibold text-slate-200">
                Historical Network Quality Probabilities (%)
              </h3>
              <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                {clf?.history.length ?? 0} predictions
              </span>
            </div>
            <div className="h-56">
              {clfHistoryChart.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-slate-500 text-center px-4">
                  No external Random Forest Classifier predictions received yet for NODE2_NODE3_WIFI ({dataSourceLabel}).
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={clfHistoryChart}>
                    <CartesianGrid stroke="#1E2E4A" strokeDasharray="3 3" />
                    <XAxis dataKey="time" stroke="#64748B" tick={{ fontSize: 11 }} />
                    <YAxis stroke="#64748B" tick={{ fontSize: 11 }} domain={[0, 100]} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#0D1526',
                        border: '1px solid #1E2E4A',
                        borderRadius: '8px',
                        fontSize: '12px',
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                    <Line type="monotone" dataKey="GOOD" name="P(GOOD) %" stroke="#10B981" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="MODERATE" name="P(MODERATE) %" stroke="#F59E0B" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="POOR" name="P(POOR) %" stroke="#F43F5E" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="p-4 rounded-lg bg-[#0B1324] border border-[#1E2E4A] space-y-3">
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-semibold text-slate-200">
                Confusion Matrix & Evaluation Metrics ({dataSourceLabel})
              </h3>
              <span className="text-[11px] font-mono text-slate-500">
                {clf?.evaluation ? clf.evaluation.model_version : 'Not uploaded'}
              </span>
            </div>

            {!clf?.evaluation ? (
              <div className="h-56 flex items-center justify-center text-xs text-slate-500 text-center px-4">
                No classification evaluation metrics or confusion matrix uploaded yet for {dataSourceLabel}.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3 text-xs font-mono tabular-nums">
                  <div className="p-2.5 rounded bg-[#111C30] border border-[#1E2E4A]">
                    <div className="text-slate-400 font-sans text-[11px]">Accuracy</div>
                    <div className="text-base font-semibold text-emerald-400 mt-0.5">
                      {(clf.evaluation.accuracy * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div className="p-2.5 rounded bg-[#111C30] border border-[#1E2E4A]">
                    <div className="text-slate-400 font-sans text-[11px]">Macro F1</div>
                    <div className="text-base font-semibold text-sky-400 mt-0.5">
                      {clf.evaluation.macro_f1.toFixed(3)}
                    </div>
                  </div>
                  <div className="p-2.5 rounded bg-[#111C30] border border-[#1E2E4A]">
                    <div className="text-slate-400 font-sans text-[11px]">Samples</div>
                    <div className="text-base font-semibold text-slate-100 mt-0.5">
                      {clf.evaluation.sample_count}
                    </div>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono tabular-nums text-center border-collapse">
                    <thead>
                      <tr className="text-slate-400 border-b border-[#1E2E4A]">
                        <th className="py-1.5 px-2 text-left font-sans">Actual \ Pred</th>
                        <th className="py-1.5 px-2 text-emerald-400">GOOD</th>
                        <th className="py-1.5 px-2 text-amber-400">MODERATE</th>
                        <th className="py-1.5 px-2 text-rose-400">POOR</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1E2E4A]">
                      {clf.evaluation.confusion_matrix.labels.map((label, rIdx) => (
                        <tr key={label}>
                          <td className={`py-2 px-2 text-left font-semibold ${qualityTextClass(label)}`}>
                            {label}
                          </td>
                          {clf.evaluation!.confusion_matrix.matrix[rIdx].map((val, cIdx) => (
                            <td
                              key={cIdx}
                              className={`py-2 px-2 ${
                                rIdx === cIdx
                                  ? 'text-slate-100 font-semibold bg-slate-800/50'
                                  : 'text-slate-400'
                              }`}
                            >
                              {val}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {clf.evaluation.per_class && (
                  <div className="overflow-x-auto pt-1">
                    <table className="w-full text-[11px] font-mono tabular-nums text-center border-collapse">
                      <thead>
                        <tr className="text-slate-400 border-b border-[#1E2E4A]">
                          <th className="py-1 px-2 text-left font-sans">Class</th>
                          <th className="py-1 px-2">Precision</th>
                          <th className="py-1 px-2">Recall</th>
                          <th className="py-1 px-2">F1</th>
                          <th className="py-1 px-2">Support</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1E2E4A]">
                        {(['GOOD', 'MODERATE', 'POOR'] as const).map((cls) => {
                          const row = clf.evaluation!.per_class![cls];
                          if (!row) return null;
                          return (
                            <tr key={cls}>
                              <td className={`py-1.5 px-2 text-left font-semibold ${qualityTextClass(cls)}`}>
                                {cls}
                              </td>
                              <td className="py-1.5 px-2 text-slate-200">{(row.precision * 100).toFixed(1)}%</td>
                              <td className="py-1.5 px-2 text-slate-200">{(row.recall * 100).toFixed(1)}%</td>
                              <td className="py-1.5 px-2 text-slate-200">{row.f1.toFixed(3)}</td>
                              <td className="py-1.5 px-2 text-slate-400">{row.support}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="text-[11px] font-mono text-slate-500 flex flex-wrap justify-between gap-2">
                  <span>Split: {clf.evaluation.split_method}</span>
                  <span>Evaluated: {formatTimestamp(clf.evaluation.evaluated_at)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* SECTION B: PREDICTIVE TRANSMISSION SCHEDULING (RANDOM FOREST REGRESSOR) */}
      <section className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-[#1E2E4A]">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              B. Predictive Transmission Scheduling (Random Forest Regressor)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Target Link: <span className="font-mono text-slate-300">NODE2_NODE3_WIFI</span> · Advisory estimated wait until next suitable Node 2 → Node 3 Wi-Fi opportunity (does not guarantee reconnection or override ACKs/retries)
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs font-mono tabular-nums">
            <span>
              Status:{' '}
              <strong className={availabilityTextClass(sch?.availability)}>
                {sch?.availability ?? 'UNAVAILABLE'}
              </strong>
            </span>
            <span className="text-slate-300">
              Version: <strong>{sch?.model_version || '—'}</strong>
            </span>
            <span className="text-slate-300">
              Timestamp: <strong>{formatTimestamp(sch?.prediction_timestamp)}</strong>
              {sch?.age_seconds !== null && sch?.age_seconds !== undefined
                ? ` (${sch.age_seconds}s ago)`
                : ''}
            </span>
            <span className="text-sky-400">
              Source: <strong>{latestSch?.data_source || sch?.data_source || dataSourceLabel}</strong>
            </span>
          </div>
        </div>

        {sch?.stale_reason && (
          <div className="px-3.5 py-2.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A] text-xs font-mono text-amber-300">
            {sch.stale_reason}
          </div>
        )}

        {/* 10 Input Features Strip */}
        <div className="p-3.5 rounded-lg bg-[#0B1324] border border-[#1E2E4A] space-y-2 text-xs font-mono tabular-nums">
          <div className="text-slate-400 font-sans font-medium">
            NODE2_NODE3_WIFI Scheduling Inputs (10):
          </div>
          {schFeat ? (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-slate-200 pt-1">
              <div>RSSI: <strong className="text-sky-400">{schFeat.rssi} dBm</strong></div>
              <div>RSSI Var: <strong>{schFeat.rssi_variation} dB</strong></div>
              <div>Packet Loss: <strong>{(schFeat.packet_loss_ratio * 100).toFixed(1)}%</strong></div>
              <div>ACK Latency: <strong>{schFeat.ack_latency_ms} ms</strong></div>
              <div>Retries: <strong>{schFeat.retry_count}</strong></div>
              <div>Queue Depth: <strong>{schFeat.queue_depth}</strong></div>
              <div>
                Wi-Fi Avail: <strong>{(schFeat.wifi_availability_history * 100).toFixed(1)}%</strong>
              </div>
              <div>Conn Duration: <strong>{schFeat.connection_duration} s</strong></div>
              <div>Hour (UTC): <strong>{String(schFeat.hour).padStart(2, '0')}:00</strong></div>
              <div>
                Day: <strong>{DAY_NAMES[schFeat.day_of_week] ?? schFeat.day_of_week} ({schFeat.day_of_week})</strong>
              </div>
            </div>
          ) : (
            <div className="text-slate-500">Awaiting NODE2_NODE3_WIFI metrics in SQLite</div>
          )}
        </div>

        {/* Scheduling Output Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-mono tabular-nums">
          <div className="p-4 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
            <div className="text-slate-400 font-sans">Advisory Predicted Wait</div>
            <div className={`text-2xl font-semibold mt-1.5 ${schReady ? 'text-sky-400' : 'text-slate-400'}`}>
              {schReady && latestSch?.predicted_wait_seconds !== null
                ? `${latestSch.predicted_wait_seconds.toFixed(1)} s`
                : '—'}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              {schReady
                ? 'Estimated wait (advisory only)'
                : `Status: ${latestSch?.prediction_status ?? sch?.availability ?? 'UNAVAILABLE'}`}
            </div>
          </div>

          <div className="p-4 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
            <div className="text-slate-400 font-sans">Observation Status</div>
            <div className={`text-lg font-semibold mt-2 ${availabilityTextClass(sch?.availability)}`}>
              {latestSch?.observation_censored
                ? 'CENSORED'
                : latestSch?.prediction_status ?? sch?.availability ?? 'UNAVAILABLE'}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Link state: {netML?.scheduling_context.current_link_state ?? 'UNKNOWN'}
            </div>
          </div>

          <div className="p-4 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
            <div className="text-slate-400 font-sans">Latest Actual Wait</div>
            <div className="text-2xl font-semibold text-emerald-400 mt-1.5">
              {latestSch?.actual_wait_seconds !== null && latestSch?.actual_wait_seconds !== undefined
                ? `${latestSch.actual_wait_seconds.toFixed(1)} s`
                : '—'}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              {latestSch?.observation_censored
                ? 'Right-censored (not resolved)'
                : latestSch?.actual_wait_seconds !== null && latestSch?.actual_wait_seconds !== undefined
                  ? 'Observed on N2→N3 reconnect'
                  : 'Pending reconnection event'}
            </div>
          </div>

          <div className="p-4 rounded-lg bg-[#0B1324] border border-[#1E2E4A]">
            <div className="text-slate-400 font-sans">Regression Benchmark ({dataSourceLabel})</div>
            {sch?.evaluation ? (
              <>
                <div className="text-base font-semibold text-slate-100 mt-1.5">
                  MAE {sch.evaluation.mae.toFixed(2)} s · RMSE {sch.evaluation.rmse.toFixed(2)} s
                </div>
                <div className="text-[11px] text-slate-500 mt-1">
                  n={sch.evaluation.sample_count}
                  {sch.evaluation.censored_count !== undefined
                    ? ` · censored=${sch.evaluation.censored_count}`
                    : ''}
                  {sch.evaluation.r2 !== undefined ? ` · R²=${sch.evaluation.r2.toFixed(3)}` : ''}
                </div>
              </>
            ) : (
              <>
                <div className="text-lg font-semibold text-slate-500 mt-1.5">— / —</div>
                <div className="text-[11px] text-slate-500 mt-1">Awaiting MAE / RMSE evaluation</div>
              </>
            )}
          </div>
        </div>

        {/* Scheduling Charts: Historical Predicted Wait & Actual vs Predicted */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-1">
          <div className="p-4 rounded-lg bg-[#0B1324] border border-[#1E2E4A] space-y-3">
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-semibold text-slate-200">
                Historical Predicted Waiting Time (seconds)
              </h3>
              <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                {sch?.history.length ?? 0} records
              </span>
            </div>
            <div className="h-56">
              {schHistoryChart.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-slate-500 text-center px-4">
                  No valid numerical scheduling predictions received yet for NODE2_NODE3_WIFI ({dataSourceLabel}).
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={schHistoryChart}>
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
                    <Line
                      type="monotone"
                      dataKey="predicted"
                      name="Predicted Wait (s)"
                      stroke="#38BDF8"
                      strokeWidth={2}
                      dot
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="p-4 rounded-lg bg-[#0B1324] border border-[#1E2E4A] space-y-3">
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-semibold text-slate-200">
                Actual vs. Predicted Waiting Time (seconds)
              </h3>
              <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                {actualVsPredictedChart.length} observed pairs
              </span>
            </div>
            <div className="h-56">
              {actualVsPredictedChart.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-slate-500 text-center px-4">
                  No closed uncensored reconnection intervals observed yet to compare actual vs. predicted waiting time.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={actualVsPredictedChart}>
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
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                    <Line
                      type="monotone"
                      dataKey="predicted"
                      name="Predicted (s)"
                      stroke="#38BDF8"
                      strokeWidth={2}
                      dot
                    />
                    <Line
                      type="monotone"
                      dataKey="actual"
                      name="Actual (s)"
                      stroke="#10B981"
                      strokeWidth={2}
                      dot
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
