import type { Plugin, Hooks } from "@opencode-ai/plugin"

/**
 * ai& provider for OpenCode.
 *
 * Drop this file next to your `opencode.json` and reference it with
 * `"plugin": ["./aiand.ts"]`. OpenCode then gains an "ai&" provider that:
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

type CatalogProvider = { npm?: string; models?: Record<string, unknown> }

// ai&'s public catalog (/v1/api.json) needs no key and is already in OpenCode's
// models.dev shape. It holds a single provider entry whose `.models` map is
// what we want.
async function fetchCatalogModels(): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`${baseURL}/api.json`)
    if (!res.ok) {
      console.error(`[aiand] model catalog fetch failed: ${res.status} ${res.statusText}`)
      return {}
    }
    const catalog = (await res.json()) as Record<string, CatalogProvider>
    return Object.values(catalog)[0]?.models ?? {}
  } catch (err) {
    console.error("[aiand] failed to load model catalog", err)
    return {}
  }
}

export const AiandPlugin: Plugin = async () => {
  // Fetch the catalog once at startup. OpenCode reads cfg.provider AFTER plugin
  // config() hooks run, and a *new* provider's models must be declared inline
  // (the provider.models() hook only augments providers already known to
  // models.dev) — so we inject the live models straight into config below.
  const models = await fetchCatalogModels()

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
        },
        models,
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
