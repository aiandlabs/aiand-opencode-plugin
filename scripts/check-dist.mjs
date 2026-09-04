// Checks the built plugin in dist/. Guards the constraints OpenCode's npm
// plugin loader imposes on the published package:
//
//   1. package.json `main` must point at a real, importable compiled entry
//      (plugins install with scripts disabled — no build step runs).
//   2. Every runtime export of the entry module must be a plugin function;
//      a single stray non-function export makes OpenCode reject the plugin.
//   3. The plugin factory must resolve to a Hooks object exposing every hook
//      this plugin is built around (config, auth, tool).
//   4. The tool registration is shaped the way OpenCode's tool loader
//      expects (description + args schema + execute).
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)
const pkg = require("../package.json")

assert.ok(pkg.main, "package.json must declare `main` (OpenCode resolves npm plugins from it)")
const mod = await import(pathToFileURL(new URL(`../${pkg.main}`, import.meta.url).pathname))

const exports_ = Object.entries(mod)
assert.ok(exports_.length > 0, "entry module has no runtime exports")
for (const [name, value] of exports_) {
  assert.equal(typeof value, "function", `runtime export "${name}" is not a plugin function`)
}

const hooks = await mod.AiandPlugin({})
assert.equal(typeof hooks.config, "function", "plugin must return a `config` hook")
assert.ok(hooks.auth?.provider === "aiand", "plugin must return an `auth` hook for provider `aiand`")
assert.ok(hooks.tool?.aiand_usage, "plugin must register the `aiand_usage` tool")
assert.equal(typeof hooks.tool.aiand_usage.execute, "function", "aiand_usage tool must be executable")
assert.ok(hooks.tool.aiand_usage.description.length > 0, "aiand_usage tool needs a description")
assert.ok(hooks.tool.aiand_usage.args, "aiand_usage tool needs an args schema")

console.log("check-dist ok:", Object.keys(mod).join(", "))
