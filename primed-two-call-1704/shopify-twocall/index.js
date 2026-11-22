// Live keyless product search backed by Shopify's public Global Catalog MCP.
// No store list, no hard-coded URLs, no preset products, no cache, no OpenClaw patches.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const CATALOG = "https://catalog.shopify.com/api/ucp/mcp";
const AGENT_PROFILE =
  "https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json";

const plain = (s) =>
  String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[<>*_`[\]#]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function excerpt(text, max) {
  if (!text || max <= 0) return "";
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const matches = [...cut.matchAll(/[a-z0-9]{2,}[.!]\s/gi)];
  const last = matches.at(-1);
  if (last && last.index > 40) return cut.slice(0, last.index + last[0].length - 1).trim();
  const space = cut.lastIndexOf(" ");
  return space > 40 ? cut.slice(0, space).trim() : cut.trim();
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "who",
  "not", "all", "are", "can", "its", "into", "over", "under",
]);

export async function searchCatalogOne(
  query,
  { maxPrice = 200, country = "US", currency = "USD" } = {},
  signal,
) {
  const timeoutSignal = AbortSignal.timeout(11000);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const request = () => fetch(CATALOG, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    signal: combined,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search_catalog",
        arguments: {
          meta: { "ucp-agent": { profile: AGENT_PROFILE } },
          catalog: {
            query,
            context: { address_country: country, currency },
            filters: { ships_to: { country }, available: true },
            pagination: { limit: 10 },
          },
        },
      },
    }),
  });
  let res = await request();
  // the catalog allows a few searches per second per IP: wait as long as its Retry-After says
  for (let i = 0; i < 3 && res.status === 429; i++) {
    await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") || 1) * 1000 + Math.random() * 700));
    res = await request();
  }
  if (!res.ok) return null;
  const data = await res.json();
  const products = data?.result?.structuredContent?.products ?? [];
  const head = query.split(/[,.;:|—-]/)[0].trim();
  const words = head
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map((w) => w.replace(/s$/, ""));
  for (const p of products) {
    const v = p.variants?.[0];
    if (
      !v?.url?.startsWith("https://") ||
      v.availability?.available !== true ||
      v.price?.currency !== currency
    ) {
      continue;
    }
    const price = v.price.amount / 100;
    if (!(price > 0 && price <= maxPrice)) continue;
    const title = plain(p.title);
    if (!title || title.length > 90) continue;
    if (
      words.length > 0 &&
      words.filter((w) => title.toLowerCase().includes(w)).length * 2 < words.length
    ) {
      continue;
    }
    const u = new URL(v.url);
    if (/last-?call|clearance|final-?sale|discontinued/i.test(u.pathname)) continue; // end-of-line listings often show as out of stock on the store page
    const variant = u.searchParams.get("variant");
    const url = u.origin + u.pathname + (variant ? `?variant=${variant}` : "");
    return {
      title,
      store: plain(v.seller?.name),
      price,
      currency,
      url,
      description: plain(p.description?.plain ?? p.description?.html),
    };
  }
  return null;
}

const asLines = (hits) => hits.map((h, i) => `${i + 1}. [${h.title.replace(/[[\]]/g, "")}](${h.url}) — ${h.store}`).join("\n");

export default definePluginEntry({
  id: "shopify-catalog-search",
  name: "Shopify Global Catalog Search",
  description: "Live keyless product search tool backed by Shopify's public Global Catalog MCP.",
  register(api) {
    const copies = Math.min(4, Math.max(1, Number(api.pluginConfig?.detail ?? 3)));
    api.registerTool({
      name: "search_catalog",
      label: "Search Shopify Catalog",
      description:
        "Live search of US Shopify stores. Call once with the gift list. Returns numbered lines N. [name](url) — store. Reply with exactly those lines, copied verbatim, nothing else.",
      parameters: {
        type: "object",
        required: ["queries"],
        properties: { queries: { type: "array", items: { type: "string" } }, max_price: { type: "number" } },
      },
      async execute(_toolCallId, params, signal) {
        const queries = (Array.isArray(params?.queries) ? params.queries : []).map((q) => String(q).trim()).filter(Boolean).slice(0, 5);
        const maxPrice = Number.isFinite(Number(params?.max_price)) ? Number(params.max_price) : 100;
        const found = await Promise.all(queries.map((q) => searchCatalogOne(q, { maxPrice }, signal).catch(() => null)));
        if (found.length !== 5 || found.some((h) => !h) || new Set(found.map((h) => h.url)).size !== 5) {
          return { content: [{ type: "text", text: "The live search did not return five different in-stock products." }] };
        }
        // the live lines, repeated: text Kimi has already read decodes faster when it copies it
        const text = Array(copies).fill(asLines(found)).join("\n\nReply with exactly these lines:\n");
        return { content: [{ type: "text", text }], details: { items: found } };
      },
    });
  },
});
