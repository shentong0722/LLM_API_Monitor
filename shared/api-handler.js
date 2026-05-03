const HISTORY_KEY = 'llm_monitor_history_v2';
const LATEST_KEY = 'llm_monitor_latest_v2';
const LEGACY_HISTORY_KEY = 'llm_monitor_history_v1';
const LEGACY_LATEST_KEY = 'llm_monitor_latest_v1';
const DEFAULT_PROMPT = 'Reply with one short sentence about API latency monitoring.';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 80;
const DEFAULT_HISTORY_LIMIT = 1440;
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_SITE_TITLE = 'LLM API Monitor';
const DEFAULT_SITE_SUBTITLE = 'OpenAI-compatible stream';
const DEFAULT_PROJECT_REPO_URL = 'https://github.com/shentong0722/LLM_API_Monitor';

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
  const history = await readHistory(store, config);
  const latestMap = await readLatestMap(store, config);
  const targets = buildTargetSummaries(config, history, latestMap);
  const firstTarget = targets[0] || null;

  return json({
    generated_at: new Date().toISOString(),
    status: computeFleetStatus(targets),
    config: publicConfig(config),
    storage: {
      available: store.available,
      type: store.type,
    },
    targets,
    fleet_summary: summarizeHistory(history, config),
    fleet_one_hour_summary: summarizeHistory(history, config, 1),
    latest: firstTarget?.latest || null,
    summary: firstTarget?.summary || summarizeHistory([], config),
    history: firstTarget?.history || [],
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
  const requestedTarget = url.searchParams.get('target');
  const selectedTargets = filterTargets(config.targets, requestedTarget);

  if (!selectedTargets.length) {
    return json({ error: 'No matching probe target' }, 404);
  }

  const latestMap = await readLatestMap(store, config);
  const minAgeMs = Math.max(0, config.intervalSeconds * 1000 * 0.8);
  const dueTargets = force
    ? selectedTargets
    : selectedTargets.filter((target) => {
        const latest = latestMap[target.id];
        return !latest?.started_at || Date.now() - Date.parse(latest.started_at) >= minAgeMs;
      });

  if (!dueTargets.length) {
    const history = await readHistory(store, config);
    const targets = buildTargetSummaries(config, history, latestMap);

    return json({
      skipped: true,
      reason: 'Probe interval has not elapsed',
      samples: selectedTargets.map((target) => latestMap[target.id]).filter(Boolean),
      sample: latestMap[selectedTargets[0].id] || null,
      targets,
      summary: summarizeHistory(history, config),
    });
  }

  const samples = await runProbeBatch(dueTargets, config, context);
  const history = await appendSamples(store, samples, config);
  const nextLatestMap = await readLatestMap(store, config);
  const targets = buildTargetSummaries(config, history, nextLatestMap);

  return json({
    skipped: false,
    mode: config.probeMode,
    probed_targets: dueTargets.map((target) => target.id),
    samples,
    sample: samples[0] || null,
    targets,
    summary: summarizeHistory(history, config),
  });
}

async function runProbeBatch(targets, config, context) {
  if (config.probeMode === 'stagger' && config.probeStaggerMs > 0) {
    const jobs = targets.map(async (target, index) => {
      await sleep(index * config.probeStaggerMs);
      return runProbe(target, context);
    });

    return Promise.all(jobs);
  }

  return Promise.all(targets.map((target) => runProbe(target, context)));
}

async function runProbe(target, context) {
  const id = createId();
  const startedAt = new Date().toISOString();
  const startedMs = nowMs();
  const endpoint = buildEndpoint(target.baseUrl, target.apiPath);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort('timeout'), target.timeoutMs);

  let httpStatus = null;
  let firstTokenMs = null;
  let responseHeaderMs = null;
  let outputText = '';
  let chunkCount = 0;
  let usageCompletionTokens = null;

  try {
    if (!target.apiKey) {
      throw new Error(`API key for target ${target.label} is not configured`);
    }

    const body = {
      model: target.model,
      messages: [{ role: 'user', content: target.prompt }],
      temperature: 0,
      stream: true,
      max_tokens: target.maxTokens,
    };

    if (target.includeStreamUsage) {
      body.stream_options = { include_usage: true };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${target.apiKey}`,
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
    let streamDone = false;

    const ingestPayload = (payload) => {
      if (!payload) {
        return;
      }

      if (payload === '[DONE]') {
        streamDone = true;
        return;
      }

      const parsed = safeJsonParse(payload);

      if (!parsed) {
        return;
      }

      const completionTokens = extractCompletionTokens(parsed);

      if (Number.isFinite(completionTokens)) {
        usageCompletionTokens = completionTokens;
      }

      const deltaText = extractDeltaText(parsed);

      if (deltaText) {
        const tokenTimeMs = nowMs();
        firstTokenMs = firstTokenMs ?? tokenTimeMs;
        outputText += deltaText;
        chunkCount += 1;
      }
    };

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const extracted = extractStreamPayloads(buffer);
      buffer = extracted.rest;

      for (const payload of extracted.payloads) {
        ingestPayload(payload);
      }

      if (streamDone) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be closed by the upstream.
        }
        break;
      }
    }

    if (!streamDone) {
      buffer += decoder.decode();
    }

    if (!streamDone && buffer.trim()) {
      const extracted = extractStreamPayloads(buffer, { flush: true });

      for (const payload of extracted.payloads) {
        ingestPayload(payload);
      }
    }

    if (!firstTokenMs) {
      throw new Error('No streamed content token was received');
    }

    const endedMs = nowMs();
    const outputTokens = Number.isFinite(usageCompletionTokens)
      ? usageCompletionTokens
      : estimateTokenCount(outputText, chunkCount);
    const generationSeconds = Math.max((endedMs - firstTokenMs) / 1000, 0.001);
    const tps = outputTokens / generationSeconds;

    return sanitizeSample({
      id,
      target_id: target.id,
      target_label: target.label,
      ok: true,
      status: 'up',
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      model: target.model,
      base_host: safeHostname(target.baseUrl),
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
      target_id: target.id,
      target_label: target.label,
      ok: false,
      status: 'down',
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      model: target.model,
      base_host: safeHostname(target.baseUrl),
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
  const base = {
    apiKey: env.LLM_API_KEY || env.OPENAI_API_KEY || '',
    baseUrl: normalizeBaseUrl(env.LLM_API_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL),
    apiPath: env.LLM_API_PATH || '/chat/completions',
    model: env.LLM_MODEL || env.OPENAI_MODEL || DEFAULT_MODEL,
    prompt: env.LLM_PROMPT || DEFAULT_PROMPT,
    maxTokens: toInteger(env.LLM_MAX_TOKENS, DEFAULT_MAX_TOKENS, 1, 4096),
    timeoutMs: toInteger(env.LLM_PROBE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 120000),
    includeStreamUsage: env.LLM_STREAM_OPTIONS_INCLUDE_USAGE !== 'false',
    ttftDegradedMs: toInteger(env.LLM_TTFT_DEGRADED_MS, 3000, 100, 600000),
    tpsDegradedBelow: toNumber(env.LLM_TPS_DEGRADED_BELOW, 5, 0, 1000),
  };

  const config = {
    ...base,
    intervalSeconds: toInteger(env.LLM_PROBE_INTERVAL_SECONDS, DEFAULT_INTERVAL_SECONDS, 10, 3600),
    historyLimit: toInteger(env.LLM_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT, 10, 5000),
    windowHours: toInteger(env.LLM_UPTIME_WINDOW_HOURS, DEFAULT_WINDOW_HOURS, 1, 168),
    cronSecret: env.PROBE_CRON_SECRET || '',
    probeMode: env.LLM_PROBE_MODE === 'stagger' ? 'stagger' : 'parallel',
    probeStaggerMs: toInteger(env.LLM_PROBE_STAGGER_MS, 0, 0, 60000),
    siteTitle: decodeDisplayEnv(env.SITE_TITLE || env.PUBLIC_SITE_TITLE || DEFAULT_SITE_TITLE),
    siteSubtitle: decodeDisplayEnv(env.SITE_SUBTITLE || env.PUBLIC_SITE_SUBTITLE || DEFAULT_SITE_SUBTITLE),
  };

  config.targets = readTargets(env, base);
  return config;
}

function readTargets(env, base) {
  const parsedTargets = safeJsonParse(env.LLM_TARGETS);

  if (Array.isArray(parsedTargets) && parsedTargets.length) {
    return normalizeTargets(
      parsedTargets.map((target, index) => ({
        id: target.id,
        label: target.label || target.name,
        apiKey: target.api_key || target.apiKey || base.apiKey,
        baseUrl: target.base_url || target.baseUrl || target.api_base_url || base.baseUrl,
        apiPath: target.api_path || target.apiPath || base.apiPath,
        model: target.model || base.model,
        prompt: target.prompt || base.prompt,
        maxTokens: target.max_tokens || target.maxTokens || base.maxTokens,
        timeoutMs: target.timeout_ms || target.timeoutMs || base.timeoutMs,
        includeStreamUsage:
          target.include_stream_usage ?? target.includeStreamUsage ?? base.includeStreamUsage,
        ttftDegradedMs: target.ttft_degraded_ms || target.ttftDegradedMs || base.ttftDegradedMs,
        tpsDegradedBelow: target.tps_degraded_below || target.tpsDegradedBelow || base.tpsDegradedBelow,
        index,
      })),
    );
  }

  const modelList = splitList(env.LLM_MODELS || env.LLM_MODEL || env.OPENAI_MODEL || DEFAULT_MODEL);

  return normalizeTargets(
    modelList.map((model, index) => ({
      ...base,
      id: model,
      label: model,
      model,
      index,
    })),
  );
}

function normalizeTargets(targets) {
  const usedIds = new Map();

  return targets.map((target, index) => {
    const model = String(target.model || DEFAULT_MODEL).trim();
    const baseId = slugify(target.id || model || `target-${index + 1}`);
    const usedCount = usedIds.get(baseId) || 0;
    usedIds.set(baseId, usedCount + 1);
    const id = usedCount ? `${baseId}-${usedCount + 1}` : baseId;

    return {
      id,
      label: String(target.label || model || id).trim(),
      apiKey: String(target.apiKey || ''),
      baseUrl: normalizeBaseUrl(target.baseUrl || DEFAULT_BASE_URL),
      apiPath: target.apiPath || '/chat/completions',
      model,
      prompt: String(target.prompt || DEFAULT_PROMPT),
      maxTokens: toInteger(target.maxTokens, DEFAULT_MAX_TOKENS, 1, 4096),
      timeoutMs: toInteger(target.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 120000),
      includeStreamUsage: target.includeStreamUsage !== false,
      ttftDegradedMs: toInteger(target.ttftDegradedMs, 3000, 100, 600000),
      tpsDegradedBelow: toNumber(target.tpsDegradedBelow, 5, 0, 1000),
    };
  });
}

function publicConfig(config) {
  return {
    configured: config.targets.length > 0 && config.targets.every((target) => target.apiKey && target.model && target.baseUrl),
    target_count: config.targets.length,
    models: config.targets.map((target) => target.model),
    base_host: config.targets.length === 1 ? safeHostname(config.targets[0].baseUrl) : 'multiple',
    api_path: config.targets.length === 1 ? config.targets[0].apiPath : 'multiple',
    interval_seconds: config.intervalSeconds,
    timeout_ms: config.timeoutMs,
    max_tokens: config.maxTokens,
    window_hours: config.windowHours,
    probe_mode: config.probeMode,
    site_title: config.siteTitle,
    site_subtitle: config.siteSubtitle,
    project_repo_url: DEFAULT_PROJECT_REPO_URL,
    prompt_preview: truncate(config.prompt, 120),
  };
}

function publicTargetConfig(target) {
  return {
    id: target.id,
    label: target.label,
    configured: Boolean(target.apiKey && target.model && target.baseUrl),
    model: target.model,
    base_host: safeHostname(target.baseUrl),
    api_path: target.apiPath,
    timeout_ms: target.timeoutMs,
    max_tokens: target.maxTokens,
    prompt_preview: truncate(target.prompt, 120),
  };
}

function getStore(context) {
  const env = context.env || {};
  const kv = [...getEnvKvCandidates(env), ...getGlobalKvCandidates()].find(
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

function getEnvKvCandidates(env) {
  return [env.LLM_MONITOR_KV, env.MONITOR_KV, env.KV];
}

function getGlobalKvCandidates() {
  return [
    typeof LLM_MONITOR_KV !== 'undefined' ? LLM_MONITOR_KV : null,
    typeof MONITOR_KV !== 'undefined' ? MONITOR_KV : null,
    typeof KV !== 'undefined' ? KV : null,
    globalThis?.LLM_MONITOR_KV,
    globalThis?.MONITOR_KV,
    globalThis?.KV,
  ];
}

async function readLatestMap(store, config) {
  const raw = await safeStoreGet(store, LATEST_KEY);
  const parsed = safeJsonParse(raw);

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !parsed.started_at) {
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([targetId, sample]) => [targetId, sanitizeSample(sample)])
        .filter(([, sample]) => sample),
    );
  }

  if (parsed?.started_at) {
    const sample = sanitizeSample(parsed);
    return sample ? { [sample.target_id || config.targets[0]?.id || 'default']: sample } : {};
  }

  const legacy = safeJsonParse(await safeStoreGet(store, LEGACY_LATEST_KEY));
  const legacySample = sanitizeSample(legacy);

  if (!legacySample || !config.targets[0]) {
    return {};
  }

  legacySample.target_id = config.targets[0].id;
  legacySample.target_label = config.targets[0].label;
  return { [config.targets[0].id]: legacySample };
}

async function readHistory(store, config) {
  const raw = await safeStoreGet(store, HISTORY_KEY);
  const parsed = safeJsonParse(raw);

  if (Array.isArray(parsed)) {
    return parsed.map(sanitizeSample).filter(Boolean);
  }

  const legacyRaw = await safeStoreGet(store, LEGACY_HISTORY_KEY);
  const legacyParsed = safeJsonParse(legacyRaw);

  if (!Array.isArray(legacyParsed) || !config.targets[0]) {
    return [];
  }

  return legacyParsed
    .map((sample) =>
      sanitizeSample({
        ...sample,
        target_id: sample.target_id || config.targets[0].id,
        target_label: sample.target_label || config.targets[0].label,
      }),
    )
    .filter(Boolean);
}

async function appendSamples(store, samples, config) {
  const history = await readHistory(store, config);
  const usableSamples = samples.map(sanitizeSample).filter(Boolean);
  const limit = Math.max(config.historyLimit * Math.max(config.targets.length, 1), config.targets.length);
  const nextHistory = [...history, ...usableSamples].slice(-limit);
  const latestMap = await readLatestMap(store, config);

  for (const sample of usableSamples) {
    latestMap[sample.target_id] = sample;
  }

  await safeStorePut(store, HISTORY_KEY, JSON.stringify(nextHistory));
  await safeStorePut(store, LATEST_KEY, JSON.stringify(latestMap));

  return nextHistory;
}

async function safeStoreGet(store, key) {
  try {
    return await store.get(key);
  } catch (error) {
    if (isKvKeyValidationError(error)) {
      return null;
    }

    throw error;
  }
}

async function safeStorePut(store, key, value) {
  try {
    await store.put(key, value);
  } catch (error) {
    if (isKvKeyValidationError(error)) {
      throw new Error(`KV key "${key}" is invalid for the current EdgeOne KV namespace`);
    }

    throw error;
  }
}

function isKvKeyValidationError(error) {
  return /key can only contain letters, numbers, and underscores/i.test(error?.message || String(error));
}

function buildTargetSummaries(config, history, latestMap) {
  return config.targets.map((target) => {
    const targetHistory = history.filter((sample) => sample.target_id === target.id);
    const latest = latestMap[target.id] || targetHistory.at(-1) || null;
    const status = computeTargetStatus(latest, target, config);

    return {
      id: target.id,
      label: target.label,
      status,
      config: publicTargetConfig(target),
      latest,
      summary: summarizeHistory(targetHistory, config),
      one_hour_summary: summarizeHistory(targetHistory, config, 1),
      history: targetHistory,
    };
  });
}

function summarizeHistory(history, config, windowHours = config.windowHours) {
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
  const windowed = history.filter((sample) => Date.parse(sample.started_at) >= cutoff);
  const okSamples = windowed.filter((sample) => sample.ok);
  const failedSamples = windowed.length - okSamples.length;
  const ttftValues = okSamples.map((sample) => sample.ttft_ms).filter(Number.isFinite);
  const tpsValues = okSamples.map((sample) => sample.tps).filter(Number.isFinite);

  return {
    window_hours: windowHours,
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

function computeFleetStatus(targets) {
  if (!targets.length) {
    return 'unknown';
  }

  const statuses = targets.map((target) => target.status);

  if (statuses.every((status) => status === 'unknown')) {
    return 'unknown';
  }

  if (statuses.every((status) => status === 'down')) {
    return 'down';
  }

  if (statuses.includes('down') || statuses.includes('degraded')) {
    return 'degraded';
  }

  if (statuses.includes('stale')) {
    return 'stale';
  }

  return 'up';
}

function computeTargetStatus(latest, target, config) {
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
    (latest.ttft_ms > target.ttftDegradedMs || latest.tps < target.tpsDegradedBelow)
  ) {
    return 'degraded';
  }

  return 'up';
}

function filterTargets(targets, requestedTarget) {
  if (!requestedTarget) {
    return targets;
  }

  const normalized = slugify(requestedTarget);
  return targets.filter(
    (target) =>
      target.id === requestedTarget ||
      target.model === requestedTarget ||
      target.label === requestedTarget ||
      target.id === normalized,
  );
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

  return firstNonEmptyText([
    delta.content,
    delta.reasoning_content,
    delta.reasoning,
    choice?.message?.content,
    choice?.message?.reasoning_content,
    choice?.message?.reasoning,
    choice?.text,
    parsed?.message?.content,
    parsed?.delta?.content,
    parsed?.delta?.reasoning,
    parsed?.response,
    parsed?.content,
    parsed?.output_text,
    parsed?.text,
  ]);
}

function extractCompletionTokens(parsed) {
  return numberOrUndefined(
    parsed?.usage?.completion_tokens ??
      parsed?.usage?.output_tokens ??
      parsed?.usage?.completionTokens ??
      parsed?.usage?.generated_tokens ??
      parsed?.completion_tokens ??
      parsed?.output_tokens ??
      parsed?.eval_count,
  );
}

function extractStreamPayloads(buffer, { flush = false } = {}) {
  const lines = buffer.split(/\r?\n/);
  const rest = flush ? '' : lines.pop() || '';
  const payloads = [];
  const pendingDataLines = [];

  const pushPendingDataLines = () => {
    if (pendingDataLines.length) {
      payloads.push(pendingDataLines.join('\n').trim());
      pendingDataLines.length = 0;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith(':')) {
      pushPendingDataLines();
      continue;
    }

    if (trimmed.startsWith('data:')) {
      pendingDataLines.push(trimmed.slice(5).trim());
      continue;
    }

    if (/^(event|id|retry):/i.test(trimmed)) {
      continue;
    }

    pushPendingDataLines();

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      payloads.push(trimmed);
    }
  }

  if (flush && rest.trim()) {
    const trimmed = rest.trim();

    if (trimmed.startsWith('data:')) {
      pendingDataLines.push(trimmed.slice(5).trim());
    } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      pushPendingDataLines();
      payloads.push(trimmed);
    }
  }

  pushPendingDataLines();

  return { payloads, rest };
}

function toText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        return item?.text || item?.content || item?.value || '';
      })
      .join('');
  }

  return '';
}

function firstNonEmptyText(values) {
  for (const value of values) {
    const text = toText(value);

    if (text) {
      return text;
    }
  }

  return '';
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
    target_id: sample.target_id || slugify(sample.model || 'default'),
    target_label: sample.target_label || sample.model || 'default',
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

function decodeDisplayEnv(value) {
  return String(value || '').replace(/--/g, ' ');
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function slugify(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'default';
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

function numberOrUndefined(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function createId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
