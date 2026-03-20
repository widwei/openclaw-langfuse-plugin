/**
 * openclaw-langfuse-plugin — Full observability for OpenClaw via Langfuse
 *
 * Hooks:
 *   before_agent_start / agent_end     → trace lifecycle
 *   llm_input / llm_output             → per-LLM-call generations
 *   before_tool_call / after_tool_call  → tool call spans
 *   session_start / session_end         → session lifecycle events
 *   before_compaction / after_compaction → compaction events
 *   subagent_spawned / subagent_ended   → sub-agent lifecycle spans
 *   gateway_stop                        → graceful shutdown
 *
 * Uses the official Langfuse SDK for correct trace hierarchy.
 */

import { Langfuse } from "langfuse";

const MAX_TEXT_LEN = 50_000;

function truncate(text, limit = MAX_TEXT_LEN) {
  if (!text) return undefined;
  return text.length > limit ? text.slice(0, limit) : text;
}

function extractThinking(lastAssistant) {
  if (!lastAssistant || !Array.isArray(lastAssistant.content)) return "";
  return lastAssistant.content
    .filter((b) => b?.type === "thinking" && typeof b.thinking === "string")
    .map((b) => b.thinking.trim())
    .filter(Boolean)
    .join("\n");
}

// ── State maps ──

const traces = new Map();
const generations = new Map();
const toolSpans = new Map();
const subagentSpans = new Map();

// ── Key helpers ──

function traceKey(ctx) {
  return ctx.sessionKey ?? "unknown";
}

function genKey(ctx, runId) {
  return `${ctx.sessionKey ?? "unknown"}:${runId ?? "?"}`;
}

function toolCallKey(ctx) {
  return `${ctx.sessionKey ?? "unknown"}:${ctx.toolCallId ?? ctx.toolName ?? "?"}`;
}

// ── Plugin ──

export function register(api) {
  const cfg = api.pluginConfig ?? {};

  const secretKey = (cfg.secretKey ?? process.env.LANGFUSE_SECRET_KEY ?? "").trim();
  const publicKey = (cfg.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY ?? "").trim();
  const baseUrl = (cfg.baseUrl ?? process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com")
    .trim()
    .replace(/\/$/, "");

  if (!secretKey || !publicKey) {
    api.logger.info("[openclaw-langfuse] missing secretKey or publicKey — tracing disabled");
    return;
  }

  const langfuse = new Langfuse({ secretKey, publicKey, baseUrl });
  api.logger.info(`[openclaw-langfuse] Langfuse tracing enabled → ${baseUrl}`);

  // ════════════════════════════════════════════════════════════════════════════
  // 1. Trace: per agent run
  // ════════════════════════════════════════════════════════════════════════════

  api.on("before_agent_start", (event, ctx) => {
    const key = traceKey(ctx);
    const trace = langfuse.trace({
      name: "agent-run",
      sessionId: ctx.sessionId,
      userId: ctx.agentId ?? undefined,
      tags: ["openclaw", ctx.agentId ?? "unknown", ...(ctx.channelId ? [ctx.channelId] : [])],
      metadata: {
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        trigger: ctx.trigger,
        channel: ctx.channelId,
      },
      input: event.prompt,
    });
    traces.set(key, trace);
  });

  api.on("agent_end", async (event, ctx) => {
    const key = traceKey(ctx);
    const trace = traces.get(key);
    if (!trace) return;

    trace.update({
      output: event.messages?.slice(-1)?.[0] ?? undefined,
      metadata: {
        success: event.success,
        error: event.error,
        durationMs: event.durationMs,
        messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
        channelId: ctx.channelId,
        trigger: ctx.trigger,
      },
    });

    traces.delete(key);
    langfuse.flushAsync().catch(() => {});
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. Generation: per LLM call
  // ════════════════════════════════════════════════════════════════════════════

  api.on("llm_input", (event, ctx) => {
    const key = genKey(ctx, event.runId);
    const trace = traces.get(traceKey(ctx));
    if (!trace) return;

    const generation = trace.generation({
      name: "llm-call",
      model: event.model,
      modelParameters: { provider: event.provider },
      input: {
        systemPrompt: event.systemPrompt,
        prompt: event.prompt,
        historyLength: event.historyMessages?.length ?? 0,
        imagesCount: event.imagesCount,
      },
      metadata: {
        runId: event.runId,
        sessionId: event.sessionId,
        provider: event.provider,
      },
    });
    generations.set(key, generation);
  });

  api.on("llm_output", (event, ctx) => {
    const key = genKey(ctx, event.runId);
    const gen = generations.get(key);
    if (!gen) return;

    const thinkingText = extractThinking(event.lastAssistant);

    const usage = event.usage
      ? {
          input: event.usage.input,
          output: event.usage.output,
          total: event.usage.total,
        }
      : undefined;

    const metadata = {
      cacheRead: event.usage?.cacheRead,
      cacheWrite: event.usage?.cacheWrite,
      provider: event.provider,
    };
    if (thinkingText) {
      metadata.thinking = truncate(thinkingText);
    }

    gen.end({
      output: event.lastAssistant ?? event.assistantTexts?.join("\n") ?? "",
      usage,
      metadata,
    });
    generations.delete(key);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. Span: per tool call
  // ════════════════════════════════════════════════════════════════════════════

  api.on("before_tool_call", (event, ctx) => {
    const trace = traces.get(traceKey(ctx));
    if (!trace) return;

    const span = trace.span({
      name: `tool:${event.toolName}`,
      input: event.params,
      metadata: {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        runId: event.runId,
      },
    });
    toolSpans.set(toolCallKey(ctx), span);
  });

  api.on("after_tool_call", (event, ctx) => {
    const key = toolCallKey(ctx);
    const span = toolSpans.get(key);
    if (!span) return;

    span.end({
      output: event.error ? { error: event.error } : event.result ?? undefined,
      level: event.error ? "ERROR" : "DEFAULT",
      statusMessage: event.error ?? undefined,
      metadata: {
        error: event.error,
        durationMs: event.durationMs,
      },
    });
    toolSpans.delete(key);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. Session lifecycle events
  // ════════════════════════════════════════════════════════════════════════════

  api.on("session_start", (event, ctx) => {
    const trace = traces.get(traceKey(ctx));
    if (!trace) return;

    trace.event({
      name: "session_start",
      metadata: {
        sessionId: event.sessionId,
        sessionKey: event.sessionKey,
        resumedFrom: event.resumedFrom,
      },
    });
  });

  api.on("session_end", (event, ctx) => {
    const trace = traces.get(traceKey(ctx));
    if (!trace) return;

    trace.event({
      name: "session_end",
      metadata: {
        sessionId: event.sessionId,
        sessionKey: event.sessionKey,
        messageCount: event.messageCount,
        durationMs: event.durationMs,
      },
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 5. Compaction events
  // ════════════════════════════════════════════════════════════════════════════

  api.on("before_compaction", (event, ctx) => {
    const trace = traces.get(traceKey(ctx));
    if (!trace) return;

    trace.event({
      name: "compaction_start",
      metadata: {
        messageCount: event.messageCount,
        compactingCount: event.compactingCount,
        tokenCount: event.tokenCount,
      },
    });
  });

  api.on("after_compaction", (event, ctx) => {
    const trace = traces.get(traceKey(ctx));
    if (!trace) return;

    trace.event({
      name: "compaction_end",
      metadata: {
        messageCount: event.messageCount,
        compactedCount: event.compactedCount,
        tokenCount: event.tokenCount,
      },
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 6. Sub-agent spans
  // ════════════════════════════════════════════════════════════════════════════

  api.on("subagent_spawned", (event, ctx) => {
    const trace = traces.get(traceKey({ sessionKey: ctx.requesterSessionKey }));
    if (!trace) return;

    const span = trace.span({
      name: `subagent:${event.agentId}`,
      input: { label: event.label, mode: event.mode },
      metadata: {
        childSessionKey: event.childSessionKey,
        runId: event.runId,
        agentId: event.agentId,
      },
    });
    subagentSpans.set(event.childSessionKey, span);
  });

  api.on("subagent_ended", (event, ctx) => {
    const span = subagentSpans.get(event.targetSessionKey);
    if (!span) return;

    const isError = event.outcome === "error" || event.outcome === "timeout" || event.outcome === "killed";
    span.end({
      level: isError ? "ERROR" : "DEFAULT",
      statusMessage: event.error ?? undefined,
      metadata: {
        reason: event.reason,
        outcome: event.outcome,
        error: event.error,
      },
    });
    subagentSpans.delete(event.targetSessionKey);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Cleanup on gateway stop
  // ════════════════════════════════════════════════════════════════════════════

  api.on("gateway_stop", async () => {
    try {
      await langfuse.shutdownAsync();
    } catch {
      // best-effort
    }
    traces.clear();
    generations.clear();
    toolSpans.clear();
    subagentSpans.clear();
  });

  api.logger.info("[openclaw-langfuse] plugin registered");
}
