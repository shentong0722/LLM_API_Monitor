# LLM API Monitor

面向公众展示的 OpenAI 兼容 LLM API 流式性能监测面板。它会记录多模型的 TTFT、TPS、请求成功率和最近采样历史，适合部署到腾讯云 EdgeOne Pages。

## 架构

- 前端：Vite + React，静态资源构建到 `dist/`。
- 函数：`cloud-functions/api/[[default]].js`，提供 `/api/summary`、`/api/probe`、`/api/health`。
- 共享逻辑：`shared/api-handler.js`。
- 存储：推荐绑定 EdgeOne Pages KV，变量名设置为 `LLM_MONITOR_KV`。
- 定时：使用外部 Cron 定时请求 `/api/probe?token=...`，面板只读请求 `/api/summary`。
- 执行时长：探测接口使用 Cloud Functions，并在 `edgeone.json` 将 Node.js 最大执行时长配置为 120 秒，避免长流式请求被 Edge Functions 的短执行场景截断。
- 构建环境：`edgeone.json` 固定构建 Node.js 版本为 `20.18.0`，并显式指定 Cloud Functions 中国大陆地域为 `ap-guangzhou`。

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

复制 `.env.example` 后按实际上游填写。EdgeOne Pages 控制台中也需要配置同名环境变量。真实密钥只放本机 `.env` 或 EdgeOne 控制台，不要提交到 GitHub。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `LLM_API_BASE_URL` | 是 | OpenAI 兼容 API 基址，例如 `https://api.openai.com/v1` |
| `LLM_API_KEY` | 是 | 上游 API Key，也兼容 `OPENAI_API_KEY` |
| `LLM_MODEL` | 单模型必填 | 单模型模式下的模型名 |
| `LLM_MODELS` | 多模型推荐 | 同一个上游下的多模型列表，用英文逗号分隔，例如 `gpt-4o-mini,gpt-4.1-mini` |
| `LLM_TARGETS` | 高级可选 | JSON 数组，用于配置不同上游、不同 key 或不同 prompt 的多个目标 |
| `SITE_TITLE` | 否 | 面板标题，默认 `LLM API Monitor` |
| `SITE_SUBTITLE` | 否 | 面板副标题，默认 `OpenAI-compatible stream` |
| `LLM_PROMPT` | 否 | 固定提示词 |
| `LLM_MAX_TOKENS` | 否 | 单次探测输出上限，默认 `80` |
| `LLM_PROBE_INTERVAL_SECONDS` | 否 | 采样间隔，默认 `60` |
| `LLM_PROBE_TIMEOUT_MS` | 否 | 单个模型的探测超时，默认 `30000` |
| `LLM_PROBE_MODE` | 否 | `parallel` 或 `stagger`，默认 `parallel` |
| `LLM_PROBE_STAGGER_MS` | 否 | `stagger` 模式下每个模型错开的毫秒数，默认 `0`，慢模型建议 `15000` 或 `30000` |
| `LLM_HISTORY_RETENTION_HOURS` | 否 | 历史样本保留时长，默认 `168`，也就是 7 天 |
| `LLM_HISTORY_LIMIT` | 否 | 每个模型最多保留的样本数，默认按保留时长和采样间隔自动计算 |
| `LLM_UPTIME_WINDOW_HOURS` | 否 | Uptime 统计窗口，默认 `24` |
| `LLM_GLOBAL_STATUS_WINDOW_HOURS` | 否 | 顶部全局状态统计窗口，默认 `1` |
| `LLM_GLOBAL_STATUS_INCIDENT_THRESHOLD_PCT` | 否 | 顶部全局状态降级/故障阈值，默认 `20` |
| `PROBE_CRON_SECRET` | 强烈建议 | 定时采样接口密钥 |
| `LLM_STREAM_OPTIONS_INCLUDE_USAGE` | 否 | 是否请求流式 usage，默认 `true` |
| `LLM_TTFT_DEGRADED_MS` | 否 | TTFT 降级阈值，默认 `3000` |
| `LLM_TPS_DEGRADED_BELOW` | 否 | TPS 降级阈值，默认 `5` |

### 多模型配置

同一个上游、同一个 API key 下监测多个模型：

```env
LLM_API_BASE_URL=https://api.example.com/v1
LLM_API_KEY=sk-REPLACE_ME
LLM_MODELS=deepseek-v4-pro,deepseek-v3,deepseek-r1
LLM_PROMPT=Reply_with_one_short_sentence_about_API_latency_monitoring.
LLM_MAX_TOKENS=80
```

不同上游或不同 key 时使用 `LLM_TARGETS`：

```env
LLM_TARGETS=[{"id":"chatst-v4","label":"ChatST v4","model":"deepseek-v4-pro","base_url":"https://api.chatst.org/v1","api_key":"sk-REPLACE_ME"},{"id":"openai-mini","label":"OpenAI Mini","model":"gpt-4o-mini","base_url":"https://api.openai.com/v1","api_key":"sk-REPLACE_ME"}]
```

`LLM_TARGETS` 中可选字段包括：`id`、`label`、`model`、`base_url`、`api_key`、`api_path`、`prompt`、`max_tokens`、`timeout_ms`、`include_stream_usage`、`ttft_degraded_ms`、`tps_degraded_below`。

EdgeOne Pages 如果不允许环境变量值包含空格，`SITE_TITLE`、`SITE_SUBTITLE` 和 `LLM_PROMPT` 可以用 `_` 表示空格。其他环境变量不会做这个替换：

```env
SITE_TITLE=LLM_API_Monitor
SITE_SUBTITLE=OpenAI-compatible_stream
LLM_PROMPT=Reply_with_one_short_sentence.
```

页脚 GitHub 链接固定为 `https://github.com/shentong0722/LLM_API_Monitor`，不提供环境变量修改。

## API

## 状态规则

顶部全局状态不是只看最新一次采样，而是按最近 1 小时窗口计算。只有当某个模型最近 1 小时内达到 20% 的样本为降级或失败时，该模型才会计入顶部的降级或故障。模型概览列表中的正常/降级/故障仍然按每个模型最新一次样本显示。

### `GET /api/summary`

公开只读接口，返回全局状态、`targets[]`、每个模型的最新样本、历史样本、24 小时 uptime 和聚合指标。默认保留最近 7 天历史样本。

### `GET /api/probe?token=PROBE_CRON_SECRET`

执行一次真实流式采样并写入 KV。默认会对所有到期模型并发发起探测。

常用调试参数：

- `force=1`：忽略采样间隔，强制探测。
- `target=TARGET_ID_OR_MODEL`：只探测指定模型。

示例：

```bash
curl -fsS "https://your-domain/api/probe?token=PROBE_CRON_SECRET&force=1"
curl -fsS "https://your-domain/api/probe?token=PROBE_CRON_SECRET&target=deepseek-v4-pro&force=1"
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
   - `npm run build` 会把 `cloud-functions/` 和 `shared/` 同步到 `dist/`，用于兼容只发布输出目录的构建流程。
4. 在项目环境变量中配置 `LLM_API_BASE_URL`、`LLM_API_KEY`、`LLM_MODELS` 或 `LLM_TARGETS`、`PROBE_CRON_SECRET` 等变量。
5. 开通 Pages KV，创建 Namespace，并在项目里绑定 KV，变量名填写 `LLM_MONITOR_KV`。
   - KV 绑定不是普通文本环境变量，不需要再新增一个同名环境变量。
   - 绑定或修改 KV 后需要重新部署；线上是否真正生效以 `/api/summary` 返回的 `storage.type` 为准，正常应为 `edgeone-kv`。
   - 代码会同时兼容 EdgeOne 示例中的全局 KV 绑定变量和 `context.env` 绑定变量。
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

## Ubuntu Cron 示例

创建探测脚本：

```bash
sudo mkdir -p /opt/llm-api-monitor
sudo nano /opt/llm-api-monitor/probe.sh
```

写入：

```bash
#!/usr/bin/env bash
set -euo pipefail

curl -fsS --max-time 130 "https://your-domain/api/probe?token=your-secret" >/dev/null
```

启用脚本并配置定时任务：

```bash
sudo chmod +x /opt/llm-api-monitor/probe.sh
crontab -e
```

每分钟执行一次：

```cron
* * * * * /opt/llm-api-monitor/probe.sh >> /var/log/llm-api-monitor-probe.log 2>&1
```

## 指标口径

- TTFT：从 Cloud Function 发起请求到收到首个非空流式内容片段。
- TPS：优先使用上游流式 usage 中的 `completion_tokens`，否则用文本长度估算 token 数，再除以首 token 后的生成时长。
- Uptime：默认统计最近 24 小时内成功样本占比。
- 历史样本：默认保留最近 7 天；如果采样频率极高或模型很多，可以调低 `LLM_HISTORY_RETENTION_HOURS` 或提高采样间隔。
- Stale：最近样本超过 `max(3 * interval, 180s)` 未更新时显示过期。
