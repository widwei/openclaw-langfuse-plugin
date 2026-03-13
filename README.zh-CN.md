# openclaw-langfuse-plugin

[English](./README.md) | 中文

OpenClaw 的 [Langfuse](https://langfuse.com) LLM 可观测性插件。

为每次 agent 对话记录 **逐次 LLM 调用的 generation**，包含精确的模型/提供商信息、结构化的 token 用量（含缓存命中）和延迟追踪。

- **零 npm 依赖** — 通过原生 `fetch` 直接调用 Langfuse REST API
- **无需重新构建镜像** — 将插件文件夹放入 extensions 目录，重启即可

## 记录内容

### 每次 agent 对话（trace）

| 字段 | 值 |
|------|-----|
| Trace 名称 | `openclaw-turn` |
| Session ID | OpenClaw 会话键（如 `agent:main:discord:dm:123456`） |
| User ID | Agent ID（如 `main`、`jarvis`） |
| Tags | `["openclaw", "<agentId>", "<channelId>"]` |
| Input | 用户消息 |
| Output | agent 最终回复 |
| Metadata | `success`、`error`、`durationMs`、`messageCount`、`channelId`、`trigger` |

### 每次 LLM 调用（generation）

| 字段 | 值 |
|------|-----|
| 名称 | `<provider>/<model>`（如 `anthropic/claude-4-opus`） |
| Model | LLM 调用的精确模型 ID |
| Provider | `anthropic`、`openai`、`ollama` 等 |
| Input | 系统提示词 + 用户提示词 |
| Output | 完整的助手回复文本 |
| Token 用量 | `input`、`output`、`inputCached`（缓存读取）、`total` |
| 耗时 | 单次调用的起止时间 |

如果一次 agent 对话涉及多次 LLM 调用（如 tool-use 循环），每次调用都会作为独立的 generation 嵌套在同一个 trace 下。

## 安装

### 方式一：克隆到 extensions 目录

```bash
cd ~/.openclaw/extensions   # 或 {workspaceDir}/.openclaw/extensions
git clone https://github.com/openclaw/openclaw-langfuse-plugin.git openclaw-langfuse-plugin
```

### 方式二：手动复制

```bash
mkdir -p ~/.openclaw/extensions/openclaw-langfuse-plugin
cp index.js openclaw.plugin.json ~/.openclaw/extensions/openclaw-langfuse-plugin/
```

### 方式三：Docker 卷挂载

```bash
# 复制到你的 workspace 卷
tar -czf - openclaw-langfuse-plugin/ | ssh user@your-host \
  'cd /path/to/openclaw/workspace/.openclaw/extensions && tar -xzf -'
```

插件启动时自动从以下路径发现：

```
{workspaceDir}/.openclaw/extensions/openclaw-langfuse-plugin/
```

## 配置

### 环境变量

在 OpenClaw gateway 环境中添加：

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

插件注册了四个 hook：

| Hook | 用途 |
|------|------|
| `before_agent_start` | 捕获用户提示词并创建 trace ID |
| `llm_input` | 在每次 LLM 调用前记录 provider、model、prompt |
| `llm_output` | 与 `llm_input` 配对，将 `generation-create` 发送到 Langfuse（含 token 用量） |
| `agent_end` | 将 `trace-create` 发送到 Langfuse（含整体成功/失败状态） |

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
