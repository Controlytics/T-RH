import useSWR from 'swr';
import { useEffect, useState } from 'react';
import { useDatetimeFormat } from '../../hooks/use-datetime-format';

interface SystemHealthData {
  os: {
    hostname: string;
    platform: string;
    arch: string;
    release: string;
    uptimeSeconds: number;
    loadAvg: { '1m': number; '5m': number; '15m': number };
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usagePercent: number;
  };
  cpu: {
    cores: number;
    model: string;
    usagePercent: number;
  };
  disk: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usagePercent: number;
  };
  process: {
    nodeVersion: string;
    pid: number;
    uptimeSeconds: number;
    memoryUsage: {
      rss: number;
      heapTotal: number;
      heapUsed: number;
      external: number;
    };
  };
  api: {
    totalRequests: number;
    requestsPerMinute: number;
  };
  database: {
    connected: boolean;
    databaseSize: string;
    activeConnections: number;
    totalTables: number;
  };
  timestamp: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

function ProgressBar({ percent, color }: { percent: number; color: string }) {
  const clampedPercent = Math.min(100, Math.max(0, percent));
  const barColor =
    clampedPercent > 90 ? 'bg-red-500' : clampedPercent > 70 ? 'bg-amber-500' : color;
  return (
    <div className="w-full bg-slate-200 rounded-full h-3 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-700 ${barColor}`}
        style={{ width: `${clampedPercent}%` }}
      />
    </div>
  );
}

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`}
    />
  );
}

function MetricCard({
  title,
  icon,
  gradient,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  gradient: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-[var(--radius-card)] bg-white border border-slate-200/60 shadow-soft">
      <div className={`absolute top-0 left-0 right-0 h-1 ${gradient}`} />
      <div className="p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className={`p-2.5 rounded-xl ${gradient} text-white shadow-lg`}>{icon}</div>
          <h3 className="text-sm font-semibold text-slate-800 uppercase tracking-wider">{title}</h3>
        </div>
        {children}
      </div>
    </div>
  );
}

export function SystemHealthPage() {
  const { formatTime } = useDatetimeFormat();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const { data, isLoading, mutate } = useSWR<SystemHealthData>('/api/system-health', {
    refreshInterval: autoRefresh ? 10000 : 0,
    revalidateOnFocus: true,
  });

  // Countdown for next refresh
  const [countdown, setCountdown] = useState(10);
  useEffect(() => {
    if (!autoRefresh) return;
    setCountdown(10);
    const timer = setInterval(() => {
      setCountdown((prev) => (prev <= 1 ? 10 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, data]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-300 border-t-blue-600" />
          <p className="text-sm text-slate-500">Loading system metrics...</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-12">
        <p className="text-slate-500">Failed to load system health data.</p>
        <button
          onClick={() => mutate()}
          className="mt-3 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] text-slate-900">System Health</h1>
          <p className="text-sm text-slate-500 mt-1">
            Server: {data.os.hostname} &middot; Last updated:{' '}
            {formatTime(data.timestamp)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => mutate()}
            className="px-4 py-2 text-sm bg-white border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-700 transition-colors"
          >
            <svg className="w-4 h-4 inline mr-1.5 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`px-4 py-2 text-sm rounded-lg transition-colors ${
              autoRefresh
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : 'bg-slate-50 text-slate-500 border border-slate-200'
            }`}
          >
            {autoRefresh ? `Auto-refresh (${countdown}s)` : 'Auto-refresh off'}
          </button>
        </div>
      </div>

      {/* Top-level summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl bg-gradient-to-r from-blue-500 to-indigo-600 p-5 text-white shadow-lg">
          <p className="text-blue-100 text-xs uppercase tracking-wider">OS Uptime</p>
          <p className="text-2xl font-bold mt-1">{formatUptime(data.os.uptimeSeconds)}</p>
          <p className="text-blue-200 text-xs mt-1">{data.os.platform} {data.os.arch}</p>
        </div>
        <div className="rounded-xl bg-gradient-to-r from-purple-500 to-pink-600 p-5 text-white shadow-lg">
          <p className="text-purple-100 text-xs uppercase tracking-wider">API Requests</p>
          <p className="text-2xl font-bold mt-1">{data.api.totalRequests.toLocaleString()}</p>
          <p className="text-purple-200 text-xs mt-1">{data.api.requestsPerMinute} req/min</p>
        </div>
        <div className="rounded-xl bg-gradient-to-r from-amber-500 to-orange-600 p-5 text-white shadow-lg">
          <p className="text-amber-100 text-xs uppercase tracking-wider">RAM Usage</p>
          <p className="text-2xl font-bold mt-1">{data.memory.usagePercent}%</p>
          <p className="text-amber-200 text-xs mt-1">
            {formatBytes(data.memory.usedBytes)} / {formatBytes(data.memory.totalBytes)}
          </p>
        </div>
        <div className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 p-5 text-white shadow-lg">
          <p className="text-emerald-100 text-xs uppercase tracking-wider">CPU Usage</p>
          <p className="text-2xl font-bold mt-1">{data.cpu.usagePercent}%</p>
          <p className="text-emerald-200 text-xs mt-1">{data.cpu.cores} cores</p>
        </div>
      </div>

      {/* Detailed metrics grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Memory */}
        <MetricCard
          title="Memory (RAM)"
          gradient="bg-gradient-to-r from-amber-500 to-orange-600"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          }
        >
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Used</span>
              <span className="font-medium text-slate-800">
                {formatBytes(data.memory.usedBytes)} / {formatBytes(data.memory.totalBytes)}
              </span>
            </div>
            <ProgressBar percent={data.memory.usagePercent} color="bg-amber-500" />
            <div className="grid grid-cols-2 gap-4 pt-2">
              <div>
                <p className="text-xs text-slate-400">Free</p>
                <p className="text-sm font-semibold text-slate-700">{formatBytes(data.memory.freeBytes)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Usage</p>
                <p className="text-sm font-semibold text-slate-700">{data.memory.usagePercent}%</p>
              </div>
            </div>
          </div>
        </MetricCard>

        {/* CPU */}
        <MetricCard
          title="CPU"
          gradient="bg-gradient-to-r from-emerald-500 to-teal-600"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
          }
        >
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Usage</span>
              <span className="font-medium text-slate-800">{data.cpu.usagePercent}%</span>
            </div>
            <ProgressBar percent={data.cpu.usagePercent} color="bg-emerald-500" />
            <div className="grid grid-cols-2 gap-4 pt-2">
              <div>
                <p className="text-xs text-slate-400">Cores</p>
                <p className="text-sm font-semibold text-slate-700">{data.cpu.cores}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Model</p>
                <p className="text-sm font-semibold text-slate-700 truncate" title={data.cpu.model}>
                  {data.cpu.model}
                </p>
              </div>
            </div>
            <div className="pt-2">
              <p className="text-xs text-slate-400 mb-1">Load Average</p>
              <div className="flex gap-4 text-sm">
                <span className="text-slate-700">
                  <span className="text-slate-400">1m:</span> {data.os.loadAvg['1m']}
                </span>
                <span className="text-slate-700">
                  <span className="text-slate-400">5m:</span> {data.os.loadAvg['5m']}
                </span>
                <span className="text-slate-700">
                  <span className="text-slate-400">15m:</span> {data.os.loadAvg['15m']}
                </span>
              </div>
            </div>
          </div>
        </MetricCard>

        {/* Disk */}
        <MetricCard
          title="Disk"
          gradient="bg-gradient-to-r from-blue-500 to-indigo-600"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
            </svg>
          }
        >
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Used</span>
              <span className="font-medium text-slate-800">
                {formatBytes(data.disk.usedBytes)} / {formatBytes(data.disk.totalBytes)}
              </span>
            </div>
            <ProgressBar percent={data.disk.usagePercent} color="bg-blue-500" />
            <div className="grid grid-cols-2 gap-4 pt-2">
              <div>
                <p className="text-xs text-slate-400">Free</p>
                <p className="text-sm font-semibold text-slate-700">{formatBytes(data.disk.freeBytes)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Usage</p>
                <p className="text-sm font-semibold text-slate-700">{data.disk.usagePercent}%</p>
              </div>
            </div>
          </div>
        </MetricCard>

        {/* Database */}
        <MetricCard
          title="Database (PostgreSQL)"
          gradient="bg-gradient-to-r from-violet-500 to-purple-600"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
            </svg>
          }
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <StatusDot connected={data.database.connected} />
              <span className="text-sm font-medium text-slate-700">
                {data.database.connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-4 pt-1">
              <div>
                <p className="text-xs text-slate-400">Size</p>
                <p className="text-sm font-semibold text-slate-700">{data.database.databaseSize}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Connections</p>
                <p className="text-sm font-semibold text-slate-700">{data.database.activeConnections}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Tables</p>
                <p className="text-sm font-semibold text-slate-700">{data.database.totalTables}</p>
              </div>
            </div>
          </div>
        </MetricCard>

        {/* Node.js Process */}
        <MetricCard
          title="Node.js Process"
          gradient="bg-gradient-to-r from-lime-500 to-green-600"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          }
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-slate-400">Node Version</p>
                <p className="text-sm font-semibold text-slate-700">{data.process.nodeVersion}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">PID</p>
                <p className="text-sm font-semibold text-slate-700">{data.process.pid}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Uptime</p>
                <p className="text-sm font-semibold text-slate-700">{formatUptime(data.process.uptimeSeconds)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">RSS</p>
                <p className="text-sm font-semibold text-slate-700">{formatBytes(data.process.memoryUsage.rss)}</p>
              </div>
            </div>
            <div className="pt-2">
              <p className="text-xs text-slate-400 mb-2">Heap Memory</p>
              <div className="flex justify-between text-sm mb-1">
                <span className="text-slate-500">Used</span>
                <span className="font-medium text-slate-800">
                  {formatBytes(data.process.memoryUsage.heapUsed)} / {formatBytes(data.process.memoryUsage.heapTotal)}
                </span>
              </div>
              <ProgressBar
                percent={
                  data.process.memoryUsage.heapTotal > 0
                    ? Math.round((data.process.memoryUsage.heapUsed / data.process.memoryUsage.heapTotal) * 100)
                    : 0
                }
                color="bg-lime-500"
              />
            </div>
          </div>
        </MetricCard>

        {/* API Requests */}
        <MetricCard
          title="API Requests"
          gradient="bg-gradient-to-r from-purple-500 to-pink-600"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          }
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-slate-400">Total Requests</p>
                <p className="text-2xl font-bold text-slate-800">{data.api.totalRequests.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Requests / Min</p>
                <p className="text-2xl font-bold text-slate-800">{data.api.requestsPerMinute}</p>
              </div>
            </div>
          </div>
        </MetricCard>
      </div>

      {/* OS Info footer */}
      <div className="rounded-xl bg-slate-50 border border-slate-200 p-4">
        <p className="text-xs text-slate-400 uppercase tracking-wider mb-2">System Information</p>
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm text-slate-600">
          <span><span className="text-slate-400">Hostname:</span> {data.os.hostname}</span>
          <span><span className="text-slate-400">Platform:</span> {data.os.platform}</span>
          <span><span className="text-slate-400">Architecture:</span> {data.os.arch}</span>
          <span><span className="text-slate-400">Kernel:</span> {data.os.release}</span>
        </div>
      </div>
    </div>
  );
}
