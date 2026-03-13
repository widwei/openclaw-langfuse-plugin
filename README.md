# openclaw-langfuse-plugin

English | [中文](./README.zh-CN.md)

OpenClaw plugin for [Langfuse](https://langfuse.com) LLM observability.

Traces every agent turn with **per-LLM-call generations**, accurate model/provider info, structured token usage (including cache hits), and latency tracking.

- **Zero npm dependencies** — uses the Langfuse REST API directly via native `fetch`.
- **No image rebuild required** — drop the plugin folder into your extensions directory and restart.

## What it records

### Per agent turn (trace)

| Field | Value |
|-------|-------|
| Trace name | `openclaw-turn` |
| Session ID | OpenClaw session key (e.g. `agent:main:discord:dm:123456`) |
| User ID | Agent ID (e.g. `main`, `jarvis`) |
| Tags | `["openclaw", "<agentId>", "<channelId>"]` |
| Input | The user's message |
| Output | The agent's final response |
| Metadata | `success`, `error`, `durationMs`, `messageCount`, `channelId`, `trigger` |

### Per LLM call (generation)

| Field | Value |
|-------|-------|
| Name | `<provider>/<model>` (e.g. `anthropic/claude-4-opus`) |
| Model | Exact model ID from the LLM call |
| Provider | `anthropic`, `openai`, `ollama`, etc. |
| Input | System prompt + user prompt |
| Output | Full assistant response text |
| Token usage | `input`, `output`, `inputCached` (cache read), `total` |
| Duration | Per-call start → end time |

If an agent turn involves multiple LLM calls (e.g. tool-use loops), each call appears as a separate generation nested under the same trace.

## Installation

### Option 1: Clone into extensions directory

```bash
cd ~/.openclaw/extensions   # or {workspaceDir}/.openclaw/extensions
git clone https://github.com/openclaw/openclaw-langfuse-plugin.git openclaw-langfuse-plugin
```

### Option 2: Copy manually

```bash
mkdir -p ~/.openclaw/extensions/openclaw-langfuse-plugin
cp index.js openclaw.plugin.json ~/.openclaw/extensions/openclaw-langfuse-plugin/
```

### Option 3: Docker volume mount

```bash
# Copy into your workspace volume
tar -czf - openclaw-langfuse-plugin/ | ssh user@your-host \
  'cd /path/to/openclaw/workspace/.openclaw/extensions && tar -xzf -'
```

The plugin auto-discovers at startup from:

```
{workspaceDir}/.openclaw/extensions/openclaw-langfuse-plugin/
```

## Configuration

### Environment variables

Add these to your OpenClaw gateway environment:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-xxxxxxxxxxxxxxxxxxxx
LANGFUSE_SECRET_KEY=sk-lf-xxxxxxxxxxxxxxxxxxxx
LANGFUSE_BASE_URL=https://cloud.langfuse.com    # or your self-hosted URL
```

### Plugin config (alternative)

In your `openclaw.json`:

```json
{
  "plugins": {
      "openclaw-langfuse-plugin": {
      "publicKey": "pk-lf-xxxxxxxxxxxxxxxxxxxx",
      "secretKey": "sk-lf-xxxxxxxxxxxxxxxxxxxx",
      "baseUrl": "https://cloud.langfuse.com"
    }
  }
}
```

Plugin config takes precedence over environment variables.

### Docker Compose example

```yaml
services:
  openclaw-gateway:
    environment:
      LANGFUSE_PUBLIC_KEY: pk-lf-xxxxxxxxxxxxxxxxxxxx
      LANGFUSE_SECRET_KEY: sk-lf-xxxxxxxxxxxxxxxxxxxx
      LANGFUSE_BASE_URL: http://172.21.0.1:3050
```

## Verify

After restart, check container logs for:

```
[openclaw-langfuse] Langfuse tracing enabled → https://cloud.langfuse.com
```

If keys are missing:

```
[openclaw-langfuse] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set — tracing disabled
```

## LANGFUSE_BASE_URL reference

| Deployment | URL |
|------------|-----|
| Langfuse Cloud | `https://cloud.langfuse.com` |
| Same Docker host (Synology/NAS) | `http://172.21.0.1:3050` |
| Same Docker Compose stack | `http://langfuse-web:3000` |
| Different LAN machine | `http://<langfuse-host-ip>:3050` |

## How it works

The plugin registers four hooks:

| Hook | Purpose |
|------|---------|
| `before_agent_start` | Captures the user prompt and creates a trace ID |
| `llm_input` | Records provider, model, prompt before each LLM call |
| `llm_output` | Pairs with `llm_input`, sends `generation-create` to Langfuse with token usage |
| `agent_end` | Sends `trace-create` to Langfuse with overall success/error status |

The plugin **fails silently** — if keys are missing, Langfuse is unreachable, or an ingestion call fails, it logs a warning and continues. It never blocks the agent.

## Requirements

- OpenClaw gateway `2026.2.x` or later (plugin hook API support)
- Node.js 22+ (included in the official OpenClaw Docker image)
- Langfuse Cloud or self-hosted Langfuse instance

## File structure

```
openclaw-langfuse-plugin/
├── openclaw.plugin.json   # Plugin manifest
├── index.js               # Plugin implementation (zero dependencies)
├── package.json           # Package metadata
├── LICENSE                # MIT license
├── README.md              # English docs
└── README.zh-CN.md        # 中文文档
```

## License

MIT
