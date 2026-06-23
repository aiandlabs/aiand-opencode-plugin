# ai& for OpenCode

Add [ai&](https://aiand.com) as a provider in [OpenCode](https://opencode.ai) with a single plugin.

## What you get

An **ai&** provider in OpenCode that:

1. **Routes to the ai& gateway** — `https://api.aiand.com/v1` (OpenAI-compatible).
2. **Logs in cleanly** — `opencode auth login` → **ai&** → paste your `sk-...` key.
3. **Lists the live catalog** — the model picker is populated straight from ai&'s public
   `/v1/api.json`, so new models show up without touching the plugin.

Requires [OpenCode](https://opencode.ai) (`curl -fsSL https://opencode.ai/install | bash`).

## Install — internal testing (current)

The plugin isn't published yet, so you reference the local `aiand.ts` file.

The quickest way is to clone the repo and run OpenCode from inside it — the included
`opencode.json` already wires up the plugin:

```bash
git clone git@github.com:aiandlabs/aiand-opencode-plugin.git
cd aiand-opencode-plugin
export AIAND_API_KEY=sk-...        # or use `opencode auth login`
opencode                            # TUI
opencode run "say hi in one word"   # one-shot
```

`opencode.json` (already in the repo):
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./aiand.ts"],
  "model": "aiand/zai-org/glm-5.2"
}
```

To use it from your **own** projects, point at the cloned file by absolute path in your global
config (`~/.config/opencode/opencode.jsonc`) so it's available everywhere:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/aiand-opencode-plugin/aiand.ts"]
}
```

## Install — after publishing (future)

Once published to npm as `aiand-opencode-plugin`, there's no clone or local path — just reference
it by name in any `opencode.json` and OpenCode installs it automatically:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["aiand-opencode-plugin"],
  "model": "aiand/zai-org/glm-5.2"
}
```

> Not available yet — see [Status](#status).

## Auth

- **Interactive:** `opencode auth login` → choose **ai&** → paste your `sk-...` key.
- **Non-interactive:** `export AIAND_API_KEY=sk-...`.

The model picker and catalog populate **without** a key (`/v1/api.json` is public); a key is
only needed to actually send a message. Get one at [aiand.com](https://aiand.com).

## How it works

`aiand.ts` uses two OpenCode hooks:

| Hook | What it does |
|---|---|
| `config` | fetches ai&'s public `/v1/api.json` and registers the `aiand` provider (`@ai-sdk/openai-compatible`, `baseURL`) **with the live model list injected inline** |
| `auth` | adds the "ai& API Key" login method; injects the stored key as `Bearer` |

> Why inline models (not the `provider.models()` hook)? OpenCode only runs `provider.models()`
> for providers already known to models.dev; a brand-new provider's models must be declared in
> config. The `config` hook runs *before* OpenCode reads `cfg.provider`, so fetching the catalog
> there and setting `provider.aiand.models` is what makes the picker show ai&'s live models.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `AIAND_API_KEY` | — | Your ai& API key (alternative to `opencode auth login`). |
| `AIAND_BASE_URL` | `https://api.aiand.com/v1` | Override the gateway base URL. |

## Status

Verified end-to-end against **OpenCode v1.17.9**: the plugin loads, the `aiand` provider appears
with ai&'s live catalog, `opencode run -m aiand/<model> "..."` returns a completion through the
gateway, and `opencode auth login` surfaces the "ai& API Key" method. This is a working plugin
loaded from a local file; it is **not yet published to npm**.

## Next steps

- Publish as an npm package so others can install via `"plugin": ["aiand-opencode-plugin"]`.
- Add an OAuth login method as an alternative to API keys.
