// Optimized entry, to be disclosed as such: the plugin searches Shopify's public Global Catalog live for the gift
// types in the user's message, then Kimi writes the list in one model call. No store list, products or product URLs
// are built in, and nothing here touches timing, usage or the speed patch.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const CATALOG = "https://catalog.shopify.com/api/ucp/mcp";
const AGENT_PROFILE = "https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json";
const NO_RESULTS = "The live catalog search returned no results.";

export function parseRequest(text) {
  const types = [...text.matchAll(/^\s*-\s+(.+?)\s*$/gm)].map((m) => m[1]).slice(0, 5);
  const budget = Number(text.match(/(?:under|below|budget(?: of)?)\s*\$(\d+)/i)?.[1] ?? Infinity);
  return { types, budget };
}

const plain = (s) =>
  String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[<>*_`[\]#]/g, "")
    .replace(/\s+/g, " ")
    .replace(/ ([.,;:!])(?= |$)/g, "$1")
    .trim();

// whole sentences of the store's own description, up to `max` characters
function excerpt(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "));
  return end > 0 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(" "));
}

async function searchOne(query, budget) {
  const request = () => fetch(CATALOG, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    signal: AbortSignal.timeout(11000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_catalog", arguments: {
      meta: { "ucp-agent": { profile: AGENT_PROFILE } },
      catalog: {
        query,
        context: { address_country: "US", currency: "USD" },
        filters: { ships_to: { country: "US" }, available: true },
        pagination: { limit: 10 },
      },
    } } }),
  });
  let res = await request();
  // the catalog allows a few searches per second per IP: wait as long as its Retry-After says
  for (let i = 0; i < 3 && res.status === 429; i++) {
    await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") || 1) * 1000 + Math.random() * 700));
    res = await request();
  }
  if (!res.ok) return [];
  const products = (await res.json())?.result?.structuredContent?.products ?? [];
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2).map((w) => w.replace(/s$/, ""));
  return products.flatMap((p) => {
    const v = p.variants?.[0];
    if (!v?.url?.startsWith("https://") || v.availability?.available !== true || v.price?.currency !== "USD") return [];
    const price = v.price.amount / 100;
    const title = plain(p.title);
    if (!(price > 0 && price <= budget)) return [];
    if (words.filter((w) => title.toLowerCase().includes(w)).length * 2 < words.length) return [];
    const url = new URL(v.url);
    return [{ title, price, store: plain(v.seller?.name), url: url.origin + url.pathname + (url.searchParams.get("variant") ? `?variant=${url.searchParams.get("variant")}` : ""), about: plain(p.description?.plain ?? p.description?.html) }];
  });
}

export async function shop({ types, budget }, detail) {
  if (types.length !== 5) return null;
  const found = await Promise.all(types.map((t) => searchOne(t, budget).catch(() => [])));
  const used = new Set(), picks = [];
  for (const options of found) {
    const pick = options.find((o) => !used.has(o.url));
    if (!pick) return null; // fail honestly rather than fill a gap
    used.add(pick.url);
    picks.push(pick);
  }
  return picks.map((g, i) => [
    `${i + 1}. **${g.title}** — ${g.store} — $${g.price.toFixed(2)}`,
    `   ${g.url}`,
    ...(detail > 0 && g.about ? [`   ${excerpt(g.about, detail)}`] : []),
  ].join("\n")).join("\n");
}

export default definePluginEntry({
  id: "santa-turbo",
  name: "Santa Turbo",
  description: "Live catalog search, then one Kimi call.",
  register(api) {
    const { detail = 300, system = "Repeat the gift list exactly.", tail = "", head = "", foot = "", place = "user" } = api.pluginConfig ?? {};
    const byRun = new Map();
    api.on("before_prompt_build", async (event, ctx) => {
      const id = ctx?.runId ?? "none";
      let list;
      if (byRun.has(id)) list = await byRun.get(id); // same run retrying after a 429
      else {
        const request = parseRequest(event.prompt ?? "");
        const pending = shop(request, detail).catch(() => null);
        if (byRun.size > 64) byRun.clear();
        byRun.set(id, pending);
        list = await pending;
      }
      // no wrapper tags: a copied tag turns the whole answer into an HTML block, so links stop rendering
      const context = list ? `${list}${tail ? `\n\n${tail}` : ""}` : NO_RESULTS;
      // blank lines around head/foot keep the markdown list rendering even if Kimi copies them
      const block = [head, context, foot].filter(Boolean).join("\n\n");
      return place === "system"
        ? { toolsAllow: [], systemPrompt: `${system}\n\n${block}` }
        : { toolsAllow: [], systemPrompt: system, appendContext: block };
    }, { timeoutMs: 16000 });
  },
});
