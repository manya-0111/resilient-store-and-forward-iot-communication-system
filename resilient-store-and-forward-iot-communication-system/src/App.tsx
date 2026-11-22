import React, { useCallback, useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Thermometer,
  Network,
  Radio,
  Package,
  HardDrive,
  ShieldCheck,
  Brain,
  History,
  FlaskConical,
  Cpu,
  Settings,
  Bell,
  Menu,
  X,
  AlertCircle,
} from 'lucide-react';
import { iotApi } from './services/api';
import type { AlertRecord, NavSectionId, OperatingMode, SystemStatusResponse } from './types/iot';
import { SimulationToolbar } from './components/SimulationToolbar';
import { AlertDrawer } from './components/AlertDrawer';
import { OverviewPage } from './pages/OverviewPage';
import { LiveSensorsPage } from './pages/LiveSensorsPage';
import { NodeArchitecturePage } from './pages/NodeArchitecturePage';
import { CommunicationPage } from './pages/CommunicationPage';
import { PacketManagementPage } from './pages/PacketManagementPage';
import { StorageManagementPage } from './pages/StorageManagementPage';
import { SecurityMonitoringPage } from './pages/SecurityMonitoringPage';
import { MLAnalyticsPage } from './pages/MLAnalyticsPage';
import { HistoricalDataPage } from './pages/HistoricalDataPage';
import { SystemTestingPage } from './pages/SystemTestingPage';
import { HardwareStatusPage } from './pages/HardwareStatusPage';
import { SettingsApiPage } from './pages/SettingsApiPage';

const NAV_ITEMS: Array<{
  id: NavSectionId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'sensors', label: 'Live Sensor Monitoring', icon: Thermometer },
  { id: 'nodes', label: 'Node Architecture', icon: Network },
  { id: 'communication', label: 'Communication Monitoring', icon: Radio },
  { id: 'packets', label: 'Packet Management', icon: Package },
  { id: 'storage', label: 'Storage Management', icon: HardDrive },
  { id: 'security', label: 'Security Monitoring', icon: ShieldCheck },
  { id: 'ml', label: 'ML Analytics', icon: Brain },
  { id: 'history', label: 'Historical Data', icon: History },
  { id: 'testing', label: 'System Testing', icon: FlaskConical },
  { id: 'hardware', label: 'Hardware Status', icon: Cpu },
  { id: 'settings', label: 'Settings & API Status', icon: Settings },
];

export function App() {
  const [activeNav, setActiveNav] = useState<NavSectionId>('overview');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [status, setStatus] = useState<SystemStatusResponse | null>(null);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [clock, setClock] = useState<string>(() => new Date().toLocaleString());

  const fetchAll = useCallback(async () => {
    try {
      const st = await iotApi.getStatus();
      setStatus(st);
      setBackendError(null);
      const al = await iotApi.getAlerts(st.mode);
      setAlerts(al.alerts);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      setBackendError(
        err instanceof Error ? err.message : 'Unable to reach Resilient IoT backend API.'
      );
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const poll = setInterval(fetchAll, 2500);
    return () => clearInterval(poll);
  }, [fetchAll]);

  useEffect(() => {
    const timer = setInterval(() => {
      setClock(new Date().toLocaleString());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleModeSwitch = async (nextMode: OperatingMode) => {
    try {
      await iotApi.updateSettings({ active_mode: nextMode });
      await fetchAll();
    } catch (err) {
      setBackendError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleMarkAlertsRead = async () => {
    if (!status) return;
    try {
      await iotApi.markAlertsRead(status.mode);
      await fetchAll();
    } catch (err) {
      setBackendError(err instanceof Error ? err.message : String(err));
    }
  };

  const currentNavObj = NAV_ITEMS.find((n) => n.id === activeNav)!;
  const unreadCount = status?.summary.unread_alerts ?? 0;

  return (
    <div className="min-h-screen bg-[#080E1A] text-slate-100 flex">
      {/* Mobile Sidebar Backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Left Sidebar Navigation */}
      <aside
        className={`fixed lg:sticky top-0 left-0 z-40 h-screen w-64 shrink-0 bg-[#0D1526] border-r border-[#1E2E4A] flex flex-col transition-transform duration-200 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="px-5 py-5 border-b border-[#1E2E4A] flex items-start justify-between gap-2">
          <div>
            <div className="text-sm font-bold tracking-tight text-slate-100 leading-snug">
              RESILIENT IoT MONITORING SYSTEM
            </div>
            <div className="text-[11px] text-slate-400 mt-1 leading-snug">
              Store-and-Forward · Secure · Fault-Tolerant
            </div>
          </div>
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-1 text-slate-400 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Switcher */}
        <div className="px-4 py-3 border-b border-[#1E2E4A]">
          <div className="grid grid-cols-2 gap-1 p-1 bg-[#080E1A] border border-[#1E2E4A] rounded-lg">
            <button
              type="button"
              onClick={() => handleModeSwitch('simulation')}
              className={`px-2 py-1.5 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                status?.mode !== 'hardware'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Demo Sim
            </button>
            <button
              type="button"
              onClick={() => handleModeSwitch('hardware')}
              className={`px-2 py-1.5 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                status?.mode === 'hardware'
                  ? 'bg-emerald-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Live ESP32
            </button>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeNav === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveNav(item.id);
                  setSidebarOpen(false);
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors text-left cursor-pointer whitespace-nowrap ${
                  active
                    ? 'bg-blue-600/20 text-blue-300 border border-blue-500/40'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-[#111C30] border border-transparent'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="px-4 py-3 border-t border-[#1E2E4A] text-[11px] font-mono text-slate-500">
          3-Node ESP32 · AES-128-GCM · SQLite
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar */}
        <header className="sticky top-0 z-20 bg-[#0D1526]/95 backdrop-blur border-b border-[#1E2E4A] px-5 py-3.5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Open navigation menu"
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-1.5 text-slate-300 hover:text-white rounded-md border border-[#1E2E4A] cursor-pointer"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-slate-100 truncate">
                {currentNavObj.label}
              </h1>
              <div className="text-[11px] text-slate-400 truncate hidden sm:block">
                Intelligent Store-and-Forward Communication · Secure · Reliable · Fault-Tolerant
              </div>
            </div>
          </div>

          <div className="flex items-center gap-5 shrink-0">
            <div className="hidden md:flex items-center gap-3 text-xs font-mono tabular-nums">
              <span className={backendError ? 'text-rose-400' : 'text-emerald-400'}>
                {backendError ? '✖ Backend Offline' : '● API Connected'}
              </span>
              <span className="text-slate-600" aria-hidden="true">·</span>
              <span className={status?.is_demo_mode ? 'text-amber-400' : 'text-emerald-400'}>
                {status?.is_demo_mode ? 'DEMO MODE' : 'LIVE HARDWARE'}
              </span>
              <span className="text-slate-600" aria-hidden="true">·</span>
              <span className="text-slate-400">{clock}</span>
            </div>

            <button
              type="button"
              onClick={() => setAlertsOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#111C30] hover:bg-[#16243E] border border-[#1E2E4A] text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Bell className="w-3.5 h-3.5 text-sky-400" />
              <span>Alerts</span>
              {unreadCount > 0 && (
                <span className="font-mono text-rose-400 tabular-nums">({unreadCount})</span>
              )}
            </button>
          </div>
        </header>

        {/* Page Body */}
        <main className="flex-1 p-5 lg:p-6 max-w-[1440px] w-full mx-auto space-y-6">
          {/* Backend Connection Error Alert */}
          {backendError && (
            <div className="bg-rose-950/50 border border-rose-700/60 rounded-xl p-4 flex items-center justify-between gap-4 text-xs">
              <div className="flex items-center gap-2.5 text-rose-200">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>
                  Backend API unreachable ({backendError}). Displayed state cannot refresh until the server reconnects.
                </span>
              </div>
              <button
                type="button"
                onClick={fetchAll}
                className="px-3 py-1.5 rounded-md bg-rose-700 hover:bg-rose-600 text-white font-medium whitespace-nowrap cursor-pointer"
              >
                Retry Connection
              </button>
            </div>
          )}

          {/* Live Hardware Mode Clear Isolation Banner */}
          {status && status.mode === 'hardware' && (
            <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="text-slate-300">
                <span className="font-mono text-emerald-400 font-semibold">LIVE HARDWARE MODE</span>
                <span className="mx-2 text-slate-600">·</span>
                <span>
                  Displaying exclusively physical ESP32 records from SQLite. Unconnected nodes show <span className="font-mono text-rose-400">NOT_CONNECTED</span> with zero simulated data mixed in.
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleModeSwitch('simulation')}
                className="text-sky-400 hover:text-sky-300 font-medium whitespace-nowrap cursor-pointer"
              >
                Switch to Demo Simulation
              </button>
            </div>
          )}

          {/* Persistent Interactive Simulation Control Bar in Simulation Mode */}
          {status && status.mode === 'simulation' && activeNav !== 'testing' && activeNav !== 'settings' && (
            <SimulationToolbar simulation={status.simulation} onRefresh={fetchAll} />
          )}

          {/* Active Page View */}
          {!status ? (
            <div className="bg-[#111C30] border border-[#1E2E4A] rounded-xl p-12 text-center text-sm text-slate-400">
              Connecting to Resilient IoT backend and SQLite database...
            </div>
          ) : (
            <>
              {activeNav === 'overview' && <OverviewPage status={status} />}
              {activeNav === 'sensors' && (
                <LiveSensorsPage
                  mode={status.mode}
                  settings={status.settings}
                  refreshTick={refreshTick}
                  onSettingsUpdated={fetchAll}
                />
              )}
              {activeNav === 'nodes' && (
                <NodeArchitecturePage status={status} refreshTick={refreshTick} />
              )}
              {activeNav === 'communication' && (
                <CommunicationPage status={status} refreshTick={refreshTick} />
              )}
              {activeNav === 'packets' && (
                <PacketManagementPage mode={status.mode} refreshTick={refreshTick} />
              )}
              {activeNav === 'storage' && (
                <StorageManagementPage mode={status.mode} refreshTick={refreshTick} />
              )}
              {activeNav === 'security' && (
                <SecurityMonitoringPage
                  mode={status.mode}
                  refreshTick={refreshTick}
                  onRefresh={fetchAll}
                />
              )}
              {activeNav === 'ml' && (
                <MLAnalyticsPage
                  mode={status.mode}
                  refreshTick={refreshTick}
                  onRefresh={fetchAll}
                />
              )}
              {activeNav === 'history' && (
                <HistoricalDataPage mode={status.mode} refreshTick={refreshTick} />
              )}
              {activeNav === 'testing' && (
                <SystemTestingPage onRefreshGlobal={fetchAll} />
              )}
              {activeNav === 'hardware' && (
                <HardwareStatusPage status={status} refreshTick={refreshTick} />
              )}
              {activeNav === 'settings' && (
                <SettingsApiPage settings={status.settings} onSettingsUpdated={fetchAll} />
              )}
            </>
          )}
        </main>
      </div>

      {/* Alert Slide-Over Drawer */}
      <AlertDrawer
        open={alertsOpen}
        alerts={alerts}
        onClose={() => setAlertsOpen(false)}
        onMarkAllRead={handleMarkAlertsRead}
      />
    </div>
  );
}

export default App;
