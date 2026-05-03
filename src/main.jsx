import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Gauge,
  ListChecks,
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
  const [selectedTargetId, setSelectedTargetId] = React.useState(null);
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

  const targets = React.useMemo(() => normalizeTargets(summary), [summary]);

  React.useEffect(() => {
    if (!targets.length) {
      return;
    }

    if (!selectedTargetId || !targets.some((target) => target.id === selectedTargetId)) {
      setSelectedTargetId(targets[0].id);
    }
  }, [selectedTargetId, targets]);

  const selectedTarget = targets.find((target) => target.id === selectedTargetId) || targets[0] || null;
  const status = summary?.status || 'unknown';
  const statusMeta = getStatusMeta(status);
  const selectedStatusMeta = getStatusMeta(selectedTarget?.status || 'unknown');
  const selectedLatest = selectedTarget?.latest || null;
  const selectedStats = selectedTarget?.summary || {};
  const selectedHistory = selectedTarget?.history || [];
  const config = summary?.config || {};
  const availableTargets = targets.filter((target) => target.latest?.ok && target.status !== 'stale').length;
  const failedTargets = targets.filter((target) => target.status === 'down').length;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">
            <Activity size={22} aria-hidden="true" />
          </div>
          <div>
            <h1>LLM API Monitor</h1>
            <p>{targets.length ? `${targets.length} models · OpenAI-compatible stream` : 'OpenAI-compatible stream'}</p>
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
        {error ? <Notice tone="warn" icon={<AlertTriangle size={18} aria-hidden="true" />} text={error} /> : null}

        {summary && !config.configured && !loading ? (
          <Notice
            tone="danger"
            icon={<AlertTriangle size={18} aria-hidden="true" />}
            text="上游 LLM API 环境变量尚未配置完整。"
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
            label="全局状态"
            value={loading ? '加载中' : statusMeta.label}
            detail={`${availableTargets}/${targets.length || 0} models available · ${failedTargets} failed`}
            tone={statusMeta.tone}
          />
          <MetricCard
            icon={<ShieldCheck size={20} aria-hidden="true" />}
            label="当前模型"
            value={selectedTarget?.label || '-'}
            detail={selectedLatest ? `最近采样 ${relativeTime(selectedLatest.started_at)}` : '暂无采样'}
            tone={selectedStatusMeta.tone}
          />
          <MetricCard
            icon={<Timer size={20} aria-hidden="true" />}
            label="TTFT"
            value={formatMs(selectedLatest?.ttft_ms)}
            detail={`p95 ${formatMs(selectedStats.ttft_p95_ms)} · p50 ${formatMs(selectedStats.ttft_p50_ms)}`}
          />
          <MetricCard
            icon={<Gauge size={20} aria-hidden="true" />}
            label="TPS"
            value={formatTps(selectedLatest?.tps)}
            detail={`uptime ${formatPercent(selectedStats.uptime_pct)} · token ${formatInteger(selectedLatest?.output_tokens)}`}
          />
        </section>

        <section className="panel">
          <PanelHeader icon={<ListChecks size={18} aria-hidden="true" />} title="模型概览" />
          <ModelOverview rows={targets} selectedId={selectedTarget?.id} onSelect={setSelectedTargetId} />
        </section>

        <section className="dashboard-grid">
          <div className="panel wide-panel">
            <PanelHeader icon={<Zap size={18} aria-hidden="true" />} title="流式性能趋势" />
            <div className="target-tabs" aria-label="模型切换">
              {targets.map((target) => (
                <button
                  key={target.id}
                  className={`target-tab ${target.id === selectedTarget?.id ? 'active' : ''}`}
                  onClick={() => setSelectedTargetId(target.id)}
                >
                  <span className={`mini-dot ${target.status}`} />
                  <span>{target.label}</span>
                </button>
              ))}
            </div>
            <div className="chart-grid">
              <LineChart data={selectedHistory} metric="ttft_ms" color="#2563eb" label="TTFT" unit="ms" />
              <LineChart data={selectedHistory} metric="tps" color="#16a34a" label="TPS" unit="/s" />
            </div>
          </div>

          <div className="panel">
            <PanelHeader icon={<CheckCircle2 size={18} aria-hidden="true" />} title="可用性窗口" />
            <UptimeStrip data={selectedHistory} />
            <dl className="compact-list">
              <div>
                <dt>成功样本</dt>
                <dd>{formatInteger(selectedStats.ok_samples)}</dd>
              </div>
              <div>
                <dt>失败样本</dt>
                <dd>{formatInteger(selectedStats.failed_samples)}</dd>
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
                <dd>{selectedTarget?.config?.model || '-'}</dd>
              </div>
              <div>
                <dt>API Host</dt>
                <dd>{selectedTarget?.config?.base_host || '-'}</dd>
              </div>
              <div>
                <dt>采样间隔</dt>
                <dd>{formatDuration(config.interval_seconds)}</dd>
              </div>
              <div>
                <dt>探测模式</dt>
                <dd>{config.probe_mode || '-'}</dd>
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
          <SampleTable rows={selectedHistory.slice(-12).reverse()} />
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

function StatusBadge({ status, label, compact = false }) {
  return (
    <div className={`status-badge ${status} ${compact ? 'compact' : ''}`}>
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

function ModelOverview({ rows, selectedId, onSelect }) {
  if (!rows.length) {
    return <div className="empty-state">暂无模型配置</div>;
  }

  return (
    <div className="table-wrap">
      <table className="overview-table">
        <thead>
          <tr>
            <th>模型</th>
            <th>状态</th>
            <th>1h TTFT</th>
            <th>1h TPS</th>
            <th>Uptime</th>
            <th>最近采样</th>
            <th>错误</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const meta = getStatusMeta(row.status);
            return (
              <tr key={row.id} className={row.id === selectedId ? 'selected' : ''}>
                <td>
                  <button className="model-link" onClick={() => onSelect(row.id)}>
                    {row.label}
                  </button>
                </td>
                <td>
                  <StatusBadge status={row.status} label={meta.label} compact />
                </td>
                <td>{formatMs(row.one_hour_summary?.ttft_avg_ms)}</td>
                <td>{formatTps(row.one_hour_summary?.tps_avg)}</td>
                <td>{formatPercent(row.one_hour_summary?.uptime_pct)}</td>
                <td>{row.latest?.started_at ? relativeTime(row.latest.started_at) : '-'}</td>
                <td className="error-cell">{row.latest?.error || '-'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
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

function normalizeTargets(summary) {
  if (!summary) {
    return [];
  }

  if (Array.isArray(summary.targets)) {
    return summary.targets;
  }

  return [
    {
      id: 'default',
      label: summary.config?.model || 'default',
      status: summary.status || 'unknown',
      config: summary.config || {},
      latest: summary.latest || null,
      summary: summary.summary || {},
      history: summary.history || [],
    },
  ];
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
  const modelNames = ['deepseek-v4-pro', 'gpt-4o-mini', 'qwen-plus'];
  const targets = modelNames.map((model, modelIndex) => {
    const history = Array.from({ length: 72 }, (_, index) => {
      const ok = (index + modelIndex) % 19 !== 0;
      const ttft = ok ? 620 + modelIndex * 210 + Math.sin(index / 4) * 160 + (index % 7) * 24 : null;
      const tps = ok ? 30 - modelIndex * 4 + Math.cos(index / 5) * 4 - (index % 6) * 0.35 : null;
      return {
        id: `mock-${modelIndex}-${index}`,
        target_id: model,
        target_label: model,
        ok,
        status: ok ? 'up' : 'down',
        started_at: new Date(now - (72 - index) * 60_000).toISOString(),
        ended_at: new Date(now - (72 - index) * 60_000 + 1800).toISOString(),
        model,
        base_host: 'api.example.com',
        ttft_ms: ttft,
        tps,
        output_tokens: ok ? 72 + (index % 11) : null,
        total_duration_ms: ok ? 2400 + (index % 9) * 110 : null,
        error: ok ? null : 'mock upstream timeout',
      };
    });
    const latest = history.at(-1);
    const stats = summarizeMock(history);

    return {
      id: model,
      label: model,
      status: latest.ok ? 'up' : 'down',
      config: {
        id: model,
        label: model,
        configured: true,
        model,
        base_host: 'api.example.com',
        api_path: '/chat/completions',
        timeout_ms: 30000,
        max_tokens: 80,
      },
      latest,
      summary: stats,
      one_hour_summary: stats,
      history,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    status: 'degraded',
    config: {
      configured: true,
      target_count: targets.length,
      models: modelNames,
      interval_seconds: 60,
      probe_mode: 'parallel',
    },
    storage: { type: 'local-demo', available: true },
    targets,
    latest: targets[0].latest,
    summary: targets[0].summary,
    history: targets[0].history,
  };
}

function summarizeMock(history) {
  const okSamples = history.filter((sample) => sample.ok);
  return {
    window_hours: 24,
    total_samples: history.length,
    ok_samples: okSamples.length,
    failed_samples: history.length - okSamples.length,
    uptime_pct: (okSamples.length / history.length) * 100,
    ttft_p50_ms: percentile(okSamples.map((sample) => sample.ttft_ms), 0.5),
    ttft_p95_ms: percentile(okSamples.map((sample) => sample.ttft_ms), 0.95),
    tps_p50: percentile(okSamples.map((sample) => sample.tps), 0.5),
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
