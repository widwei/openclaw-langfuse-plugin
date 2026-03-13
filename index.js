/**
 * openclaw-langfuse — OpenClaw plugin for Langfuse LLM observability
 * https://github.com/openclaw/openclaw-langfuse-plugin
 *
 * Sends structured traces and per-LLM-call generations to Langfuse using
 * the llm_input / llm_output hooks for accurate model, provider, and token
 * tracking. Falls back to before_agent_start / agent_end for the trace
 * envelope.
 *
 * Zero npm dependencies — uses the Langfuse REST ingestion API via native fetch.
 *
 * Configuration (env vars or plugin config):
 *   LANGFUSE_PUBLIC_KEY  — project public key  (pk-lf-...)
 *   LANGFUSE_SECRET_KEY  — project secret key  (sk-lf-...)
 *   LANGFUSE_BASE_URL    — server URL (default: https://cloud.langfuse.com)
 */

const MAX_TEXT_LEN = 50_000;

/** @param {string | undefined} text */
function truncate(text, limit = MAX_TEXT_LEN) {
  if (!text) return undefined;
  return text.length > limit ? text.slice(0, limit) : text;
}

/** @param {unknown} content */
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

/** @param {{ sessionKey?: string; agentId?: string }} ctx */
function resolveKey(ctx) {
  return ctx.sessionKey ?? ctx.agentId ?? "default";
}

/** @param {import("openclaw").OpenClawPluginApi} api */
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

  // Per-session trace state: keyed by sessionKey (or agentId fallback).
  /** @type {Map<string, { traceId: string; startedAt: number; prompt: string }>} */
  const pendingTraces = new Map();

  // Per-runId LLM call state: captures provider/model from llm_input → llm_output.
  /** @type {Map<string, { generationId: string; provider: string; model: string; startedAt: number; prompt: string; systemPrompt?: string }>} */
  const pendingLlmCalls = new Map();

  // ── before_agent_start: capture prompt + start time for the trace envelope ──
  api.on("before_agent_start", (event, ctx) => {
    const key = resolveKey(ctx);
    pendingTraces.set(key, {
      traceId: crypto.randomUUID(),
      startedAt: Date.now(),
      prompt: event.prompt ?? "",
    });
  });

  // ── llm_input: capture provider, model, prompt before each LLM call ──
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

  // ── llm_output: pair with llm_input, send generation to Langfuse ──
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

    const usage = {};
    if (event.usage) {
      if (typeof event.usage.input === "number") usage.input = event.usage.input;
      if (typeof event.usage.output === "number") usage.output = event.usage.output;
      if (typeof event.usage.cacheRead === "number") usage.inputCached = event.usage.cacheRead;
      if (typeof event.usage.total === "number") usage.total = event.usage.total;
      usage.unit = "TOKENS";
    }

    const inputText = call.systemPrompt
      ? `[system] ${call.systemPrompt}\n\n${call.prompt}`
      : call.prompt;

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
          output: truncate(outputText),
          usage: Object.keys(usage).length > 1 ? usage : undefined,
          level: "DEFAULT",
          metadata: {
            provider: call.provider,
            agentId: ctx.agentId,
            sessionKey: ctx.sessionKey,
          },
        },
      },
    ]);
  });

  // ── agent_end: finalize the trace with overall success/error status ──
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

  // ── Langfuse ingestion helper ──
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
