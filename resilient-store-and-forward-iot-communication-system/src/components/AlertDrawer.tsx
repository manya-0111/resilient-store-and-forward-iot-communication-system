import React from 'react';
import { X, CheckCheck } from 'lucide-react';
import type { AlertRecord } from '../types/iot';

interface Props {
  open: boolean;
  alerts: AlertRecord[];
  onClose: () => void;
  onMarkAllRead: () => void;
}

export const AlertDrawer: React.FC<Props> = ({ open, alerts, onClose, onMarkAllRead }) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/55">
      <div className="w-full max-w-md bg-[#0D1526] border-l border-[#1E2E4A] h-full flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1E2E4A]">
          <div>
            <h2 className="text-base font-semibold text-slate-100">System Alerts & Notifications</h2>
            <p className="text-xs text-slate-400 mt-0.5 font-mono tabular-nums">
              {alerts.filter((a) => !a.is_read).length} unread · {alerts.length} total recorded
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onMarkAllRead}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-[#111C30] border border-[#1E2E4A] rounded-md cursor-pointer whitespace-nowrap"
            >
              <CheckCheck className="w-3.5 h-3.5" />
              Mark all read
            </button>
            <button
              type="button"
              aria-label="Close alerts panel"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-100 rounded-md cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-[#1E2E4A]">
          {alerts.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">
              No system alerts recorded in the current operating mode.
            </div>
          ) : (
            alerts.map((alert) => {
              const sevColor =
                alert.severity === 'CRITICAL'
                  ? 'text-rose-400'
                  : alert.severity === 'WARNING'
                    ? 'text-amber-400'
                    : 'text-sky-400';
              const sevGlyph =
                alert.severity === 'CRITICAL' ? '✖' : alert.severity === 'WARNING' ? '▲' : '●';

              return (
                <div
                  key={alert.id}
                  className={`px-5 py-3.5 ${alert.is_read ? 'opacity-75' : 'bg-[#111C30]/60'}`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs font-mono">
                    <span className={sevColor}>
                      {sevGlyph} {alert.severity} · {alert.category.replace(/_/g, ' ')}
                    </span>
                    <span className="text-slate-400">{alert.related_node}</span>
                  </div>
                  <p className="text-xs text-slate-200 mt-1.5 leading-relaxed">{alert.message}</p>
                  <div className="text-[11px] font-mono text-slate-500 mt-1.5 tabular-nums">
                    {new Date(alert.created_at).toLocaleString()}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
