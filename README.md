# openclaw-langfuse-plugin

English | [中文](./README.zh-CN.md)

Full observability plugin for [OpenClaw](https://github.com/openclaw/openclaw) via [Langfuse](https://langfuse.com).

Traces every agent turn with per-LLM-call generations, tool call spans, sub-agent lifecycle, session events, and compaction tracking.

- **Zero npm dependencies** — uses the Langfuse REST API directly via native `fetch`.
- **No image rebuild required** — drop the plugin folder into your extensions directory and restart.

## What it records

### Trace (per agent turn)

| Field | Value |
|-------|-------|
| Trace name | `openclaw-turn` |
| Session ID | OpenClaw session key (e.g. `agent:main:discord:dm:123456`) |
| User ID | Agent ID (e.g. `main`, `jarvis`) |
| Tags | `["openclaw", "<agentId>", "<channelId>"]` |
| Input | The user's message |
| Output | The agent's final response |
| Metadata | `success`, `error`, `durationMs`, `messageCount`, `channelId`, `trigger` |

### Generation (per LLM call)

| Field | Value |
|-------|-------|
| Name | `<provider>/<model>` (e.g. `anthropic/claude-4-opus`) |
| Model | Exact model ID from the LLM call |
| Provider | `anthropic`, `openai`, `ollama`, etc. |
| Input | System prompt + user prompt |
| Output | Full assistant response text |
| Token usage | `input`, `output`, `inputCached`, `inputCacheWrite`, `total` |
| Duration | Per-call start → end time |

### Span (per tool call)

| Field | Value |
|-------|-------|
| Name | `tool: <toolName>` (e.g. `tool: exec`, `tool: read`) |
| Input | Tool call parameters (JSON) |
| Output | Tool result or error |
| Level | `DEFAULT` on success, `ERROR` on failure |
| Duration | Per-call start → end time |

### Span (per sub-agent)

| Field | Value |
|-------|-------|
| Name | `subagent: <label or agentId>` |
| Level | `ERROR` on error/timeout/killed, `DEFAULT` otherwise |
| Metadata | `targetSessionKey`, `targetKind`, `outcome`, `reason` |

### Events

| Event | When |
|-------|------|
| `session_start` | New session created or resumed |
| `session_end` | Session ends (includes `messageCount`, `durationMs`) |
| `compaction_start` | Context compaction begins (includes `messageCount`, `tokenCount`) |
| `compaction_end` | Context compaction finishes (includes `compactedCount`) |

### Trace structure in Langfuse

```
trace (openclaw-turn)
  ├── generation (anthropic/claude-4-opus)     # 1st LLM call
  ├── span (tool: exec)                        # tool call
  ├── generation (anthropic/claude-4-opus)     # 2nd LLM call (after tool result)
  ├── span (tool: read)                        # another tool call
  ├── generation (anthropic/claude-4-opus)     # 3rd LLM call
  ├── span (subagent: researcher)              # sub-agent lifecycle
  ├── event (compaction_start)                 # context compaction
  ├── event (compaction_end)
  ├── event (session_start)
  └── event (session_end)
```

## Installation

### Option 1: Clone into extensions directory

```bash
cd ~/.openclaw/extensions   # or {workspaceDir}/.openclaw/extensions
git clone https://github.com/widwei/openclaw-langfuse-plugin.git openclaw-langfuse-plugin
```

### Option 2: Copy manually

```bash
mkdir -p ~/.openclaw/extensions/openclaw-langfuse-plugin
cp index.js openclaw.plugin.json ~/.openclaw/extensions/openclaw-langfuse-plugin/
```

### Option 3: Docker volume mount

```bash
tar -czf - openclaw-langfuse-plugin/ | ssh user@your-host \
  'cd /path/to/openclaw/workspace/.openclaw/extensions && tar -xzf -'
```

The plugin auto-discovers at startup from:

```
{workspaceDir}/.openclaw/extensions/openclaw-langfuse-plugin/
```

## Configuration

### Environment variables

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

The plugin registers 12 hooks across 6 categories:

| Category | Hooks | Langfuse event type |
|----------|-------|---------------------|
| Trace lifecycle | `before_agent_start`, `agent_end` | `trace-create` |
| LLM calls | `llm_input`, `llm_output` | `generation-create` |
| Tool calls | `before_tool_call`, `after_tool_call` | `span-create` |
| Sessions | `session_start`, `session_end` | `event-create` |
| Compaction | `before_compaction`, `after_compaction` | `event-create` |
| Sub-agents | `subagent_spawned`, `subagent_ended` | `span-create` |

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
