# Santa's Speedy Shopper: Speed Bounty entries

**Project Name:** Santa's Speedy Shopper
**Team Members:** Solo: BrightyBrainiac (X: [@clasher11102](https://x.com/clasher11102), Discord: @quirkyquests)

Santa's Speedy Shopper is four honest answers to one question: how fast can Kimi find five real Christmas gifts? It starts with prompt and config only, then adds one thing at a time (a search tool, a lighter second call, a single call), so it's clear what each step buys. The thing that mattered most was giving the model less to think about.

Kimi K3.1 Pro on Cerebras, OpenClaw `8b18b55` + the official [speed patch](https://github.com/wkasekende/openclaw-speed-patch). No OpenClaw source edits. Numbers are the patch's server-timed session readout.

| Setup | Mean TPS | Max (p90) | Calls | How | Evidence |
|---|--:|--:|--:|---|---|
| [`main-1365`](main-1365) | 1,365 | 1,403 | 1,327 / 1,403 | Prompt and config only, built-in web_search, no custom plugin | [post](https://discord.com/channels/1085960591052644463/1574062058117529641) · [demo under 60 s](https://discord.com/channels/1085960591052644463/1574062058117529641/1574112577913622568) |
| [`trimmed-two-call-1588`](trimmed-two-call-1588) | 1,588 | 1,610 | 1,610 / 1,566 | Kimi calls the search; a disclosed plugin trims context on call 2 | [post](https://discord.com/channels/1085960591052644463/1574092434693165086) · [demo under 60 s](https://discord.com/channels/1085960591052644463/1574092434693165086/1574112836802715831) |
| [`two-call-1371`](two-call-1371) | 1,371 | 1,392 | 1,350 / 1,392 | Kimi calls a live catalog search tool from a small plugin | [post](https://discord.com/channels/1085960591052644463/1574062795195023450) · [demo under 60 s](https://discord.com/channels/1085960591052644463/1574062795195023450/1574113005338230884) |
| [`turbo-one-call-1501`](turbo-one-call-1501) | 1,501 | 1,501 | 1,501 | Experimental: plugins search first and send Kimi only the results | [post](https://discord.com/channels/1085960591052644463/1574070586592993410) · [demo under 60 s](https://discord.com/channels/1085960591052644463/1574070586592993410/1574113168433745930) |

No prompt, config or plugin contains a product URL, store domain or preset result. The plugin entries call Shopify's public Global Catalog endpoint live.

An earlier prototype, [`santa-speedy-shopper`](https://github.com/Arshgill01/santa-speedy-shopper), used a list of storefronts. None of these four entries uses that code or list.

## Reproduce

1. Check out OpenClaw `8b18b55`, apply the official speed patch, then install and build (Node 24.22.1+).
2. Use a fresh profile and start the gateway **from inside the setup folder**, because plugin paths are relative to it:

```sh
cd trimmed-two-call-1588            # or any folder above
export CEREBRAS_API_KEY=...         # your key
export OC=/path/to/openclaw         # the patched checkout
P=$HOME/.openclaw-santa-review      # must be a fresh profile
mkdir -p $P && cp openclaw.json $P/ && cp -R workspace $P/
node $OC/openclaw.mjs --profile santa-review gateway run --port 18789 --bind loopback --auth none --allow-unconfigured
```

3. Open http://127.0.0.1:18789, start a new chat, paste `prompt.txt` as one message, and read the readout beside the message box.

Speeds vary a lot with Cerebras load. Each filmed run is the best of many attempts. The counts are below.

## What each entry does beyond the defaults

### main-1365

Prompt and config only. The prompt names the five gifts and brands, gives five detailed queries and gives the answer's layout with those names, so Kimi only fills in each link from the live results.

Best of 313 attempts across clean web-search setups up to this run (36 completed, median 916). The composer's session readout shows the settled 1,365. The small badge under the message shows 1,339 because it counts call 1 once per search card (five times).

### trimmed-two-call-1588

This goes beyond prompt and config.
- Kimi makes five parallel search_catalog calls itself, backed live by Shopify's Global Catalog. The prompt gives the five detailed queries as exact arguments.
- A plugin on the standard provider hook shortens the system prompt and requires the tool on call 1. On call 2 it drops the tools and earlier context and sends only the five live results (with store descriptions), "Zero prose." and "Repeat the list above in full."
- It retries 429s every 2-3 s before output starts.
- No store list, preset products, product URLs or cache. Timing and usage are untouched.
- Best of 112 attempts with this setup up to this run (25 completed, median 1,160).

### two-call-1371

- Beyond prompt and config: a small plugin gives Kimi a search_catalog tool backed live by Shopify's Global Catalog. No store list, preset products, product URLs or cache. Kimi makes the five searches itself.
- The prompt gives five detailed search queries as exact arguments.
- Best of 253 attempts up to this run: 27 completed (median 910). The rest hit 429s or were restarted.
- The badge shows partial numbers during the run; the settled mean is 1,371.

### turbo-one-call-1501

This goes beyond prompt and config.
- A plugin reads the five gift types and searches Shopify's Global Catalog live BEFORE the model runs. Kimi doesn't call the tool.
- A second plugin, through the standard provider hook, sends Kimi only those results (with the stores' descriptions), "Zero prose." and "Repeat the list above in full." No tools or other context. It also retries 429s every 2-3 s before output starts.
- No store list, preset products, product URLs or cache. Timing and usage are untouched.
- Best of 180 one-call attempts across variants up to this run (93 completed, median 986).
