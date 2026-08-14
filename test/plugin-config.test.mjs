import assert from "node:assert/strict"
import test from "node:test"

import { AiandPlugin } from "../dist/index.js"

test("registers the PDF upload fetch on the Aiand provider", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input)
    assert.equal(url, "https://api.aiand.com/v1/api.json")
    return new Response(
      JSON.stringify({
        opencode: {
          npm: "@ai-sdk/openai-compatible",
          models: {
            "moonshotai/kimi-k3": {
              name: "Kimi K3",
              attachment: true,
              modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }

  try {
    const hooks = await AiandPlugin({})
    const cfg = {}
    await hooks.config(cfg)

    assert.equal(cfg.provider.aiand.npm, "@ai-sdk/openai-compatible")
    assert.equal(cfg.provider.aiand.api, "https://api.aiand.com/v1")
    assert.equal(cfg.provider.aiand.options.baseURL, "https://api.aiand.com/v1")
    assert.equal(typeof cfg.provider.aiand.options.fetch, "function")
    assert.deepEqual(cfg.provider.aiand.models["moonshotai/kimi-k3"].modalities.input, ["text", "image", "pdf"])
    assert.equal(cfg.provider.aiand.models["moonshotai/kimi-k3"].attachment, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("registers text-only config when the model catalog is unavailable", async () => {
  const originalFetch = globalThis.fetch
  const originalConsoleError = console.error
  globalThis.fetch = async () => {
    throw new Error("catalog unavailable")
  }
  console.error = () => {}

  try {
    const hooks = await AiandPlugin({})
    const cfg = {}
    await hooks.config(cfg)

    assert.deepEqual(cfg.provider.aiand.models, {})
    assert.equal(typeof cfg.provider.aiand.options.fetch, "function")
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalConsoleError
  }
})
