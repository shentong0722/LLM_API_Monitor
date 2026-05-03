import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Gauge,
  RefreshCw,
  Server,
  ShieldCheck,
  Timer,
  Wifi,
  Zap,
} from 'lucide-react';
import './styles.css';

const POLL_INTERVAL_MS = 20_000;

function App() {
  const [summary, setSummary] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = React.useState(null);

  const loadSummary = React.useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setRefreshing(true);
    }

    try {
      const response = await fetch('/api/summary', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });

      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }

      const payload = await response.json();
      setSummary(payload);
      setError(null);
      setLastUpdatedAt(new Date());
    } catch (requestError) {
      if (import.meta.env.DEV) {
        setSummary(createMockSummary());
        setError('当前 Vite dev server 未加载 EdgeOne Functions，已展示本地演示数据。');
        setLastUpdatedAt(new Date());
      } else {
        setError(requestError.message || '无法加载监测数据');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    loadSummary();
    const timer = window.setInterval(() => loadSummary({ silent: true }), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadSummary]);

  const status = summary?.status || 'unknown';
  const latest = summary?.latest || null;
  const stats = summary?.summary || {};
  const history = summary?.history || [];
  const config = summary?.config || {};
  const statusMeta = getStatusMeta(status);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">
            <Activity size={22} aria-hidden="true" />
          </div>
          <div>
            <h1>LLM API Monitor</h1>
            <p>{config.model || 'OpenAI-compatible stream'}</p>
          </div>
        </div>

        <div className="topbar-actions">
          <StatusBadge status={status} label={statusMeta.label} />
          <button className="icon-button" onClick={() => loadSummary()} disabled={refreshing}>
            <RefreshCw size={18} className={refreshing ? 'spin' : ''} aria-hidden="true" />
            <span>刷新</span>
          </button>
        </div>
      </header>

      <main className="content">
        {error ? (
          <Notice tone="warn" icon={<AlertTriangle size={18} aria-hidden="true" />} text={error} />
        ) : null}

        {summary && !config.configured && !loading ? (
          <Notice
            tone="danger"
            icon={<AlertTriangle size={18} aria-hidden="true" />}
            text="上游 LLM API 环境变量尚未配置。"
          />
        ) : null}

        {status === 'stale' ? (
          <Notice
            tone="warn"
            icon={<Clock3 size={18} aria-hidden="true" />}
            text="最近一次采样已经过期，定时触发器可能未运行。"
          />
        ) : null}

        <section className="metric-grid" aria-label="核心指标">
          <MetricCard
            icon={<Wifi size={20} aria-hidden="true" />}
            label="实时状态"
            value={loading ? '加载中' : statusMeta.label}
            detail={latest ? `最近采样 ${relativeTime(latest.started_at)}` : '暂无采样'}
            tone={statusMeta.tone}
          />
          <MetricCard
            icon={<Timer size={20} aria-hidden="true" />}
            label="TTFT"
            value={formatMs(latest?.ttft_ms)}
            detail={`p95 ${formatMs(stats.ttft_p95_ms)} · p50 ${formatMs(stats.ttft_p50_ms)}`}
          />
          <MetricCard
            icon={<Gauge size={20} aria-hidden="true" />}
            label="TPS"
            value={formatTps(latest?.tps)}
            detail={`p50 ${formatTps(stats.tps_p50)} · token ${formatInteger(latest?.output_tokens)}`}
          />
          <MetricCard
            icon={<ShieldCheck size={20} aria-hidden="true" />}
            label="Uptime"
            value={formatPercent(stats.uptime_pct)}
            detail={`${stats.window_hours || 24}h · ${formatInteger(stats.total_samples)} samples`}
          />
        </section>

        <section className="dashboard-grid">
          <div className="panel wide-panel">
            <PanelHeader icon={<Zap size={18} aria-hidden="true" />} title="流式性能趋势" />
            <div className="chart-grid">
              <LineChart data={history} metric="ttft_ms" color="#2563eb" label="TTFT" unit="ms" />
              <LineChart data={history} metric="tps" color="#16a34a" label="TPS" unit="/s" />
            </div>
          </div>

          <div className="panel">
            <PanelHeader icon={<CheckCircle2 size={18} aria-hidden="true" />} title="可用性窗口" />
            <UptimeStrip data={history} />
            <dl className="compact-list">
              <div>
                <dt>成功样本</dt>
                <dd>{formatInteger(stats.ok_samples)}</dd>
              </div>
              <div>
                <dt>失败样本</dt>
                <dd>{formatInteger(stats.failed_samples)}</dd>
              </div>
              <div>
                <dt>最后更新</dt>
                <dd>{lastUpdatedAt ? lastUpdatedAt.toLocaleTimeString('zh-CN') : '-'}</dd>
              </div>
            </dl>
          </div>

          <div className="panel">
            <PanelHeader icon={<Server size={18} aria-hidden="true" />} title="上游配置" />
            <dl className="compact-list">
              <div>
                <dt>模型</dt>
                <dd>{config.model || '-'}</dd>
              </div>
              <div>
                <dt>API Host</dt>
                <dd>{config.base_host || '-'}</dd>
              </div>
              <div>
                <dt>采样间隔</dt>
                <dd>{formatDuration(config.interval_seconds)}</dd>
              </div>
              <div>
                <dt>历史存储</dt>
                <dd>{summary?.storage?.type || '-'}</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="panel">
          <PanelHeader icon={<Clock3 size={18} aria-hidden="true" />} title="最近采样" />
          <SampleTable rows={history.slice(-12).reverse()} />
        </section>
      </main>
    </div>
  );
}

function Notice({ tone, icon, text }) {
  return (
    <div className={`notice ${tone}`}>
      {icon}
      <span>{text}</span>
    </div>
  );
}

function StatusBadge({ status, label }) {
  return (
    <div className={`status-badge ${status}`}>
      <span className="status-dot" />
      <span>{label}</span>
    </div>
  );
}

function MetricCard({ icon, label, value, detail, tone = 'neutral' }) {
  return (
    <article className={`metric-card ${tone}`}>
      <div className="metric-icon">{icon}</div>
      <div>
        <p className="metric-label">{label}</p>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </article>
  );
}

function PanelHeader({ icon, title }) {
  return (
    <div className="panel-header">
      <div className="panel-title">
        {icon}
        <h2>{title}</h2>
      </div>
    </div>
  );
}

function LineChart({ data, metric, color, label, unit }) {
  const points = data
    .filter((item) => item?.ok && Number.isFinite(item?.[metric]))
    .slice(-96)
    .map((item) => ({ value: item[metric], started_at: item.started_at }));

  const width = 640;
  const height = 180;
  const padding = 22;
  const maxValue = Math.max(...points.map((point) => point.value), metric === 'tps' ? 10 : 1000);
  const minValue = metric === 'tps' ? 0 : Math.min(...points.map((point) => point.value), 0);
  const span = Math.max(maxValue - minValue, 1);

  const path = points
    .map((point, index) => {
      const x =
        points.length === 1
          ? width / 2
          : padding + (index / (points.length - 1)) * (width - padding * 2);
      const y = height - padding - ((point.value - minValue) / span) * (height - padding * 2);
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <div className="chart-card">
      <div className="chart-caption">
        <span>{label}</span>
        <strong>{points.length ? `${formatCompact(points.at(-1).value)}${unit}` : '-'}</strong>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label} trend`}>
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} />
        {path ? <path d={path} style={{ stroke: color }} /> : null}
        {points.map((point, index) => {
          const x =
            points.length === 1
              ? width / 2
              : padding + (index / (points.length - 1)) * (width - padding * 2);
          const y = height - padding - ((point.value - minValue) / span) * (height - padding * 2);
          return <circle key={`${point.started_at}-${index}`} cx={x} cy={y} r="3" style={{ fill: color }} />;
        })}
      </svg>
    </div>
  );
}

function UptimeStrip({ data }) {
  const rows = data.slice(-120);

  if (!rows.length) {
    return <div className="empty-state">暂无可用性样本</div>;
  }

  return (
    <div className="uptime-strip" aria-label="uptime samples">
      {rows.map((item, index) => (
        <span
          key={`${item.started_at}-${index}`}
          className={item.ok ? 'up' : 'down'}
          title={`${new Date(item.started_at).toLocaleString('zh-CN')} · ${item.ok ? 'up' : 'down'}`}
        />
      ))}
    </div>
  );
}

function SampleTable({ rows }) {
  if (!rows.length) {
    return <div className="empty-state">暂无采样记录</div>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>状态</th>
            <th>TTFT</th>
            <th>TPS</th>
            <th>Token</th>
            <th>耗时</th>
            <th>错误</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id || row.started_at}>
              <td>{new Date(row.started_at).toLocaleTimeString('zh-CN')}</td>
              <td>
                <span className={`table-status ${row.ok ? 'up' : 'down'}`}>{row.ok ? 'up' : 'down'}</span>
              </td>
              <td>{formatMs(row.ttft_ms)}</td>
              <td>{formatTps(row.tps)}</td>
              <td>{formatInteger(row.output_tokens)}</td>
              <td>{formatMs(row.total_duration_ms)}</td>
              <td className="error-cell">{row.error || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function getStatusMeta(status) {
  const map = {
    up: { label: '正常', tone: 'good' },
    degraded: { label: '降级', tone: 'warn' },
    down: { label: '故障', tone: 'danger' },
    stale: { label: '过期', tone: 'warn' },
    unknown: { label: '未知', tone: 'neutral' },
  };

  return map[status] || map.unknown;
}

function formatMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)} ms` : '-';
}

function formatTps(value) {
  return Number.isFinite(value) ? `${value.toFixed(value >= 10 ? 1 : 2)} /s` : '-';
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}%` : '-';
}

function formatInteger(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : '-';
}

function formatCompact(value) {
  return Number.isFinite(value) ? (value >= 100 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2)) : '-';
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '-';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

function relativeTime(value) {
  if (!value) return '-';
  const deltaSeconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s 前`;
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m 前`;
  return `${Math.round(minutes / 60)}h 前`;
}

function createMockSummary() {
  const now = Date.now();
  const history = Array.from({ length: 72 }, (_, index) => {
    const ok = index % 19 !== 0;
    const ttft = ok ? 650 + Math.sin(index / 4) * 160 + (index % 7) * 24 : null;
    const tps = ok ? 28 + Math.cos(index / 5) * 4 - (index % 6) * 0.35 : null;
    return {
      id: `mock-${index}`,
      ok,
      status: ok ? 'up' : 'down',
      started_at: new Date(now - (72 - index) * 60_000).toISOString(),
      ended_at: new Date(now - (72 - index) * 60_000 + 1800).toISOString(),
      ttft_ms: ttft,
      tps,
      output_tokens: ok ? 72 + (index % 11) : null,
      total_duration_ms: ok ? 2400 + (index % 9) * 110 : null,
      error: ok ? null : 'mock upstream timeout',
    };
  });

  const latest = history.at(-1);
  const okSamples = history.filter((sample) => sample.ok);

  return {
    generated_at: new Date().toISOString(),
    status: 'up',
    config: {
      configured: true,
      model: 'demo-model',
      base_host: 'api.example.com',
      interval_seconds: 60,
    },
    storage: { type: 'local-demo', available: true },
    latest,
    summary: {
      window_hours: 24,
      total_samples: history.length,
      ok_samples: okSamples.length,
      failed_samples: history.length - okSamples.length,
      uptime_pct: (okSamples.length / history.length) * 100,
      ttft_p50_ms: percentile(okSamples.map((sample) => sample.ttft_ms), 0.5),
      ttft_p95_ms: percentile(okSamples.map((sample) => sample.ttft_ms), 0.95),
      tps_p50: percentile(okSamples.map((sample) => sample.tps), 0.5),
    },
    history,
  };
}

function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

export default App;
