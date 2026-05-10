# LLM API Monitor

**Chinese documentation:** [README.zh-CN.md](./README.zh-CN.md)

LLM API Monitor is a public dashboard for measuring OpenAI-compatible streaming API performance across one or more models. It tracks TTFT, TPS, uptime, recent samples, and per-model one-hour averages.

## Features

- OpenAI-compatible `/chat/completions` streaming probe.
- Multi-model monitoring with `LLM_MODELS` or advanced `LLM_TARGETS`.
- TTFT, TPS, uptime, recent history, and per-model details.
- Non-stream fallback health probe after any failed streaming probe.
- EdgeOne Pages deployment with Cloud Functions.
- Optional persistent history via EdgeOne Pages KV.
- Custom dashboard title and subtitle.
- Fixed footer link to this open-source project: https://github.com/shentong0722/LLM_API_Monitor

## Project Structure

```text
cloud-functions/api/[[default]].js  API route entry for /api/*
shared/api-handler.js               Probe, storage, and summary logic
src/                                React dashboard
scripts/copy-functions.mjs          Copies functions into dist/ after build
edgeone.json                        EdgeOne runtime config
```

## Local Development

```bash
npm install
npm run dev
```

The Vite dev server shows demo data if EdgeOne Functions are not running locally.

Build:

```bash
npm run build
```

## Environment Variables

Do not commit real secrets. Put production secrets in the EdgeOne Pages console.

```env
LLM_API_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-REPLACE_ME
LLM_MODELS=gpt-4o-mini,gpt-4.1-mini
LLM_PROMPT=Reply_with_one_short_sentence_about_API_latency_monitoring.
LLM_MAX_TOKENS=80
LLM_PROBE_INTERVAL_SECONDS=60
LLM_PROBE_TIMEOUT_MS=30000
LLM_PROBE_MODE=parallel
LLM_PROBE_STAGGER_MS=0
LLM_HISTORY_RETENTION_HOURS=168
LLM_UPTIME_WINDOW_HOURS=24
LLM_GLOBAL_STATUS_WINDOW_HOURS=1
LLM_GLOBAL_STATUS_INCIDENT_THRESHOLD_PCT=20
PROBE_CRON_SECRET=replace-with-a-long-random-token

SITE_TITLE=LLM_API_Monitor
SITE_SUBTITLE=OpenAI-compatible_stream
```

EdgeOne Pages may reject spaces in environment variable values. For `SITE_TITLE`, `SITE_SUBTITLE`, and `LLM_PROMPT`, write `_` to render a space. Other environment variables are not decoded this way.

For multiple slow models, set `LLM_PROBE_MODE=stagger` and `LLM_PROBE_STAGGER_MS=15000` or `30000` so probes start at different times instead of all at once. The included `edgeone.json` sets Cloud Functions `maxDuration` to 120 seconds, which is the documented configurable upper bound for EdgeOne Pages Cloud Functions.

Status and retention defaults:

- Stored sample history is retained for 168 hours, or 7 days.
- `LLM_HISTORY_LIMIT` can cap the maximum samples retained per model. By default it is calculated from retention hours and probe interval.
- Per-model uptime is calculated over the latest 24 hours.
- The top global status is calculated over the latest 1 hour. A model only contributes degraded/down global status when at least 20% of its samples in that window are degraded or failed.
- Each row in the model overview shows the latest sample status, while its TTFT and TPS columns show 1-hour averages.
- If a streaming probe fails but the non-stream fallback succeeds, the sample is counted as up for uptime, while TTFT and TPS stay empty and are excluded from performance averages.

```env
SITE_TITLE=LLM_API_Monitor
SITE_SUBTITLE=OpenAI-compatible_stream
LLM_PROMPT=Reply_with_one_short_sentence.
```

Advanced multi-upstream configuration:

```env
LLM_TARGETS=[{"id":"openai-mini","label":"OpenAI Mini","model":"gpt-4o-mini","base_url":"https://api.openai.com/v1","api_key":"sk-REPLACE_ME"},{"id":"other-model","label":"Other Model","model":"model-name","base_url":"https://api.example.com/v1","api_key":"sk-REPLACE_ME"}]
```

## API

```text
GET /api/health
GET /api/summary
GET /api/probe?token=PROBE_CRON_SECRET
GET /api/probe?token=PROBE_CRON_SECRET&force=1
GET /api/probe?token=PROBE_CRON_SECRET&target=model-id&force=1
```

`/api/summary` returns public dashboard data. It keeps aggregate metrics based on the full retained KV history, but only sends the recent history needed by the charts, uptime strip, and latest-samples table so periodic dashboard polling stays small. `/api/probe` sends real upstream streaming requests and writes samples to KV when KV is available. If the streaming probe fails, it immediately sends a non-stream fallback request with prompt `test` and `max_tokens: 10`; a successful fallback sample is marked up without TTFT or TPS.

## Status Rules

The global status is based on the last one hour, not only the newest sample. A model is marked degraded or down only when more than 10% of its one-hour samples are degraded or failed. The top global card shows how many models are currently degraded or failed.

## EdgeOne Pages Deployment

Use these build settings:

```text
Install command: npm install
Build command: npm run build
Output directory: dist
```

Bind an EdgeOne Pages KV namespace with variable name:

```text
LLM_MONITOR_KV
```

After deployment, verify persistent storage:

```bash
curl -fsS "https://your-domain/api/summary"
```

The response should include:

```json
{
  "storage": {
    "available": true,
    "type": "edgeone-kv"
  }
}
```

If it says `memory-fallback`, the function did not receive the KV binding and history will not survive redeploys.

## Ubuntu Cron

Create a small probe script:

```bash
sudo mkdir -p /opt/llm-api-monitor
sudo nano /opt/llm-api-monitor/probe.sh
```

```bash
#!/usr/bin/env bash
set -euo pipefail

curl -fsS --max-time 130 "https://your-domain/api/probe?token=YOUR_SECRET" >/dev/null
```

Enable it:

```bash
sudo chmod +x /opt/llm-api-monitor/probe.sh
crontab -e
```

Run once per minute:

```cron
* * * * * /opt/llm-api-monitor/probe.sh >> /var/log/llm-api-monitor-probe.log 2>&1
```

## License

MIT
