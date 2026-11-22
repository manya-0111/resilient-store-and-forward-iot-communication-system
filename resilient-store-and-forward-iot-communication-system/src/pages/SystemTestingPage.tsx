import React, { useEffect, useState } from 'react';
import { Play, RotateCcw, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { iotApi } from '../services/api';
import type { TestResultRecord } from '../types/iot';

interface Props {
  onRefreshGlobal: () => void;
}

export const SystemTestingPage: React.FC<Props> = ({ onRefreshGlobal }) => {
  const [tests, setTests] = useState<TestResultRecord[]>([]);
  const [summary, setSummary] = useState({ total: 8, passed: 0, failed: 0, not_run: 8 });
  const [runningId, setRunningId] = useState<number | 'ALL' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadTests = async () => {
    try {
      const res = await iotApi.getTests();
      setTests(res.tests);
      setSummary(res.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    loadTests();
  }, []);

  const handleRunTest = async (testId?: number) => {
    setError(null);
    setRunningId(testId ?? 'ALL');
    try {
      const res = await iotApi.runTest(testId);
      setTests(res.tests);
      setSummary(res.summary);
      onRefreshGlobal();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningId(null);
    }
  };

  const handleReset = async () => {
    setError(null);
    try {
      const res = await iotApi.resetTests();
      setTests(res.tests);
      setSummary(res.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Summary */}
      <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            System Verification Test Suite (PDF Page 12 · 8 Acceptance Scenarios)
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Each test executes live state transitions in the SQLite backend, real AES-128-GCM cryptography, persistent queue verification, and ACK matching (Simulation Verification Mode).
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums">
            <span className="text-slate-300">Total: {summary.total}</span>
            <span className="text-emerald-400">● Passed: {summary.passed}</span>
            <span className="text-rose-400">✖ Failed: {summary.failed}</span>
            <span className="text-slate-400">Pending: {summary.not_run}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={runningId !== null}
            onClick={() => handleRunTest()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            {runningId === 'ALL' ? 'Running All 8 Tests...' : 'Run All 8 Tests'}
          </button>
          <button
            type="button"
            disabled={runningId !== null}
            onClick={handleReset}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-[#0B1324] hover:bg-slate-800 text-slate-300 border border-[#2A3F63] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Results
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3.5 rounded-lg bg-rose-950/60 border border-rose-700/60 text-xs font-mono text-rose-300">
          Test execution error: {error}
        </div>
      )}

      {/* 8 Interactive Test Case Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {tests.map((test) => {
          const isRunning = runningId === test.test_id || runningId === 'ALL';
          return (
            <div
              key={test.test_id}
              className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-5 flex flex-col justify-between gap-4"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-mono text-sky-400">TEST {test.test_id}</div>
                    <h3 className="text-sm font-semibold text-slate-100 mt-0.5">{test.test_name}</h3>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {test.passed === true && (
                      <span className="inline-flex items-center gap-1 text-xs font-mono text-emerald-400">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        PASS
                      </span>
                    )}
                    {test.passed === false && (
                      <span className="inline-flex items-center gap-1 text-xs font-mono text-rose-400">
                        <XCircle className="w-3.5 h-3.5" />
                        FAIL
                      </span>
                    )}
                    {test.passed === null && (
                      <span className="inline-flex items-center gap-1 text-xs font-mono text-slate-500">
                        <Clock className="w-3.5 h-3.5" />
                        NOT RUN
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={runningId !== null}
                      onClick={() => handleRunTest(test.test_id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-[#0B1324] hover:bg-blue-600 text-slate-200 hover:text-white border border-[#2A3F63] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                    >
                      <Play className="w-3 h-3" />
                      {isRunning ? 'Running...' : 'Run Test'}
                    </button>
                  </div>
                </div>

                {/* Initial Link Configuration */}
                <div className="mt-3 pt-3 border-t border-[#1E2E4A] flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-slate-400">
                  <span>N1–N2 Wi-Fi: <strong className="text-slate-200">{test.initial_config.node1_wifi}</strong></span>
                  <span>N1–N2 LoRa: <strong className="text-slate-200">{test.initial_config.node1_lora}</strong></span>
                  <span>N2–N3 Wi-Fi: <strong className="text-slate-200">{test.initial_config.node2_node3_wifi}</strong></span>
                </div>

                {/* Expected vs Actual */}
                <div className="mt-3 space-y-1.5 text-xs">
                  <div>
                    <span className="text-slate-500">Expected: </span>
                    <span className="text-slate-300">{test.expected_result}</span>
                  </div>
                  {test.actual_result && (
                    <div>
                      <span className="text-slate-500">Actual: </span>
                      <span className={test.passed ? 'text-emerald-300 font-mono' : 'text-rose-300 font-mono'}>
                        {test.actual_result}
                      </span>
                    </div>
                  )}
                </div>

                {/* Execution Trace */}
                {test.steps && test.steps.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-[#1E2E4A] space-y-1.5">
                    {test.steps.map((st) => (
                      <div key={st.step} className="text-[11px] font-mono flex items-start gap-2">
                        <span
                          className={
                            st.status === 'PASS'
                              ? 'text-emerald-400'
                              : st.status === 'REJECTED'
                                ? 'text-rose-400'
                                : st.status === 'WARN'
                                  ? 'text-amber-400'
                                  : 'text-sky-400'
                          }
                        >
                          [{st.step}]
                        </span>
                        <span className="text-slate-300">{st.label}:</span>
                        <span className="text-slate-400">{st.detail}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {test.executed_at && (
                <div className="text-[11px] font-mono text-slate-500 flex justify-between pt-2 border-t border-[#1E2E4A] tabular-nums">
                  <span>Packet Ref: {test.packet_id ? `#${test.packet_id}` : '—'}</span>
                  <span>Executed: {new Date(test.executed_at).toLocaleString()}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
