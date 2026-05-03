# LLM API Monitor

面向公众展示的 OpenAI 兼容 LLM API 流式性能监测面板。它会记录 TTFT、TPS、请求成功率和最近采样历史，适合部署到腾讯云 EdgeOne Pages。

## 架构

- 前端：Vite + React，静态资源构建到 `dist/`。
- 函数：`edge-functions/api/[[default]].js`，提供 `/api/summary`、`/api/probe`、`/api/health`。
- 存储：推荐绑定 EdgeOne Pages KV，变量名设置为 `LLM_MONITOR_KV`。
- 定时：使用外部 Cron 定时请求 `/api/probe?token=...`，面板只读请求 `/api/summary`。

## 本地开发

```bash
cd llm-api-monitor
npm install
npm run dev
```

普通 Vite dev server 只展示前端；如果没有 EdgeOne Functions 运行时，页面会显示本地演示数据。

函数联调：

```bash
npm install -g edgeone
cd llm-api-monitor
edgeone pages dev
```

## 环境变量

复制 `.env.example` 后按实际上游填写。EdgeOne Pages 控制台中也需要配置同名环境变量。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `LLM_API_BASE_URL` | 是 | OpenAI 兼容 API 基址，例如 `https://api.openai.com/v1` |
| `LLM_API_KEY` | 是 | 上游 API Key，也兼容 `OPENAI_API_KEY` |
| `LLM_MODEL` | 是 | 需要监测的模型名 |
| `LLM_PROMPT` | 否 | 固定提示词 |
| `LLM_MAX_TOKENS` | 否 | 单次探测输出上限，默认 `80` |
| `LLM_PROBE_INTERVAL_SECONDS` | 否 | 采样间隔，默认 `60` |
| `LLM_PROBE_TIMEOUT_MS` | 否 | 单次探测超时，默认 `30000` |
| `PROBE_CRON_SECRET` | 强烈建议 | 定时采样接口密钥 |
| `LLM_STREAM_OPTIONS_INCLUDE_USAGE` | 否 | 是否请求流式 usage，默认 `true` |
| `LLM_TTFT_DEGRADED_MS` | 否 | TTFT 降级阈值，默认 `3000` |
| `LLM_TPS_DEGRADED_BELOW` | 否 | TPS 降级阈值，默认 `5` |

## API

### `GET /api/summary`

公开只读接口，返回最新样本、历史样本、24 小时 uptime 和聚合指标。

### `GET /api/probe?token=PROBE_CRON_SECRET`

执行一次真实流式采样并写入 KV。请求会发送到：

```text
{LLM_API_BASE_URL}/chat/completions
```

请求体为 OpenAI Chat Completions 兼容格式：

```json
{
  "model": "your-model",
  "messages": [{ "role": "user", "content": "fixed prompt" }],
  "temperature": 0,
  "stream": true,
  "max_tokens": 80,
  "stream_options": { "include_usage": true }
}
```

如果上游不支持 `stream_options.include_usage`，把 `LLM_STREAM_OPTIONS_INCLUDE_USAGE=false`。

## EdgeOne Pages 部署步骤

1. 将 `llm-api-monitor` 推送到 GitHub 或 Gitee 仓库。
2. 打开 EdgeOne Pages 控制台，创建 Pages 项目并选择该仓库。
3. 构建配置：
   - Framework preset：Vite 或 Other
   - Build command：`npm run build`
   - Output directory：`dist`
   - Install command：`npm install`
4. 在项目环境变量中配置 `LLM_API_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`、`PROBE_CRON_SECRET` 等变量。
5. 开通 Pages KV，创建 Namespace，并在项目里绑定 KV，变量名填写 `LLM_MONITOR_KV`。
6. 部署项目。部署后确认：
   - `https://your-domain/api/health`
   - `https://your-domain/api/summary`
7. 配置定时任务，每分钟请求：

```bash
curl -fsS "https://your-domain/api/probe?token=PROBE_CRON_SECRET"
```

可用 GitHub Actions、腾讯云 SCF 定时触发、crontab、cron-job.org 或其他监控系统执行。建议触发间隔与 `LLM_PROBE_INTERVAL_SECONDS` 保持一致。

## GitHub Actions Cron 示例

```yaml
name: Probe LLM API

on:
  schedule:
    - cron: "* * * * *"
  workflow_dispatch:

jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger probe
        run: curl -fsS "${{ secrets.MONITOR_PROBE_URL }}"
```

把仓库 secret `MONITOR_PROBE_URL` 设置为完整探测 URL，例如：

```text
https://your-domain/api/probe?token=your-secret
```

## 指标口径

- TTFT：从 EdgeOne 函数发起请求到收到首个非空流式内容片段。
- TPS：优先使用上游流式 usage 中的 `completion_tokens`，否则用文本长度估算 token 数，再除以首 token 后的生成时长。
- Uptime：默认统计最近 24 小时内成功样本占比。
- Stale：最近样本超过 `max(3 * interval, 180s)` 未更新时显示过期。
