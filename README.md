# ai& for OpenCode

Add [ai&](https://aiand.com) as a provider in [OpenCode](https://opencode.ai) with a single
plugin — just OpenCode plus one file.

## What you get

Drop `aiand.ts` next to your `opencode.json` and OpenCode gains an **ai&** provider that:

1. **Routes to the ai& gateway** — `https://api.aiand.com/v1` (OpenAI-compatible).
2. **Logs in cleanly** — `opencode auth login` → **ai&** → paste your `sk-...` key.
3. **Lists the live catalog** — the model picker is populated straight from ai&'s public
   `/v1/api.json`, so new models show up without touching the plugin.

## Setup

Two files:

`opencode.json`
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./aiand.ts"],
  "model": "aiand/zai-org/glm-5.2"
}
```

`aiand.ts` — the plugin (in this directory). It uses two OpenCode hooks:

| Hook | What it does |
|---|---|
| `config` | fetches ai&'s public `/v1/api.json` and registers the `aiand` provider (`@ai-sdk/openai-compatible`, `baseURL`) **with the live model list injected inline** |
| `auth` | adds the "ai& API Key" login method; injects the stored key as `Bearer` |

> Why inline models (not the `provider.models()` hook)? OpenCode only runs `provider.models()`
> for providers already known to models.dev; a brand-new provider's models must be declared in
> config. The `config` hook runs *before* OpenCode reads `cfg.provider`, so fetching the catalog
> there and setting `provider.aiand.models` is what makes the picker show ai&'s live models.

## Run it

```bash
./demo.sh                            # launch the TUI, pick an ai& model
./demo.sh run "say hi in one word"   # non-interactive single turn
```

`demo.sh` installs OpenCode into `~/.opencode/bin` if it isn't already present.

### Auth

- **Interactive:** inside the TUI run `/login` (or `opencode auth login`) → choose **ai&**
  → paste your `sk-...` key.
- **Non-interactive:** `export AIAND_API_KEY=sk-...` before running.

The model picker and catalog populate **without** a key (`/v1/api.json` is public); a key is
only needed to actually send a message. Get one at [aiand.com](https://aiand.com).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `AIAND_API_KEY` | — | Your ai& API key (alternative to `opencode auth login`). |
| `AIAND_BASE_URL` | `https://api.aiand.com/v1` | Override the gateway base URL. |

## Status

Verified end-to-end against **OpenCode v1.17.9**: the plugin loads, the `aiand` provider
appears with ai&'s live catalog, `opencode run -m aiand/<model> "..."` returns a completion
through the gateway, and `opencode auth login` surfaces the "ai& API Key" method. This is a
working demo, not yet a published package.

## Next steps (not built here)

- Publish as an npm package so others can install via `"plugin": ["opencode-aiand"]`.
- Add an OAuth login method as an alternative to API keys.
