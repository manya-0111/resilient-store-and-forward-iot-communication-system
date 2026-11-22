import React, { useEffect, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import { iotApi } from '../services/api';
import type { OperatingMode, SensorReading, SystemSettings } from '../types/iot';

interface Props {
  mode: OperatingMode;
  settings: SystemSettings;
  refreshTick: number;
  onSettingsUpdated: () => void;
}

export const LiveSensorsPage: React.FC<Props> = ({
  mode,
  settings,
  refreshTick,
  onSettingsUpdated,
}) => {
  const [readings, setReadings] = useState<SensorReading[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [normalThresh, setNormalThresh] = useState(settings.rain_normal_threshold);
  const [heavyThresh, setHeavyThresh] = useState(settings.rain_heavy_threshold);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    setNormalThresh(settings.rain_normal_threshold);
    setHeavyThresh(settings.rain_heavy_threshold);
  }, [settings.rain_normal_threshold, settings.rain_heavy_threshold]);

  useEffect(() => {
    let active = true;
    iotApi
      .getSensorsHistory(mode, 80)
      .then((res) => {
        if (active) {
          setReadings(res.readings);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load sensor readings from backend API.');
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [mode, refreshTick, retryCount]);

  const latest = readings.length > 0 ? readings[readings.length - 1] : null;

  const chartData = readings.map((r) => ({
    time: new Date(r.recorded_at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
    temperature: r.temperature,
    humidity: r.humidity,
    rain_raw: r.rain_raw,
    packet_id: r.packet_id,
    rain_category: r.rain_category,
  }));

  const handleSaveThresholds = async (e: React.FormEvent) => {
    e.preventDefault();
    if (heavyThresh <= normalThresh) {
      setSaveMsg('Heavy-rain threshold must be strictly greater than Normal wetness threshold.');
      return;
    }
    try {
      await iotApi.updateSettings({
        rain_normal_threshold: normalThresh,
        rain_heavy_threshold: heavyThresh,
      });
      setSaveMsg('Calibration thresholds updated in backend configuration.');
      onSettingsUpdated();
    } catch (err) {
      setSaveMsg(`Error saving thresholds: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-rose-950/50 border border-rose-700/60 rounded-xl px-4 py-3 flex items-center justify-between gap-4 text-xs">
          <span className="font-mono text-rose-300">Sensor API Error: {error}</span>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-3 py-1 rounded-md bg-rose-700 hover:bg-rose-600 text-white font-medium whitespace-nowrap cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}
      {/* Live Authenticated Readings Header Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <div className="text-xs text-slate-400">Temperature (DHT11)</div>
          <div className="text-3xl font-mono font-semibold text-sky-400 tabular-nums mt-2">
            {latest ? `${latest.temperature.toFixed(1)} °C` : '—'}
          </div>
          <div className="text-xs font-mono text-slate-500 mt-2">Authenticated at Node 3</div>
        </div>

        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <div className="text-xs text-slate-400">Humidity (DHT11)</div>
          <div className="text-3xl font-mono font-semibold text-blue-400 tabular-nums mt-2">
            {latest ? `${latest.humidity.toFixed(1)} %` : '—'}
          </div>
          <div className="text-xs font-mono text-slate-500 mt-2">Relative humidity</div>
        </div>

        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <div className="text-xs text-slate-400">Raindrop Sensor Raw ADC</div>
          <div className="text-3xl font-mono font-semibold text-slate-100 tabular-nums mt-2">
            {latest ? latest.rain_raw : '—'}
          </div>
          <div className="text-xs font-mono text-slate-500 mt-2">
            Classification:{' '}
            <span
              className={
                latest?.rain_category === 'HEAVY'
                  ? 'text-rose-400'
                  : latest?.rain_category === 'NORMAL'
                    ? 'text-amber-400'
                    : 'text-emerald-400'
              }
            >
              {latest ? latest.rain_category : '—'}
            </span>
          </div>
        </div>

        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
          <div className="text-xs text-slate-400">Priority & Last Update</div>
          <div
            className={`text-xl font-mono font-semibold mt-2 ${
              latest?.priority === 1 ? 'text-rose-400' : 'text-emerald-400'
            }`}
          >
            {latest
              ? latest.priority === 1
                ? 'HIGH PRIORITY ALERT'
                : 'ROUTINE'
              : 'NO DATA'}
          </div>
          <div className="text-xs font-mono text-slate-500 mt-2 tabular-nums">
            {latest ? new Date(latest.recorded_at).toLocaleString() : 'Awaiting authenticated packet'}
          </div>
        </div>
      </div>

      {/* Deterministic Priority & Calibration Notice */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-2 text-xs text-slate-300 leading-relaxed">
          <h3 className="text-sm font-semibold text-slate-100">
            Deterministic Priority Rules & Raindrop Sensor Calibration Assumptions
          </h3>
          <p className="text-slate-400">
            A low-cost resistive raindrop sensor board measures <strong className="text-slate-200">surface wetness (ADC voltage)</strong>, not calibrated rainfall intensity in mm/hour. Readings are mapped to three deterministic wetness categories:
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-1.5 font-mono text-xs pt-1">
            <span className="text-emerald-400">● DRY (&lt; {settings.rain_normal_threshold}): Routine (P2)</span>
            <span className="text-amber-400">▲ NORMAL ({settings.rain_normal_threshold}–{settings.rain_heavy_threshold - 1}): Routine (P2)</span>
            <span className="text-rose-400">✖ HEAVY (≥ {settings.rain_heavy_threshold}): HIGH PRIORITY ALERT (P1)</span>
          </div>
          <p className="text-slate-400 pt-1">
            Heavy-rain packets are always scheduled ahead of routine temperature/humidity telemetry in both Node 1 LittleFS and Node 2 microSD queues; routine packets are retained and delivered afterward rather than discarded.
          </p>
        </div>

        <form onSubmit={handleSaveThresholds} className="space-y-3 border-t lg:border-t-0 lg:border-l border-[#1E2E4A] pt-4 lg:pt-0 lg:pl-6">
          <h4 className="text-xs font-semibold text-slate-200">Wetness Classification Thresholds (ADC)</h4>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-slate-400">
              Normal ≥
              <input
                type="number"
                min={50}
                max={800}
                value={normalThresh}
                onChange={(e) => setNormalThresh(Number(e.target.value))}
                className="mt-1 w-full px-2.5 py-1.5 rounded-md bg-[#0B1324] border border-[#2A3F63] font-mono text-slate-100 tabular-nums"
              />
            </label>
            <label className="block text-xs text-slate-400">
              Heavy ≥
              <input
                type="number"
                min={200}
                max={1000}
                value={heavyThresh}
                onChange={(e) => setHeavyThresh(Number(e.target.value))}
                className="mt-1 w-full px-2.5 py-1.5 rounded-md bg-[#0B1324] border border-[#2A3F63] font-mono text-slate-100 tabular-nums"
              />
            </label>
          </div>
          <button
            type="submit"
            className="w-full px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 hover:bg-blue-500 text-white transition-colors cursor-pointer"
          >
            Save Thresholds
          </button>
          {saveMsg && <div className="text-[11px] font-mono text-sky-300">{saveMsg}</div>}
        </form>
      </div>

      {/* Charts */}
      {loading ? (
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-10 text-center text-sm text-slate-400">
          Loading sensor time-series from SQLite...
        </div>
      ) : chartData.length === 0 ? (
        <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-10 text-center text-sm text-slate-400">
          No authenticated sensor readings recorded in {mode === 'hardware' ? 'Live Hardware Mode' : 'Simulation Mode'} yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Temperature Chart */}
          <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
            <div className="flex items-baseline justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-100">Temperature Over Time (°C)</h3>
              <span className="text-xs font-mono text-slate-500">{chartData.length} samples</span>
            </div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid stroke="#1E2E4A" strokeDasharray="3 3" />
                  <XAxis dataKey="time" stroke="#64748B" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#64748B" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
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
                    dataKey="temperature"
                    name="Temperature (°C)"
                    stroke="#38BDF8"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Humidity Chart */}
          <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5">
            <div className="flex items-baseline justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-100">Humidity Over Time (% RH)</h3>
              <span className="text-xs font-mono text-slate-500">{chartData.length} samples</span>
            </div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
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
                  <Line
                    type="monotone"
                    dataKey="humidity"
                    name="Humidity (%)"
                    stroke="#60A5FA"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Raindrop Sensor Chart */}
          <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5 lg:col-span-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
              <h3 className="text-sm font-semibold text-slate-100">
                Raindrop Surface Wetness Over Time (Raw ADC · 0–1023)
              </h3>
              <span className="text-xs font-mono text-slate-400">
                Normal ≥ {settings.rain_normal_threshold} · Heavy Alert ≥ {settings.rain_heavy_threshold}
              </span>
            </div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <CartesianGrid stroke="#1E2E4A" strokeDasharray="3 3" />
                  <XAxis dataKey="time" stroke="#64748B" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#64748B" tick={{ fontSize: 11 }} domain={[0, 1024]} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0D1526',
                      border: '1px solid #1E2E4A',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <ReferenceLine
                    y={settings.rain_heavy_threshold}
                    stroke="#EF4444"
                    strokeDasharray="4 4"
                    label={{ value: 'Heavy Alert', fill: '#F87171', fontSize: 11, position: 'insideTopRight' }}
                  />
                  <ReferenceLine
                    y={settings.rain_normal_threshold}
                    stroke="#F59E0B"
                    strokeDasharray="4 4"
                    label={{ value: 'Normal Wetness', fill: '#FBBF24', fontSize: 11, position: 'insideTopRight' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="rain_raw"
                    name="Raindrop Raw ADC"
                    stroke="#3B82F6"
                    fill="#3B82F6"
                    fillOpacity={0.18}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
