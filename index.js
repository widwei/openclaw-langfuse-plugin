/**
 * openclaw-langfuse-plugin — Full observability for OpenClaw via Langfuse
 * https://github.com/widwei/openclaw-langfuse-plugin
 *
 * Hooks:
 *   before_agent_start / agent_end     → trace lifecycle
 *   llm_input / llm_output             → per-LLM-call generations
 *   before_tool_call / after_tool_call  → tool call spans
 *   session_start / session_end         → session lifecycle events
 *   before_compaction / after_compaction → compaction events
 *   subagent_spawned / subagent_ended   → sub-agent lifecycle spans
 *
 * Zero npm dependencies — uses the Langfuse REST ingestion API via native fetch.
 *
 * Configuration (env vars or plugin config):
 *   LANGFUSE_PUBLIC_KEY  — project public key  (pk-lf-...)
 *   LANGFUSE_SECRET_KEY  — project secret key  (sk-lf-...)
 *   LANGFUSE_BASE_URL    — server URL (default: https://cloud.langfuse.com)
 */

const MAX_TEXT_LEN = 50_000;

function truncate(text, limit = MAX_TEXT_LEN) {
  if (!text) return undefined;
  return text.length > limit ? text.slice(0, limit) : text;
}

function extractText(content, maxLen = MAX_TEXT_LEN) {
  if (typeof content === "string") return content.slice(0, maxLen);
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .slice(0, maxLen);
  }
  return "";
}

function extractThinking(lastAssistant) {
  if (!lastAssistant || !Array.isArray(lastAssistant.content)) return "";
  return lastAssistant.content
    .filter((b) => b?.type === "thinking" && typeof b.thinking === "string")
    .map((b) => b.thinking.trim())
    .filter(Boolean)
    .join("\n");
}

function resolveKey(ctx) {
  return ctx.sessionKey ?? ctx.agentId ?? "default";
}

function safeStringify(value, maxLen = 2000) {
  if (value === undefined || value === null) return undefined;
  try {
    const str = typeof value === "string" ? value : JSON.stringify(value);
    return str.length > maxLen ? str.slice(0, maxLen) + "…" : str;
  } catch {
    return String(value).slice(0, maxLen);
  }
}

export function register(api) {
  const pluginCfg = api.pluginConfig ?? {};

  const publicKey = (pluginCfg.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY ?? "").trim();
  const secretKey = (pluginCfg.secretKey ?? process.env.LANGFUSE_SECRET_KEY ?? "").trim();
  const baseUrl = (pluginCfg.baseUrl ?? process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com")
    .trim()
    .replace(/\/$/, "");

  if (!publicKey || !secretKey) {
    api.logger.info("[openclaw-langfuse] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set — tracing disabled");
    return;
  }

  const authHeader = "Basic " + Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  api.logger.info(`[openclaw-langfuse] Langfuse tracing enabled → ${baseUrl}`);

  // ── State maps ──

  /** @type {Map<string, { traceId: string; startedAt: number; prompt: string }>} */
  const pendingTraces = new Map();

  /** @type {Map<string, { generationId: string; provider: string; model: string; startedAt: number; prompt: string; systemPrompt?: string }>} */
  const pendingLlmCalls = new Map();

  /** @type {Map<string, { spanId: string; startedAt: number }>} */
  const pendingToolCalls = new Map();

  /** @type {Map<string, { spanId: string; startedAt: number; childSessionKey: string; agentId: string; label?: string }>} */
  const pendingSubagents = new Map();

  // ════════════════════════════════════════════════════════════════════════════
  // 1. Trace lifecycle: before_agent_start → agent_end
  // ════════════════════════════════════════════════════════════════════════════

  api.on("before_agent_start", (event, ctx) => {
    const key = resolveKey(ctx);
    pendingTraces.set(key, {
      traceId: crypto.randomUUID(),
      startedAt: Date.now(),
      prompt: event.prompt ?? "",
    });
  });

  api.on("agent_end", async (event, ctx) => {
    const key = resolveKey(ctx);
    const trace = pendingTraces.get(key);
    pendingTraces.delete(key);

    const traceId = trace?.traceId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const startTime = trace ? new Date(trace.startedAt).toISOString() : now;

    let output = "";
    if (Array.isArray(event.messages)) {
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const msg = event.messages[i];
        if (msg?.role === "assistant") {
          output = extractText(msg.content);
          break;
        }
      }
    }

    await sendBatch([
      {
        id: crypto.randomUUID(),
        type: "trace-create",
        timestamp: now,
        body: {
          id: traceId,
          name: "openclaw-turn",
          sessionId: ctx.sessionKey ?? undefined,
          userId: ctx.agentId ?? "unknown",
          tags: ["openclaw", ctx.agentId ?? "unknown", ...(ctx.channelId ? [ctx.channelId] : [])],
          input: truncate(trace?.prompt),
          output: truncate(output),
          metadata: {
            success: event.success,
            error: event.error ?? undefined,
            durationMs: event.durationMs,
            messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
            channelId: ctx.channelId,
            trigger: ctx.trigger,
          },
          timestamp: startTime,
        },
      },
    ]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. LLM calls: llm_input → llm_output (generation-create)
  // ════════════════════════════════════════════════════════════════════════════

  api.on("llm_input", (event) => {
    pendingLlmCalls.set(event.runId, {
      generationId: crypto.randomUUID(),
      provider: event.provider,
      model: event.model,
      startedAt: Date.now(),
      prompt: event.prompt,
      systemPrompt: event.systemPrompt,
    });
  });

  api.on("llm_output", async (event, ctx) => {
    const call = pendingLlmCalls.get(event.runId);
    pendingLlmCalls.delete(event.runId);
    if (!call) return;

    const key = resolveKey(ctx);
    const trace = pendingTraces.get(key);
    const traceId = trace?.traceId ?? crypto.randomUUID();

    const now = new Date().toISOString();
    const startTime = new Date(call.startedAt).toISOString();
    const outputText = event.assistantTexts?.join("\n") ?? "";
    const thinkingText = extractThinking(event.lastAssistant);

    const usage = {};
    if (event.usage) {
      if (typeof event.usage.input === "number") usage.input = event.usage.input;
      if (typeof event.usage.output === "number") usage.output = event.usage.output;
      if (typeof event.usage.cacheRead === "number") usage.inputCached = event.usage.cacheRead;
      if (typeof event.usage.cacheWrite === "number") usage.inputCacheWrite = event.usage.cacheWrite;
      if (typeof event.usage.total === "number") usage.total = event.usage.total;
      usage.unit = "TOKENS";
    }

    const inputText = call.systemPrompt
      ? `[system] ${call.systemPrompt}\n\n${call.prompt}`
      : call.prompt;

    const output = event.lastAssistant ?? truncate(outputText);

    const metadata = {
      provider: call.provider,
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
    };
    if (thinkingText) {
      metadata.thinking = truncate(thinkingText);
    }

    await sendBatch([
      {
        id: crypto.randomUUID(),
        type: "generation-create",
        timestamp: now,
        body: {
          id: call.generationId,
          traceId,
          name: `${call.provider}/${call.model}`,
          model: call.model,
          modelParameters: { provider: call.provider },
          startTime,
          endTime: now,
          input: truncate(inputText),
          output,
          usage: Object.keys(usage).length > 1 ? usage : undefined,
          level: "DEFAULT",
          metadata,
        },
      },
    ]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. Tool calls: before_tool_call → after_tool_call (span-create)
  // ════════════════════════════════════════════════════════════════════════════

  api.on("before_tool_call", (event, ctx) => {
    const spanKey = `${ctx.runId ?? ""}:${ctx.toolCallId ?? crypto.randomUUID()}`;
    pendingToolCalls.set(spanKey, {
      spanId: crypto.randomUUID(),
      startedAt: Date.now(),
    });
  });

  api.on("after_tool_call", async (event, ctx) => {
    const spanKey = `${ctx.runId ?? ""}:${ctx.toolCallId ?? ""}`;
    const pending = pendingToolCalls.get(spanKey);
    pendingToolCalls.delete(spanKey);

    const traceKey = resolveKey(ctx);
    const trace = pendingTraces.get(traceKey);
    const traceId = trace?.traceId ?? crypto.randomUUID();
    const spanId = pending?.spanId ?? crypto.randomUUID();

    const now = new Date().toISOString();
    const startTime = pending ? new Date(pending.startedAt).toISOString() : now;

    await sendBatch([
      {
        id: crypto.randomUUID(),
        type: "span-create",
        timestamp: now,
        body: {
          id: spanId,
          traceId,
          name: `tool: ${event.toolName}`,
          startTime,
          endTime: now,
          input: safeStringify(event.params),
          output: event.error ? safeStringify(event.error) : safeStringify(event.result),
          level: event.error ? "ERROR" : "DEFAULT",
          statusMessage: event.error ?? undefined,
          metadata: {
            toolName: event.toolName,
            durationMs: event.durationMs,
            agentId: ctx.agentId,
            runId: ctx.runId,
          },
        },
      },
    ]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. Session lifecycle: session_start / session_end (event-create)
  // ════════════════════════════════════════════════════════════════════════════

  api.on("session_start", async (event, ctx) => {
    const traceKey = ctx.sessionKey ?? ctx.agentId ?? "default";
    const trace = pendingTraces.get(traceKey);
    const traceId = trace?.traceId ?? crypto.randomUUID();

    await sendBatch([
      {
        id: crypto.randomUUID(),
        type: "event-create",
        timestamp: new Date().toISOString(),
        body: {
          id: crypto.randomUUID(),
          traceId,
          name: "session_start",
          startTime: new Date().toISOString(),
          metadata: {
            sessionId: event.sessionId,
            sessionKey: event.sessionKey,
            resumedFrom: event.resumedFrom ?? undefined,
            agentId: ctx.agentId,
          },
        },
      },
    ]);
  });

  api.on("session_end", async (event, ctx) => {
    const traceKey = ctx.sessionKey ?? ctx.agentId ?? "default";
    const trace = pendingTraces.get(traceKey);
    const traceId = trace?.traceId ?? crypto.randomUUID();

    await sendBatch([
      {
        id: crypto.randomUUID(),
        type: "event-create",
        timestamp: new Date().toISOString(),
        body: {
          id: crypto.randomUUID(),
          traceId,
          name: "session_end",
          startTime: new Date().toISOString(),
          metadata: {
            sessionId: event.sessionId,
            sessionKey: event.sessionKey,
            messageCount: event.messageCount,
            durationMs: event.durationMs,
            agentId: ctx.agentId,
          },
        },
      },
    ]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 5. Compaction: before_compaction / after_compaction (event-create)
  // ════════════════════════════════════════════════════════════════════════════

  api.on("before_compaction", async (event, ctx) => {
    const traceKey = resolveKey(ctx);
    const trace = pendingTraces.get(traceKey);
    const traceId = trace?.traceId ?? crypto.randomUUID();

    await sendBatch([
      {
        id: crypto.randomUUID(),
        type: "event-create",
        timestamp: new Date().toISOString(),
        body: {
          id: crypto.randomUUID(),
          traceId,
          name: "compaction_start",
          startTime: new Date().toISOString(),
          metadata: {
            messageCount: event.messageCount,
            compactingCount: event.compactingCount,
            tokenCount: event.tokenCount,
            agentId: ctx.agentId,
          },
        },
      },
    ]);
  });

  api.on("after_compaction", async (event, ctx) => {
    const traceKey = resolveKey(ctx);
    const trace = pendingTraces.get(traceKey);
    const traceId = trace?.traceId ?? crypto.randomUUID();

    await sendBatch([
      {
        id: crypto.randomUUID(),
        type: "event-create",
        timestamp: new Date().toISOString(),
        body: {
          id: crypto.randomUUID(),
          traceId,
          name: "compaction_end",
          startTime: new Date().toISOString(),
          metadata: {
            messageCount: event.messageCount,
            compactedCount: event.compactedCount,
            tokenCount: event.tokenCount,
            agentId: ctx.agentId,
          },
        },
      },
    ]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 6. Sub-agents: subagent_spawned / subagent_ended (span-create)
  // ════════════════════════════════════════════════════════════════════════════

  api.on("subagent_spawned", (event, ctx) => {
    pendingSubagents.set(event.childSessionKey, {
      spanId: crypto.randomUUID(),
      startedAt: Date.now(),
      childSessionKey: event.childSessionKey,
      agentId: event.agentId,
      label: event.label,
    });
  });

  api.on("subagent_ended", async (event, ctx) => {
    const pending = pendingSubagents.get(event.targetSessionKey);
    pendingSubagents.delete(event.targetSessionKey);

    const traceKey = ctx.requesterSessionKey ?? "default";
    const trace = pendingTraces.get(traceKey);
    const traceId = trace?.traceId ?? crypto.randomUUID();
    const spanId = pending?.spanId ?? crypto.randomUUID();

    const now = new Date().toISOString();
    const startTime = pending ? new Date(pending.startedAt).toISOString() : now;
    const isError = event.outcome === "error" || event.outcome === "timeout" || event.outcome === "killed";

    await sendBatch([
      {
        id: crypto.randomUUID(),
        type: "span-create",
        timestamp: now,
        body: {
          id: spanId,
          traceId,
          name: `subagent: ${pending?.label || pending?.agentId || event.targetSessionKey}`,
          startTime,
          endTime: event.endedAt ? new Date(event.endedAt).toISOString() : now,
          level: isError ? "ERROR" : "DEFAULT",
          statusMessage: event.error ?? undefined,
          metadata: {
            targetSessionKey: event.targetSessionKey,
            targetKind: event.targetKind,
            reason: event.reason,
            outcome: event.outcome,
            runId: event.runId,
            agentId: pending?.agentId,
            label: pending?.label,
          },
        },
      },
    ]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Langfuse ingestion helper
  // ════════════════════════════════════════════════════════════════════════════

  async function sendBatch(batch) {
    try {
      const res = await fetch(`${baseUrl}/api/public/ingestion`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ batch }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        api.logger.warn(`[openclaw-langfuse] ingestion failed ${res.status}: ${text.slice(0, 300)}`);
      }
    } catch (err) {
      api.logger.warn(`[openclaw-langfuse] fetch error: ${String(err)}`);
    }
  }
}
