# openclaw-langfuse-plugin

[English](./README.md) | 中文

[OpenClaw](https://github.com/openclaw/openclaw) 的 [Langfuse](https://langfuse.com) 全链路可观测性插件。

为每次 agent 对话记录逐次 LLM 调用的 generation、工具调用 span、子 agent 生命周期、会话事件和上下文压缩追踪。

- **零 npm 依赖** — 通过原生 `fetch` 直接调用 Langfuse REST API
- **无需重新构建镜像** — 将插件文件夹放入 extensions 目录，重启即可

## 记录内容

### Trace（每次 agent 对话）

| 字段 | 值 |
|------|-----|
| Trace 名称 | `openclaw-turn` |
| Session ID | OpenClaw 会话键（如 `agent:main:discord:dm:123456`） |
| User ID | Agent ID（如 `main`、`jarvis`） |
| Tags | `["openclaw", "<agentId>", "<channelId>"]` |
| Input | 用户消息 |
| Output | agent 最终回复 |
| Metadata | `success`、`error`、`durationMs`、`messageCount`、`channelId`、`trigger` |

### Generation（每次 LLM 调用）

| 字段 | 值 |
|------|-----|
| 名称 | `<provider>/<model>`（如 `anthropic/claude-4-opus`） |
| Model | LLM 调用的精确模型 ID |
| Provider | `anthropic`、`openai`、`ollama` 等 |
| Input | 系统提示词 + 用户提示词 |
| Output | 完整的助手消息（结构化 JSON，包含 thinking + text 内容块） |
| Token 用量 | `input`、`output`、`inputCached`、`inputCacheWrite`、`total` |
| 耗时 | 单次调用的起止时间 |
| Metadata | `provider`、`agentId`、`sessionKey`、`thinking`（推理文本，存在时记录） |

### Span（每次工具调用）

| 字段 | 值 |
|------|-----|
| 名称 | `tool: <toolName>`（如 `tool: exec`、`tool: read`） |
| Input | 工具调用参数（JSON） |
| Output | 工具返回结果或错误 |
| Level | 成功为 `DEFAULT`，失败为 `ERROR` |
| 耗时 | 单次调用的起止时间 |

### Span（每个子 agent）

| 字段 | 值 |
|------|-----|
| 名称 | `subagent: <label 或 agentId>` |
| Level | 错误/超时/被终止时为 `ERROR`，其他为 `DEFAULT` |
| Metadata | `targetSessionKey`、`targetKind`、`outcome`、`reason` |

### 事件

| 事件 | 触发时机 |
|------|----------|
| `session_start` | 新会话创建或恢复 |
| `session_end` | 会话结束（包含 `messageCount`、`durationMs`） |
| `compaction_start` | 上下文压缩开始（包含 `messageCount`、`tokenCount`） |
| `compaction_end` | 上下文压缩完成（包含 `compactedCount`） |

### Langfuse 中的 Trace 结构

```
trace (openclaw-turn)
  ├── generation (anthropic/claude-4-opus)     # 第 1 次 LLM 调用
  ├── span (tool: exec)                        # 工具调用
  ├── generation (anthropic/claude-4-opus)     # 第 2 次 LLM 调用（工具结果后）
  ├── span (tool: read)                        # 另一个工具调用
  ├── generation (anthropic/claude-4-opus)     # 第 3 次 LLM 调用
  ├── span (subagent: researcher)              # 子 agent 生命周期
  ├── event (compaction_start)                 # 上下文压缩
  ├── event (compaction_end)
  ├── event (session_start)
  └── event (session_end)
```

## 安装

### 方式一：克隆到 extensions 目录

```bash
cd ~/.openclaw/extensions   # 或 {workspaceDir}/.openclaw/extensions
git clone https://github.com/widwei/openclaw-langfuse-plugin.git openclaw-langfuse-plugin
```

### 方式二：手动复制

```bash
mkdir -p ~/.openclaw/extensions/openclaw-langfuse-plugin
cp index.js openclaw.plugin.json ~/.openclaw/extensions/openclaw-langfuse-plugin/
```

### 方式三：Docker 卷挂载

```bash
tar -czf - openclaw-langfuse-plugin/ | ssh user@your-host \
  'cd /path/to/openclaw/workspace/.openclaw/extensions && tar -xzf -'
```

插件启动时自动从以下路径发现：

```
{workspaceDir}/.openclaw/extensions/openclaw-langfuse-plugin/
```

## 配置

### 环境变量

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-xxxxxxxxxxxxxxxxxxxx
LANGFUSE_SECRET_KEY=sk-lf-xxxxxxxxxxxxxxxxxxxx
LANGFUSE_BASE_URL=https://cloud.langfuse.com    # 或你的自托管地址
```

### 插件配置（替代方式）

在 `openclaw.json` 中：

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

插件配置优先级高于环境变量。

### Docker Compose 示例

```yaml
services:
  openclaw-gateway:
    environment:
      LANGFUSE_PUBLIC_KEY: pk-lf-xxxxxxxxxxxxxxxxxxxx
      LANGFUSE_SECRET_KEY: sk-lf-xxxxxxxxxxxxxxxxxxxx
      LANGFUSE_BASE_URL: http://172.21.0.1:3050
```

## 验证

重启后，检查容器日志：

```
[openclaw-langfuse] Langfuse tracing enabled → https://cloud.langfuse.com
```

如果缺少密钥：

```
[openclaw-langfuse] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set — tracing disabled
```

## LANGFUSE_BASE_URL 参考

| 部署方式 | URL |
|----------|-----|
| Langfuse Cloud | `https://cloud.langfuse.com` |
| 同一 Docker 宿主机（群晖/NAS） | `http://172.21.0.1:3050` |
| 同一 Docker Compose 栈 | `http://langfuse-web:3000` |
| 局域网内其他机器 | `http://<langfuse-host-ip>:3050` |

## 工作原理

插件注册了 6 类共 12 个 hook：

| 类别 | Hook | Langfuse 事件类型 |
|------|------|-------------------|
| Trace 生命周期 | `before_agent_start`、`agent_end` | `trace-create` |
| LLM 调用 | `llm_input`、`llm_output` | `generation-create` |
| 工具调用 | `before_tool_call`、`after_tool_call` | `span-create` |
| 会话 | `session_start`、`session_end` | `event-create` |
| 上下文压缩 | `before_compaction`、`after_compaction` | `event-create` |
| 子 agent | `subagent_spawned`、`subagent_ended` | `span-create` |

插件**静默失败** — 如果密钥缺失、Langfuse 不可达或 ingestion 调用失败，仅记录警告日志并继续运行，不会阻塞 agent。

## 系统要求

- OpenClaw gateway `2026.2.x` 或更高版本（需要插件 hook API 支持）
- Node.js 22+（官方 OpenClaw Docker 镜像已包含）
- Langfuse Cloud 或自托管 Langfuse 实例

## 文件结构

```
openclaw-langfuse-plugin/
├── openclaw.plugin.json   # 插件清单
├── index.js               # 插件实现（零依赖）
├── package.json           # 包元数据
├── LICENSE                # MIT 许可证
├── README.md              # 英文文档
└── README.zh-CN.md        # 中文文档
```

## 许可证

MIT
