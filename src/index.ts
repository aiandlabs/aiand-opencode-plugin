import type { Plugin, Hooks } from "@opencode-ai/plugin"
import type { CatalogSnapshot } from "./pdf-capability.js"
import { createPdfUploadFetch } from "./pdf-upload-fetch.js"

/**
 * ai& provider for OpenCode.
 *
 * Add `"plugin": ["@aiand/opencode-plugin"]` to your `opencode.json` and
 * OpenCode gains an "ai&" provider that:
 *
 *   1. routes to the ai& gateway (api.aiand.com, OpenAI-compatible);
 *   2. logs in via `opencode auth login` → "ai&" → "ai& API Key";
 *   3. lists ai&'s live model catalog in the model picker.
 *
 * It uses only OpenCode's public plugin API.
 */

const PROVIDER_ID = "aiand"
const DEFAULT_BASE_URL = "https://api.aiand.com/v1"

// Overridable to point at a different ai& environment without edits:
//   AIAND_BASE_URL=https://api.aiand.com/v1
const baseURL = (process.env.AIAND_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "")

// The models map exactly as OpenCode's config schema expects it, derived from
// the `config` hook's own signature so it tracks upstream type changes.
type ConfigInput = Parameters<NonNullable<Hooks["config"]>>[0]
type ProviderModels = NonNullable<NonNullable<ConfigInput["provider"]>[string]["models"]>

type CatalogProvider = { npm?: unknown; models?: unknown }

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function unavailableCatalogSnapshot(): CatalogSnapshot {
  return deepFreeze({ available: false, fetchedAtMs: Date.now(), models: {} })
}

// ai&'s public catalog (/v1/api.json) needs no key and is already in OpenCode's
// models.dev shape. It holds a single provider entry whose `.models` map is
// what we want.
async function fetchCatalogSnapshot(): Promise<CatalogSnapshot> {
  try {
    // Bound the request so a hung gateway can't stall OpenCode startup.
    const res = await fetch(`${baseURL}/api.json`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      console.error(`[aiand] model catalog fetch failed: HTTP ${res.status}`)
      return unavailableCatalogSnapshot()
    }
    const catalog = (await res.json()) as unknown
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return unavailableCatalogSnapshot()
    // The catalog keys its single entry under "opencode"; fall back to the
    // first entry if that ever changes.
    const entries = catalog as Record<string, CatalogProvider>
    const entry = entries["opencode"] ?? Object.values(entries)[0]
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return unavailableCatalogSnapshot()
    if (!entry.models || typeof entry.models !== "object" || Array.isArray(entry.models)) {
      return unavailableCatalogSnapshot()
    }
    const models = entry.models as CatalogSnapshot["models"]
    if (Object.values(models).some((model) => !model || typeof model !== "object" || Array.isArray(model))) {
      return unavailableCatalogSnapshot()
    }
    return deepFreeze({
      available: true,
      fetchedAtMs: Date.now(),
      models: deepFreeze(models),
    })
  } catch {
    console.error("[aiand] model catalog fetch failed")
    return unavailableCatalogSnapshot()
  }
}

export const AiandPlugin: Plugin = async () => {
  // Fetch the catalog once at startup. OpenCode reads cfg.provider AFTER plugin
  // config() hooks run, and a *new* provider's models must be declared inline
  // (the provider.models() hook only augments providers already known to
  // models.dev) — so we inject the live models straight into config below.
  const catalogSnapshot = await fetchCatalogSnapshot()
  const pdfUploadFetch = createPdfUploadFetch({ baseURL, catalogSnapshot })

  return {
    // Register the ai& provider (OpenAI-compatible), pointed at the gateway,
    // with its live model list. This single hook is what makes "aiand" a
    // first-class provider in the picker and `-m aiand/<model>`.
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER_ID] ??= {
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
          fetch: pdfUploadFetch,
        },
        models: catalogSnapshot.models as ProviderModels,
      }
    },

    // `opencode auth login` → "ai&" → paste your sk-... key. The loader injects
    // the stored key as the provider's apiKey, which the openai-compatible
    // adapter sends as `Authorization: Bearer <key>`.
    auth: {
      provider: PROVIDER_ID,
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type === "api") return { apiKey: auth.key }
        return {}
      },
      methods: [{ type: "api", label: "ai& API Key" }],
    },
  } satisfies Hooks
}
