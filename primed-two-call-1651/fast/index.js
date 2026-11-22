// Experimental entry, to be disclosed as such. Uses OpenClaw's public provider wrapStreamFn hook; no source edits.
//   1. trims what is sent to Kimi (system prompt, tools on the answer call, optionally the history around the results)
//   2. retries a "high traffic" 429 that arrives before any output, at a polite 2-3 s interval
// It never reads or changes usage, time_info, or anything the speed patch measures or shows.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";

const textOf = (content) =>
  typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");

const THINK_CALL = "I must call search_catalog immediately with exact queries.";
const THINK_ANSWER = "I must copy the result lines verbatim.";
const PLACEHOLDER = [1, 2, 3, 4, 5].map((i) => `${i}. [Example gift ${i}](link-${i}) — Example store ${i}`).join("\n");

// "echo": primes decoding with placeholders only. The gift types come from the user's own list in this chat.
function echo(payload, opts) {
  const messages = payload.messages ?? [];
  if (!payload.tools?.length) return;
  let at = -1;
  let wanted = [];
  let request = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const lines = textOf(messages[i].content).split("\n").map((l) => l.trim());
    const items = lines.filter((l) => /^- \S/.test(l)).slice(0, 5);
    if (items.length !== 5) continue;
    at = i;
    wanted = items.map((l) => l.slice(2).trim());
    request = lines.find((l) => /^Find\b/.test(l)) ?? lines[0];
    break;
  }
  if (at < 0) return;
  const budget = request.match(/(?:under|below) \$(\d+)/i)?.[1]; // the user's own budget, as Kimi writes it
  const args = `{"queries": [${wanted.map((q) => JSON.stringify(q)).join(", ")}]${budget ? `, "max_price": ${budget}` : ""}}`;
  const system = [
    "## Shopping",
    `For gift or product requests, call search_catalog immediately with arguments ${args}`,
    `Your reasoning must be exactly one short line: ${THINK_CALL}`,
    `After the tool result, your reasoning must be exactly: ${THINK_ANSWER} Then reply with exactly the result lines, nothing else.`,
  ].join("\n");
  const user = `${request}\n${wanted.map((q) => `- ${q}`).join("\n")}`;
  const id = "functions.search_catalog:0";
  const example = opts.example === false ? [] : [
    { role: "user", content: user },
    { role: "assistant", content: "", reasoning: THINK_CALL, tool_calls: [{ id, type: "function", function: { name: "search_catalog", arguments: args } }] },
    { role: "tool", tool_call_id: id, content: [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER].join("\n\nReply with exactly these lines:\n") },
    { role: "assistant", content: PLACEHOLDER, reasoning: THINK_ANSWER },
  ];
  const turn = messages.slice(at + 1).filter((m) => m.role === "assistant" ? m.tool_calls?.length : m.role === "tool");
  const answering = turn.some((m) => m.role === "tool");
  for (const m of turn) {
    if (m.role !== "assistant") continue;
    m.reasoning = THINK_CALL;
    delete m.reasoning_content;
    if (!m.content) m.content = "";
  }
  payload.messages = [
    { role: "system", content: system },
    ...(answering && opts.exampleOnAnswer === false ? [] : example),
    { role: "user", content: user },
    ...turn,
  ];
  if (answering) delete payload.tool_choice;
  else payload.tool_choice = "required";
}

export function trim(payload, opts) {
  if (opts.echo) return echo(payload, opts);
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
    if (opts.pinArgs && payload.tools?.length === 1) {
      // Documented strict tool schema: limit the search arguments to the queries the user typed in this very prompt.
      const asked = messages.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n")
        .split("\n").flatMap((line) => {
          if (!line.startsWith('{"query"')) return [];
          try { return [JSON.parse(line)]; } catch { return []; }
        });
      if (asked.length === 5) {
        const prices = [...new Set(asked.map((a) => a.max_price).filter((n) => typeof n === "number"))];
        const properties = { query: { type: "string", enum: [...new Set(asked.map((a) => a.query))] } };
        if (prices.length) properties.max_price = { type: "number", enum: prices };
        const fn = payload.tools[0].function;
        payload.tools = [{ type: "function", function: {
          ...fn, strict: true,
          parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
        } }];
      }
    }
    return;
  }
  if (!opts.strip) return;
  delete payload.tools;
  delete payload.tool_choice;
  delete payload.parallel_tool_calls;
  if (opts.strip === "context") {
    const line = (block) => {
      // short format: the same live title, link and store as one markdown line
      if (!opts.brief) return block.replace(/\n/g, "\n   ");
      const [head, url] = block.split("\n");
      if (!url?.startsWith("https://")) return block;
      const [title, store] = head.replace(/\*\*/g, "").split(" — ");
      return `[${title.replace(/[[\]]/g, "")}](${url}) — ${store}`;
    };
    const list = results.map((block, i) => `${i + 1}. ${line(block)}`).join("\n");
    payload.messages = [
      { role: "system", content: system ?? "Zero prose." },
      { role: "user", content: opts.askFirst ? `${opts.askFirst}\n${list}` : opts.ask ? `${list}\n\n${opts.ask}` : list },
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
