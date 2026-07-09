#!/usr/bin/env bash
#
# ai& for OpenCode — one-line installer.
#
#   curl -fsSL https://opencode.aiand.com/install.sh | bash
#
# What it does:
#   1. Installs OpenCode (https://opencode.ai) if it isn't already on your PATH.
#   2. Adds the @aiand/opencode-plugin plugin to your global OpenCode config.
#   3. Sets a default ai& model (only if you don't already have one set).
#
# It never overwrites an existing model choice and always backs up your config
# before editing it. Re-running is safe (idempotent).

set -euo pipefail

PLUGIN="@aiand/opencode-plugin"
DEFAULT_MODEL="aiand/zai-org/glm-5.2"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

# ---- pretty output ---------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  BLUE=$'\033[34m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; BLUE=""; RED=""; RESET=""
fi
info()  { printf '%s\n' "${BLUE}==>${RESET} $*"; }
ok()    { printf '%s\n' "${GREEN}  ✓${RESET} $*"; }
warn()  { printf '%s\n' "${YELLOW}  !${RESET} $*"; }
die()   { printf '%s\n' "${RED}  ✗${RESET} $*" >&2; exit 1; }

have()  { command -v "$1" >/dev/null 2>&1; }

# ---- 1. OpenCode -----------------------------------------------------------
install_opencode() {
  if have opencode; then
    ok "OpenCode already installed ($(opencode --version 2>/dev/null || echo present))"
    return
  fi
  info "Installing OpenCode…"
  if ! have curl; then die "curl is required to install OpenCode."; fi
  curl -fsSL https://opencode.ai/install | bash
  # The installer typically drops the binary in ~/.opencode/bin — make sure
  # this shell can see it for the verification step below.
  export PATH="$HOME/.opencode/bin:$PATH"
  if have opencode; then
    ok "OpenCode installed"
  else
    warn "OpenCode was installed but isn't on this shell's PATH yet."
    warn "Open a new terminal (or re-source your shell profile) after this finishes."
  fi
}

# ---- 2. config -------------------------------------------------------------
# Find an existing global config, or default to opencode.json.
find_config() {
  for name in opencode.jsonc opencode.json; do
    if [ -f "$CONFIG_DIR/$name" ]; then printf '%s\n' "$CONFIG_DIR/$name"; return; fi
  done
  printf '%s\n' "$CONFIG_DIR/opencode.json"
}

write_fresh_config() {
  local file="$1"
  mkdir -p "$(dirname "$file")"
  cat > "$file" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["$PLUGIN"],
  "model": "$DEFAULT_MODEL"
}
EOF
  ok "Created ${BOLD}$file${RESET} with the ai& plugin"
}

# True if the plugin (or a versioned spec of it, e.g. "…@0.1.0") is already
# listed. Coerces a scalar `plugin` value to an array first so a hand-written
# string doesn't break the scan.
plugin_present() {
  jq -e --arg p "$PLUGIN" '
    ((.plugin // []) | if type == "array" then . else [.] end)
    | any(.[]; type == "string" and (. == $p or startswith($p + "@")))
  ' "$1" >/dev/null 2>&1
}

# Merge into an existing JSON config with jq. Appends the plugin (order matters:
# hooks fire in array order, so preserve the user's list and add ours last) and
# sets the default model only when none is present. Coerces a scalar `plugin`
# into an array so a hand-written string value doesn't break the merge. On any
# jq failure the original file is left untouched and the temp file cleaned up.
merge_with_jq() {
  local file="$1" tmp
  tmp="$(mktemp)"
  if jq --arg plugin "$PLUGIN" --arg model "$DEFAULT_MODEL" '
        (.plugin // []) as $p |
        .plugin = ((if ($p | type) == "array" then $p else [$p] end) + [$plugin]) |
        if (.model // "") == "" then .model = $model else . end
      ' "$file" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    mv "$tmp" "$file"
    ok "Updated ${BOLD}$file${RESET} (plugin added; model kept/defaulted)"
  else
    rm -f "$tmp"
    warn "Couldn't auto-edit this config safely — left it unchanged (backup kept)."
    printf '%s\n' "    Add manually: ${DIM}\"plugin\": [\"$PLUGIN\"]${RESET}"
  fi
}

configure() {
  local file; file="$(find_config)"

  if [ ! -f "$file" ]; then
    write_fresh_config "$file"
    return
  fi

  info "Found existing config: ${BOLD}$file${RESET}"

  if have jq && jq -e . "$file" >/dev/null 2>&1; then
    if plugin_present "$file"; then
      ok "Plugin already present — nothing to change"
    else
      # Only back up when we're actually about to edit — a no-op re-run leaves
      # no litter.
      cp "$file" "$file.bak-$(date +%Y%m%d%H%M%S)"
      ok "Backed it up"
      merge_with_jq "$file"
    fi
  else
    # No jq, or the file has JSONC comments jq can't parse — don't risk a bad
    # edit. Tell the user exactly what to add.
    warn "Couldn't safely auto-edit this config (jq missing or JSONC comments)."
    printf '%s\n' "    Add the plugin manually:"
    printf '%s\n' "      ${DIM}\"plugin\": [\"$PLUGIN\"]${RESET}"
    printf '%s\n' "      ${DIM}\"model\":  \"$DEFAULT_MODEL\"   (optional)${RESET}"
  fi
}

# ---- run -------------------------------------------------------------------
printf '%s\n\n' "${BOLD}ai& for OpenCode — installer${RESET}"
install_opencode
configure

cat <<EOF

${GREEN}${BOLD}Done.${RESET} Next steps:

  ${BOLD}opencode auth login${RESET}   choose ${BOLD}ai&${RESET} → paste your sk-... key
  ${BOLD}opencode${RESET}              start the TUI

  Get a key at ${BLUE}https://aiand.com${RESET}
  (Or, non-interactively: ${DIM}export AIAND_API_KEY=sk-...${RESET})
EOF
