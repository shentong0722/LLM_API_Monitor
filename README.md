# LLM API Monitor

**Chinese documentation:** [README.zh-CN.md](./README.zh-CN.md)

LLM API Monitor is a public dashboard for measuring OpenAI-compatible streaming API performance across one or more models. It tracks TTFT, TPS, uptime, recent samples, and per-model one-hour averages.

## Features

- OpenAI-compatible `/chat/completions` streaming probe.
- Multi-model monitoring with `LLM_MODELS` or advanced `LLM_TARGETS`.
- TTFT, TPS, uptime, recent history, and per-model details.
- EdgeOne Pages deployment with Cloud Functions.
- Optional persistent history via EdgeOne Pages KV.
- Custom dashboard title, subtitle, and footer repository link.

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
LLM_PROMPT=Reply with one short sentence about API latency monitoring.
LLM_MAX_TOKENS=80
LLM_PROBE_INTERVAL_SECONDS=60
LLM_PROBE_TIMEOUT_MS=30000
PROBE_CRON_SECRET=replace-with-a-long-random-token

SITE_TITLE=LLM API Monitor
SITE_SUBTITLE=OpenAI-compatible stream
PROJECT_REPO_URL=https://github.com/shentong0722/LLM_API_Monitor
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

`/api/summary` returns public dashboard data. `/api/probe` sends real upstream streaming requests and writes samples to KV when KV is available.

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
