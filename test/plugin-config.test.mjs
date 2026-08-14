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

test("keeps the configured catalog map deeply frozen for the PDF transport", async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const catalog = {
    opencode: {
      models: {
        "moonshotai/kimi-k3": {
          attachment: true,
          modalities: { input: ["text", "image", "pdf"] },
        },
      },
    },
  }
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push(url)
    assert.equal(url, "https://api.aiand.com/v1/api.json")
    return { ok: true, status: 200, statusText: "OK", json: async () => catalog }
  }

  try {
    const hooks = await AiandPlugin({})
    const cfg = {}
    await hooks.config(cfg)
    const models = cfg.provider.aiand.models
    const model = models["moonshotai/kimi-k3"]

    assert.equal(models, catalog.opencode.models)
    assert.equal(Object.isFrozen(models), true)
    assert.equal(Object.isFrozen(model), true)
    assert.equal(Object.isFrozen(model.modalities), true)
    assert.equal(Object.isFrozen(model.modalities.input), true)
    assert.throws(() => {
      model.attachment = false
    }, TypeError)
    assert.throws(() => {
      model.modalities.input.push("audio")
    }, TypeError)

    await assert.rejects(
      cfg.provider.aiand.options.fetch("https://api.aiand.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "moonshotai/kimi-k3",
          messages: [
            {
              role: "user",
              content: [{ type: "file", file: { file_data: "data:application/pdf;base64,%%%%" } }],
            },
          ],
        }),
      }),
      { message: "[aiand] PDF validation failed: invalid base64 data" },
    )
    assert.deepEqual(calls, ["https://api.aiand.com/v1/api.json"])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("falls back to an unavailable catalog for malformed model entries", async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push(url)
    if (url === "https://api.aiand.com/v1/api.json") {
      return new Response(JSON.stringify({ opencode: { models: { bad: null } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("non-PDF passthrough", { status: 200 })
  }

  try {
    const hooks = await AiandPlugin({})
    const cfg = {}
    await hooks.config(cfg)

    assert.deepEqual(cfg.provider.aiand.models, {})
    assert.equal(typeof cfg.provider.aiand.options.fetch, "function")
    const response = await cfg.provider.aiand.options.fetch("https://api.aiand.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "moonshotai/kimi-k3", messages: [{ role: "user", content: "hello" }] }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(calls, ["https://api.aiand.com/v1/api.json", "https://api.aiand.com/v1/chat/completions"])
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
