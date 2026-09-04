import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tool, type Plugin, type Hooks } from "@opencode-ai/plugin"

/**
 * ai& provider plugin for OpenCode.
 *
 * Add `"plugin": ["@aiand/opencode-plugin"]` to your `opencode.json` and
 * OpenCode gains an "ai&" provider that:
 *
 *   1. routes to the ai& gateway (api.aiand.com, OpenAI-compatible);
 *   2. logs in via `opencode auth login` → "ai&" → "ai& API Key";
 *   3. lists ai&'s live model catalog in the model picker (cached to disk,
 *      so a gateway outage still leaves the last known models in place);
 *   4. retries transient gateway failures (429 + 5xx, honoring
 *      `Retry-After`) with exponential backoff + jitter;
 *   5. adds `/aiand-usage` and the `aiand_usage` tool for org usage stats
 *      from the gateway's `/analytics/metrics` endpoint.
 *
 * It uses only OpenCode's public plugin API.
 */

const PROVIDER_ID = "aiand"
const DEFAULT_BASE_URL = "https://api.aiand.com/v1"

// Overridable to point at a different ai& environment without edits:
//   AIAND_BASE_URL=https://api.aiand.com/v1
const baseURL = (process.env.AIAND_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "")

type PluginInput = Parameters<Plugin>[0]
type PluginClient = PluginInput["client"]

// The models map exactly as OpenCode's config schema expects it, derived from
// the `config` hook's own signature so it tracks upstream type changes.
type ConfigInput = Parameters<NonNullable<Hooks["config"]>>[0]
type ProviderModels = NonNullable<NonNullable<ConfigInput["provider"]>[string]["models"]>

// ai&'s public catalog (/v1/api.json) needs no key and is already in OpenCode's
// models.dev shape. It holds provider entries keyed by client id ("aiand",
// "opencode"); each carries the same `.models` map.
type CatalogProvider = { npm?: string; models?: ProviderModels }

// Catalog cache: 6h TTL on disk so a gateway outage doesn't empty the model
// picker — the last known models keep serving. Written next to OpenCode's own
// state (~/.local/share/opencode), keyed per gateway host so switching
// AIAND_BASE_URL never mixes catalogs.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_HOST = baseURL.replace(/[^a-zA-Z0-9.-]/g, "_")
const CACHE_PATH = join(
  process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? ".", ".local", "share"),
  "opencode",
  `aiand-model-cache-${CACHE_HOST}.json`,
)

type CachedCatalog = { fetchedAt?: number; models?: ProviderModels }

async function readCachedModels(maxAgeMs: number): Promise<ProviderModels | undefined> {
  let raw: CachedCatalog
  try {
    raw = JSON.parse(await readFile(CACHE_PATH, "utf8")) as CachedCatalog
  } catch {
    return undefined // no cache yet, or unreadable
  }
  const fresh = typeof raw.fetchedAt === "number" && Date.now() - raw.fetchedAt < maxAgeMs
  return fresh && raw.models ? raw.models : undefined
}

async function writeCachedModels(models: ProviderModels): Promise<void> {
  try {
    await mkdir(dirname(CACHE_PATH), { recursive: true })
    await writeFile(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), models }))
  } catch {
    // Best-effort; never fail startup over the cache.
  }
}

async function report(client: PluginClient, level: "warn" | "error", message: string) {
  try {
    await client.app.log({ body: { service: "aiand", level, message } })
  } catch {
    console.error(`[aiand] ${message}`)
  }
}

async function fetchCatalogModels(client: PluginClient): Promise<ProviderModels | undefined> {
  // Fresh within TTL? Serve from disk and skip the network entirely.
  const cached = await readCachedModels(CACHE_TTL_MS)
  if (cached) return cached

  try {
    // Bound the request so a hung gateway can't stall OpenCode startup.
    const res = await fetch(`${baseURL}/api.json`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const catalog = (await res.json()) as Record<string, CatalogProvider>
    // Prefer the entry keyed for this plugin's client id; fall back to the
    // first entry if that ever changes.
    const entry = catalog[PROVIDER_ID] ?? Object.values(catalog)[0]
    if (!entry?.models) return undefined
    await writeCachedModels(entry.models)
    return entry.models
  } catch (err) {
    // Offline/outage: a stale catalog beats an empty picker. No age limit —
    // stale data is clearly better than no models at all.
    const stale = await readCachedModels(Number.POSITIVE_INFINITY)
    if (stale) {
      await report(client, "warn", `model catalog unreachable, serving cached copy: ${String(err)}`)
      return stale
    }
    await report(client, "warn", `model catalog fetch failed: ${String(err)}`)
    return undefined
  }
}


// ---------------------------------------------------------------------------
// Retry fetch: transient gateway failures (429 rate limit, 5xx, network
// hiccups) are retried with exponential backoff + jitter, honoring
// `Retry-After` when the gateway sends it. OpenCode wraps this fetch with its
// own timeout/abort handling, so we only manage retry timing.
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS: Record<number, true> = {
  408: true,
  425: true,
  429: true,
  500: true,
  502: true,
  503: true,
  504: true,
}
const MAX_RETRIES = 3
const BACKOFF_BASE_MS = 800
const BACKOFF_MAX_MS = 15_000

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

function backoffDelay(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, BACKOFF_MAX_MS)
    const at = Date.parse(retryAfter)
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), BACKOFF_MAX_MS)
  }
  const exp = BACKOFF_BASE_MS * 2 ** attempt
  return Math.min(exp + Math.floor(Math.random() * 400), BACKOFF_MAX_MS)
}

function retryFetch(): typeof fetch {
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await fetch(input, init)
      } catch (err) {
        if (attempt >= MAX_RETRIES) throw err
        await sleep(backoffDelay(attempt, null))
        continue
      }
      if (!RETRYABLE_STATUS[res.status] || attempt >= MAX_RETRIES) return res
      // Drain so the connection can be reused on retry.
      await res.body?.cancel().catch(() => {})
      await sleep(backoffDelay(attempt, res.headers.get("retry-after")))
    }
  }
}

// ---------------------------------------------------------------------------
// Usage reporting: /aiand-usage command + aiand_usage tool hit the gateway's
// /analytics/metrics endpoint (org-scoped, API-key auth, 120s server cache).
// ---------------------------------------------------------------------------

const USAGE_RANGES = ["1h", "24h", "7days", "30days", "3months"] as const
type UsageRange = (typeof USAGE_RANGES)[number]

function isUsageRange(v: string): v is UsageRange {
  return (USAGE_RANGES as readonly string[]).includes(v)
}

// Live wire format of GET /analytics/metrics (observed, not docs shape):
// {"object":"list","data":[{"metric_name","unit","aggregation",
//   "timeseries":[{"timestamp","value","dimensions"}]}]}
type MetricSeries = {
  metric_name: string
  unit?: string
  aggregation?: string
  timeseries?: { timestamp: string; value: number }[]
}

// Sum-type metrics are totaled over the window; mean-type ones are averaged
// over the points that actually have traffic.
const TOTAL_METRICS: Record<string, "sum" | "mean"> = {
  requests: "sum",
  input_tokens: "sum",
  output_tokens: "sum",
  tokens_per_second: "mean",
  latency: "mean",
  time_to_first_token: "mean",
}

function summarizeMetric(series: MetricSeries): string {
  const points = series.timeseries ?? []
  const kind = TOTAL_METRICS[series.metric_name] ?? "sum"
  const active = points.filter((p) => p.value !== 0)
  const source = kind === "mean" ? active : points
  if (source.length === 0) return `${series.metric_name}: 0`
  const total = source.reduce((acc, p) => acc + p.value, 0)
  const value = kind === "mean" ? total / source.length : total
  const unit = series.unit ? ` ${series.unit}` : ""
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 100) / 100
  return `${series.metric_name}: ${rounded.toLocaleString()}${unit}`
}

async function fetchUsage(apiKey: string, range: UsageRange): Promise<string> {
  // The analytics API hangs off the gateway origin (api.aiand.com), NOT off
  // the /v1 inference base — https://api.aiand.com/analytics/metrics.
  const origin = new URL(baseURL).origin
  const res = await fetch(`${origin}/analytics/metrics?range=${encodeURIComponent(range)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    const hint =
      res.status === 401
        ? " (is the API key valid?)"
        : res.status === 404
          ? ` — is ${origin} the right gateway?`
          : ""
    return `ai& usage: request failed ${res.status} ${res.statusText}${hint}${body ? `: ${body.slice(0, 200)}` : ""}`
  }
  const data = (await res.json()) as { data?: MetricSeries[] }
  const series = data.data ?? []
  if (series.length === 0) return `ai& usage (${range}): no metrics returned`
  const lines = series.map(summarizeMetric)
  const lastTraffic = series
    .flatMap((s) => s.timeseries ?? [])
    .filter((p) => p.value !== 0)
    .map((p) => p.timestamp)
    .sort()
  const window =
    lastTraffic.length > 0
      ? `last traffic ${lastTraffic[0].slice(11, 16)}–${lastTraffic[lastTraffic.length - 1].slice(11, 16)} UTC`
      : "no traffic in this range"
  return [`ai& usage — ${range} (${window})`, ...lines].join("\n")
}

export const AiandPlugin: Plugin = async ({ client }) => {
  // Fetch the catalog once at startup. OpenCode reads cfg.provider AFTER plugin
  // config() hooks run, and a *new* provider's models must be declared inline
  // (the provider.models() hook only augments providers already known to
  // models.dev) — so we inject the live models straight into config below.
  const models = await fetchCatalogModels(client)


  return {
    // Register the ai& provider (OpenAI-compatible), pointed at the gateway,
    // with its live model list. This single hook is what makes "aiand" a
    // first-class provider in the picker and `-m aiand/<model>`.
    config: async (cfg) => {
      cfg.provider ??= {}
      const existing = cfg.provider[PROVIDER_ID]
      if (!existing?.npm && !existing?.options && !existing?.models) {
        cfg.provider[PROVIDER_ID] = {
          name: "ai&",
          npm: "@ai-sdk/openai-compatible",
          api: baseURL,
          // Lets `opencode run` pick up a key non-interactively from the env.
          env: ["AIAND_API_KEY"],
          options: {
            baseURL,
            // Used when AIAND_API_KEY is set; an interactive `auth login` key
            // overrides this at request time via the auth loader below.
            apiKey: process.env.AIAND_API_KEY,
          },
          models,
        }
      } else if (existing && !existing.models) {
        // User configured the provider (base URL, key, ...) but no models:
        // only fill in the catalog, leave everything else theirs.
        existing.models = models
      }
      // Else: the user's own model list for "aiand" wins — never clobber it.

      // /aiand-usage <range>: org usage summary from the gateway's analytics,
      // relayed through the aiand_usage tool (which reads the env key).
      cfg.command ??= {}
      if (!cfg.command["aiand-usage"]) {
        cfg.command["aiand-usage"] = {
          description: "Show ai& org usage (requests, tokens, cost) from analytics/metrics",
          template:
            "Show my ai& usage for the range $ARGUMENTS (default 24h; one of 1h, 24h, 7days, 30days, 3months). " +
            "Call the aiand_usage tool with that range and relay its output verbatim. " +
            "If the tool reports a missing key, tell me to export AIAND_API_KEY.",
        }
      }
    },

    // `opencode auth login` → "ai&" → paste your sk-... key. The loader injects
    // the stored key as the provider's apiKey, plus the retrying fetch the
    // openai-compatible adapter then uses for every request.
    auth: {
      provider: PROVIDER_ID,
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type === "api") return { apiKey: auth.key, fetch: retryFetch() }
        // No stored key: still install the retrying fetch for env-var auth.
        return process.env.AIAND_API_KEY ? { fetch: retryFetch() } : {}
      },
      methods: [{ type: "api", label: "ai& API Key" }],
    },

    // aiand_usage: same data as /aiand-usage, callable by the model.
    tool: {
      aiand_usage: tool({
        description:
          "Fetch ai& gateway usage analytics for the calling organization: requests, tokens, cost, errors, latency. " +
          `Range must be one of: ${USAGE_RANGES.join(", ")}.`,
        args: {
          range: tool.schema.enum(USAGE_RANGES).default("24h").describe("Time window for usage data"),
        },
        async execute(args) {
          const key = process.env.AIAND_API_KEY
          if (!key) {
            return "No ai& API key available to this tool. Export AIAND_API_KEY in your environment (OpenCode's stored `auth login` keys are not readable by plugins), then retry."
          }
          try {
            // Models can send values outside the schema; clamp to a valid range.
            const range = isUsageRange(args.range) ? args.range : "24h"
            return await fetchUsage(key, range)
          } catch (err) {
            return `ai& usage: request failed: ${String(err)}`
          }
        },
      }),
    },
  } satisfies Hooks
}
