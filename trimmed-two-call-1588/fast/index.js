// Experimental entry, to be disclosed as such. Uses OpenClaw's public provider wrapStreamFn hook; no source edits.
//   1. trims what is sent to Kimi (system prompt, tools on the answer call, optionally the history around the results)
//   2. retries a "high traffic" 429 that arrives before any output, at a polite 2-3 s interval
// It never reads or changes usage, time_info, or anything the speed patch measures or shows.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";

const textOf = (content) =>
  typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");

export function trim(payload, opts) {
  const messages = payload.messages ?? [];
  const results = messages.filter((m) => m.role === "tool").map((m) => textOf(m.content).trim());
  const system = results.length ? (opts.systemAnswer ?? opts.system) : opts.system;
  if (system) {
    const at = messages.findIndex((m) => m.role === "system" || m.role === "developer");
    if (at >= 0) messages[at] = { role: messages[at].role, content: system };
  }
  if (!results.length && opts.copyOnly) {
    // one-call entry: the live search results are already between <gifts> tags in the user message
    const found = messages.filter((m) => m.role === "user").map((m) => textOf(m.content))
      .join("\n").match(/<gifts>\s*([\s\S]+?)\s*<\/gifts>/);
    if (found) {
      delete payload.tools;
      delete payload.tool_choice;
      delete payload.parallel_tool_calls;
      payload.messages = [
        { role: "system", content: system ?? "Zero prose." },
        { role: "user", content: opts.ask ? `${found[1]}\n\n${opts.ask}` : found[1] },
      ];
      return;
    }
  }
  if (!results.length) {
    if (opts.requireTool && payload.tools?.length) payload.tool_choice = "required";
    return;
  }
  if (!opts.strip) return;
  delete payload.tools;
  delete payload.tool_choice;
  delete payload.parallel_tool_calls;
  if (opts.strip === "context") {
    const list = results.map((block, i) => `${i + 1}. ${block.replace(/\n/g, "\n   ")}`).join("\n");
    payload.messages = [
      { role: "system", content: system ?? "Zero prose." },
      { role: "user", content: opts.ask ? `${list}\n\n${opts.ask}` : list },
    ];
  }
}

const overloaded = (message) =>
  /high traffic|queue_exceeded|too_many_requests/i.test(message?.errorMessage ?? "");

const pause = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

export function wrap(underlying, opts) {
  return (model, context, options) => {
    const out = createAssistantMessageEventStream();
    const send = {
      ...options,
      async onPayload(payload, payloadModel) {
        const next = (await options?.onPayload?.(payload, payloadModel)) ?? payload;
        trim(next, opts);
        return next;
      },
    };
    (async () => {
      for (let tries = 1; ; tries++) {
        const held = [];
        let live = false;
        let failure = null;
        const source = await underlying(model, context, send);
        for await (const event of source) {
          if (live) out.push(event);
          else if (event.type === "error") failure = event;
          else if (event.type === "start") held.push(event);
          else {
            live = true;
            for (const h of held) out.push(h);
            out.push(event);
          }
        }
        if (live) return out.end(await source.result());
        const retry = failure && overloaded(failure.error) && tries < (opts.tries ?? 30) && !options?.signal?.aborted;
        if (!retry) {
          for (const h of held) out.push(h);
          if (failure) out.push(failure);
          return out.end(failure?.error ?? (await source.result()));
        }
        await pause((opts.retryMs ?? 2000) + Math.random() * 1000, options?.signal);
      }
    })().catch((err) => {
      const error = {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: options?.signal?.aborted ? "aborted" : "error", errorMessage: String(err?.message ?? err),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      out.push({ type: "error", reason: error.stopReason, error });
      out.end(error);
    });
    return out;
  };
}

export default definePluginEntry({
  id: "santa-fast",
  name: "Santa Fast",
  description: "Request trimming and quick overload retries for Cerebras.",
  register(api) {
    const opts = api.pluginConfig ?? {};
    api.registerProvider({
      id: "cerebras",
      label: "Cerebras",
      auth: [],
      wrapStreamFn: (ctx) => (ctx.streamFn ? wrap(ctx.streamFn, opts) : undefined),
    });
  },
});
