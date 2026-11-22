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
  const timeoutSignal = AbortSignal.timeout(7000);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const res = await fetch(CATALOG, {
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

export default definePluginEntry({
  id: "shopify-catalog-search",
  name: "Shopify Global Catalog Search",
  description: "Live keyless product search tool backed by Shopify's public Global Catalog MCP.",
  register(api) {
    const detail = Number(api.pluginConfig?.detail ?? 0);
    api.registerTool({
      name: "search_catalog",
      label: "Search Shopify Catalog",
      description:
        "Search Shopify's live Global Catalog for one available in-stock US product matching query and max_price.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Product search query" },
          max_price: { type: "number", description: "Maximum price in USD" },
        },
        required: ["query"],
      },
      async execute(_toolCallId, params, signal) {
        const query = String(params?.query ?? "").trim();
        const maxPrice = Number.isFinite(Number(params?.max_price))
          ? Number(params.max_price)
          : 200;
        if (!query) {
          return { content: [{ type: "text", text: "No query provided." }] };
        }
        const hit = await searchCatalogOne(query, { maxPrice }, signal);
        if (!hit) {
          return { content: [{ type: "text", text: `No in-stock USD product found for "${query}".` }] };
        }
        const desc = excerpt(hit.description, detail);
        const lines = [
          `**${hit.title}** — ${hit.store} — $${hit.price.toFixed(2)}`,
          hit.url,
          ...(desc ? [desc] : []),
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: hit,
        };
      },
    });
  },
});
