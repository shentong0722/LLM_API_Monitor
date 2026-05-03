const HISTORY_KEY = 'llm-monitor:history:v1';
const LATEST_KEY = 'llm-monitor:latest:v1';
const DEFAULT_PROMPT = 'Reply with one short sentence about API latency monitoring.';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 80;
const DEFAULT_HISTORY_LIMIT = 1440;
const DEFAULT_WINDOW_HOURS = 24;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Probe-Token',
};

export default async function onRequest(context) {
  const request = context.request;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const action = getApiAction(url.pathname);

  try {
    if (action === 'summary' || action === '') {
      return await handleSummary(context);
    }

    if (action === 'probe') {
      return await handleProbe(context);
    }

    if (action === 'health') {
      return json({ ok: true, generated_at: new Date().toISOString() });
    }

    return json({ error: 'Not found' }, 404);
  } catch (error) {
    return json({ error: sanitizeError(error) }, 500);
  }
}

async function handleSummary(context) {
  const config = readConfig(context.env || {});
  const store = getStore(context);
  const history = await readHistory(store);
  const latest = (await readLatest(store)) || history.at(-1) || null;
  const summary = summarizeHistory(history, config);

  return json({
    generated_at: new Date().toISOString(),
    status: computeOverallStatus(latest, config),
    config: publicConfig(config),
    storage: {
      available: store.available,
      type: store.type,
    },
    latest,
    summary,
    history,
  });
}

async function handleProbe(context) {
  const request = context.request;

  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const config = readConfig(context.env || {});
  const url = new URL(request.url);

  if (!isAuthorized(request, url, config)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const store = getStore(context);
  const force = url.searchParams.get('force') === '1';
  const latest = await readLatest(store);
  const minAgeMs = Math.max(0, config.intervalSeconds * 1000 * 0.8);

  if (!force && latest?.started_at && Date.now() - Date.parse(latest.started_at) < minAgeMs) {
    return json({
      skipped: true,
      reason: 'Probe interval has not elapsed',
      sample: latest,
      summary: summarizeHistory(await readHistory(store), config),
    });
  }

  const sample = await runProbe(config, context);
  const history = await appendSample(store, sample, config.historyLimit);

  return json({
    skipped: false,
    sample,
    summary: summarizeHistory(history, config),
  });
}

async function runProbe(config, context) {
  const id = createId();
  const startedAt = new Date().toISOString();
  const startedMs = nowMs();
  const endpoint = buildEndpoint(config.baseUrl, config.apiPath);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort('timeout'), config.timeoutMs);

  let httpStatus = null;
  let firstTokenMs = null;
  let lastTokenMs = null;
  let responseHeaderMs = null;
  let outputText = '';
  let chunkCount = 0;
  let usageCompletionTokens = null;

  try {
    if (!config.apiKey) {
      throw new Error('LLM_API_KEY or OPENAI_API_KEY is not configured');
    }

    const body = {
      model: config.model,
      messages: [{ role: 'user', content: config.prompt }],
      temperature: 0,
      stream: true,
      max_tokens: config.maxTokens,
    };

    if (config.includeStreamUsage) {
      body.stream_options = { include_usage: true };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    httpStatus = response.status;
    responseHeaderMs = nowMs() - startedMs;

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upstream HTTP ${response.status}: ${truncate(errorText, 500)}`);
    }

    if (!response.body?.getReader) {
      throw new Error('Upstream response body is not readable');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        const event = parseSseLine(line);

        if (!event || event === '[DONE]') {
          continue;
        }

        const parsed = safeJsonParse(event);
        const completionTokens = parsed?.usage?.completion_tokens;

        if (Number.isFinite(completionTokens)) {
          usageCompletionTokens = completionTokens;
        }

        const deltaText = extractDeltaText(parsed);

        if (deltaText) {
          const tokenTimeMs = nowMs();
          firstTokenMs = firstTokenMs ?? tokenTimeMs;
          lastTokenMs = tokenTimeMs;
          outputText += deltaText;
          chunkCount += 1;
        }
      }
    }

    if (buffer.trim()) {
      const event = parseSseLine(buffer.trim());
      const parsed = safeJsonParse(event);
      const completionTokens = parsed?.usage?.completion_tokens;

      if (Number.isFinite(completionTokens)) {
        usageCompletionTokens = completionTokens;
      }
    }

    if (!firstTokenMs) {
      throw new Error('No streamed content token was received');
    }

    const endedMs = nowMs();
    const endedAt = new Date().toISOString();
    const outputTokens = Number.isFinite(usageCompletionTokens)
      ? usageCompletionTokens
      : estimateTokenCount(outputText, chunkCount);
    const generationSeconds = Math.max((endedMs - firstTokenMs) / 1000, 0.001);
    const tps = outputTokens / generationSeconds;

    return sanitizeSample({
      id,
      ok: true,
      status: 'up',
      started_at: startedAt,
      ended_at: endedAt,
      model: config.model,
      base_host: safeHostname(config.baseUrl),
      region: context.server?.region || context.geo?.country || null,
      http_status: httpStatus,
      response_header_ms: round(responseHeaderMs, 2),
      ttft_ms: round(firstTokenMs - startedMs, 2),
      tps: round(tps, 3),
      output_tokens: outputTokens,
      token_count_source: Number.isFinite(usageCompletionTokens) ? 'usage' : 'estimate',
      stream_chunks: chunkCount,
      total_duration_ms: round(endedMs - startedMs, 2),
      error: null,
    });
  } catch (error) {
    const endedMs = nowMs();
    return sanitizeSample({
      id,
      ok: false,
      status: 'down',
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      model: config.model,
      base_host: safeHostname(config.baseUrl),
      region: context.server?.region || context.geo?.country || null,
      http_status: httpStatus,
      response_header_ms: Number.isFinite(responseHeaderMs) ? round(responseHeaderMs, 2) : null,
      ttft_ms: firstTokenMs ? round(firstTokenMs - startedMs, 2) : null,
      tps: null,
      output_tokens: null,
      token_count_source: null,
      stream_chunks: chunkCount,
      total_duration_ms: round(endedMs - startedMs, 2),
      error: sanitizeError(error),
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function readConfig(env) {
  return {
    apiKey: env.LLM_API_KEY || env.OPENAI_API_KEY || '',
    baseUrl: normalizeBaseUrl(env.LLM_API_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL),
    apiPath: env.LLM_API_PATH || '/chat/completions',
    model: env.LLM_MODEL || env.OPENAI_MODEL || DEFAULT_MODEL,
    prompt: env.LLM_PROMPT || DEFAULT_PROMPT,
    maxTokens: toInteger(env.LLM_MAX_TOKENS, DEFAULT_MAX_TOKENS, 1, 4096),
    intervalSeconds: toInteger(env.LLM_PROBE_INTERVAL_SECONDS, DEFAULT_INTERVAL_SECONDS, 10, 3600),
    timeoutMs: toInteger(env.LLM_PROBE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 120000),
    historyLimit: toInteger(env.LLM_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT, 10, 5000),
    windowHours: toInteger(env.LLM_UPTIME_WINDOW_HOURS, DEFAULT_WINDOW_HOURS, 1, 168),
    cronSecret: env.PROBE_CRON_SECRET || '',
    includeStreamUsage: env.LLM_STREAM_OPTIONS_INCLUDE_USAGE !== 'false',
    ttftDegradedMs: toInteger(env.LLM_TTFT_DEGRADED_MS, 3000, 100, 600000),
    tpsDegradedBelow: toNumber(env.LLM_TPS_DEGRADED_BELOW, 5, 0, 1000),
  };
}

function publicConfig(config) {
  return {
    configured: Boolean(config.apiKey && config.model && config.baseUrl),
    model: config.model,
    base_host: safeHostname(config.baseUrl),
    api_path: config.apiPath,
    interval_seconds: config.intervalSeconds,
    timeout_ms: config.timeoutMs,
    max_tokens: config.maxTokens,
    window_hours: config.windowHours,
    prompt_preview: truncate(config.prompt, 120),
  };
}

function getStore(context) {
  const env = context.env || {};
  const kv = [env.LLM_MONITOR_KV, env.MONITOR_KV, env.KV].find(
    (candidate) => candidate && typeof candidate.get === 'function' && typeof candidate.put === 'function',
  );

  if (kv) {
    return {
      available: true,
      type: 'edgeone-kv',
      get: (key) => kv.get(key),
      put: (key, value) => kv.put(key, value),
    };
  }

  globalThis.__LLM_MONITOR_MEMORY_STORE ||= new Map();

  return {
    available: false,
    type: 'memory-fallback',
    get: async (key) => globalThis.__LLM_MONITOR_MEMORY_STORE.get(key) || null,
    put: async (key, value) => {
      globalThis.__LLM_MONITOR_MEMORY_STORE.set(key, value);
    },
  };
}

async function readLatest(store) {
  const raw = await store.get(LATEST_KEY);
  const parsed = safeJsonParse(raw);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

async function readHistory(store) {
  const raw = await store.get(HISTORY_KEY);
  const parsed = safeJsonParse(raw);
  return Array.isArray(parsed) ? parsed.map(sanitizeSample).filter(Boolean) : [];
}

async function appendSample(store, sample, historyLimit) {
  const history = await readHistory(store);
  const nextHistory = [...history, sample].slice(-historyLimit);

  await store.put(HISTORY_KEY, JSON.stringify(nextHistory));
  await store.put(LATEST_KEY, JSON.stringify(sample));

  return nextHistory;
}

function summarizeHistory(history, config) {
  const cutoff = Date.now() - config.windowHours * 60 * 60 * 1000;
  const windowed = history.filter((sample) => Date.parse(sample.started_at) >= cutoff);
  const okSamples = windowed.filter((sample) => sample.ok);
  const failedSamples = windowed.length - okSamples.length;
  const ttftValues = okSamples.map((sample) => sample.ttft_ms).filter(Number.isFinite);
  const tpsValues = okSamples.map((sample) => sample.tps).filter(Number.isFinite);

  return {
    window_hours: config.windowHours,
    total_samples: windowed.length,
    ok_samples: okSamples.length,
    failed_samples: failedSamples,
    uptime_pct: windowed.length ? round((okSamples.length / windowed.length) * 100, 4) : null,
    ttft_avg_ms: average(ttftValues),
    ttft_p50_ms: percentile(ttftValues, 0.5),
    ttft_p95_ms: percentile(ttftValues, 0.95),
    tps_avg: average(tpsValues),
    tps_p50: percentile(tpsValues, 0.5),
    tps_p05: percentile(tpsValues, 0.05),
  };
}

function computeOverallStatus(latest, config) {
  if (!latest) {
    return 'unknown';
  }

  const sampleAgeMs = Date.now() - Date.parse(latest.started_at);
  const staleAfterMs = Math.max(config.intervalSeconds * 3000, 180000);

  if (sampleAgeMs > staleAfterMs) {
    return 'stale';
  }

  if (!latest.ok) {
    return 'down';
  }

  if (
    Number.isFinite(latest.ttft_ms) &&
    Number.isFinite(latest.tps) &&
    (latest.ttft_ms > config.ttftDegradedMs || latest.tps < config.tpsDegradedBelow)
  ) {
    return 'degraded';
  }

  return 'up';
}

function isAuthorized(request, url, config) {
  if (!config.cronSecret) {
    return true;
  }

  const queryToken = url.searchParams.get('token');
  const headerToken = request.headers.get('x-probe-token');
  const authorization = request.headers.get('authorization') || '';
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;

  return [queryToken, headerToken, bearerToken].includes(config.cronSecret);
}

function extractDeltaText(parsed) {
  const choice = parsed?.choices?.[0];
  const delta = choice?.delta || {};

  return (
    delta.content ||
    delta.reasoning_content ||
    choice?.text ||
    parsed?.output_text ||
    ''
  );
}

function parseSseLine(line) {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith(':')) {
    return null;
  }

  if (!trimmed.startsWith('data:')) {
    return null;
  }

  return trimmed.slice(5).trim();
}

function estimateTokenCount(text, chunkCount) {
  const cjkChars = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const nonCjk = text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, '');
  const latinEstimate = Math.ceil(nonCjk.replace(/\s+/g, ' ').trim().length / 4);

  return Math.max(chunkCount, cjkChars + latinEstimate, 1);
}

function sanitizeSample(sample) {
  if (!sample || typeof sample !== 'object') {
    return null;
  }

  return {
    id: sample.id || createId(),
    ok: Boolean(sample.ok),
    status: sample.ok ? 'up' : 'down',
    started_at: sample.started_at,
    ended_at: sample.ended_at,
    model: sample.model || null,
    base_host: sample.base_host || null,
    region: sample.region || null,
    http_status: numberOrNull(sample.http_status),
    response_header_ms: numberOrNull(sample.response_header_ms),
    ttft_ms: numberOrNull(sample.ttft_ms),
    tps: numberOrNull(sample.tps),
    output_tokens: numberOrNull(sample.output_tokens),
    token_count_source: sample.token_count_source || null,
    stream_chunks: numberOrNull(sample.stream_chunks),
    total_duration_ms: numberOrNull(sample.total_duration_ms),
    error: sample.error ? truncate(String(sample.error), 500) : null,
  };
}

function getApiAction(pathname) {
  return pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean)[0] || 'summary';
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function buildEndpoint(baseUrl, apiPath) {
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  return `${normalizeBaseUrl(baseUrl)}${normalizedPath}`;
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function safeHostname(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return 'invalid-url';
  }
}

function safeJsonParse(value) {
  if (!value) {
    return null;
  }

  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

function sanitizeError(error) {
  if (error?.name === 'AbortError' || error === 'timeout') {
    return 'Probe timed out';
  }

  return truncate(error?.message || String(error), 500);
}

function truncate(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function toInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function toNumber(value, fallback, min, max) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values) {
  const usable = values.filter(Number.isFinite);

  if (!usable.length) {
    return null;
  }

  return round(usable.reduce((sum, value) => sum + value, 0) / usable.length, 4);
}

function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);

  if (!sorted.length) {
    return null;
  }

  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return round(sorted[index], 4);
}

function round(value, precision = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function createId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
