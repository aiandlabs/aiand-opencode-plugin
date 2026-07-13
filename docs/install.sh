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
#   4. Optionally enables OpenCode's built-in web search (asks first).
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

# ---- 3. web search (optional) ----------------------------------------------
# OpenCode's built-in web search (Exa, keyless) is gated behind the env var
# OPENCODE_ENABLE_EXA=1 for third-party providers like ai&. We offer to add one
# export line to the shell profile. The OpenCode Desktop app sources the login
# shell's environment at startup, so the same line covers the GUI too.
EXA_VAR="OPENCODE_ENABLE_EXA"
EXA_MARKER=">>> aiand: enable OpenCode web search (Exa) >>>"
WEBSEARCH_STATE="manual"   # enabled | already | skipped | manual

# The shell profile the user's login shell reads (and that OpenCode Desktop's
# startup probe sources). Empty for shells we don't want to auto-edit.
websearch_profile() {
  case "${SHELL:-}" in
    */zsh)  printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    */bash) printf '%s\n' "$HOME/.bashrc" ;;
    *)      printf '%s\n' "" ;;
  esac
}

websearch_manual_hint() {
  case "${SHELL:-}" in
    */fish) printf '%s\n' "    Enable manually: ${DIM}set -Ux $EXA_VAR 1${RESET}" ;;
    *)      printf '%s\n' "    Enable manually: add ${DIM}export $EXA_VAR=1${RESET} to your shell profile" ;;
  esac
}

enable_websearch() {
  local profile; profile="$(websearch_profile)"

  # Already on (env or a previous run's block) — nothing to ask.
  case "${OPENCODE_ENABLE_EXA:-}" in
    1 | true)
      ok "Web search already enabled (\$$EXA_VAR is set)"
      WEBSEARCH_STATE="already"
      return
      ;;
  esac
  if [ -n "$profile" ] && [ -f "$profile" ] && grep -qF "$EXA_MARKER" "$profile"; then
    ok "Web search already enabled in ${BOLD}$profile${RESET}"
    WEBSEARCH_STATE="already"
    return
  fi

  info "Optional: web search"
  printf '%s\n' "    OpenCode has built-in web search (via Exa — free, no API key)."
  printf '%s\n' "    For ai& models it's off unless ${DIM}$EXA_VAR=1${RESET} is set."

  # Shells we don't auto-edit (fish, others): the epilogue explains how.
  if [ -z "$profile" ]; then
    warn "Don't know how to edit your shell's profile automatically (\$SHELL=${SHELL:-unset})."
    return
  fi

  printf '%s\n' "    Enabling adds one export line to ${BOLD}$profile${RESET}."

  # stdin is the curl pipe, so prompt via the terminal directly. Without a
  # terminal (CI etc.; the device may exist but not open) don't guess — leave
  # it off; the epilogue explains how.
  if ! { : < /dev/tty; } 2>/dev/null; then
    warn "No terminal to ask on — skipping."
    return
  fi
  local answer=""
  printf '%s' "${BLUE}==>${RESET} Enable web search? [Y/n] "
  read -r answer < /dev/tty || answer="n"
  case "$answer" in
    n* | N*)
      ok "Skipped web search"
      WEBSEARCH_STATE="skipped"
      return
      ;;
  esac

  mkdir -p "$(dirname "$profile")"
  cat >> "$profile" <<EOF

# $EXA_MARKER
export $EXA_VAR=1
# <<< aiand <<<
EOF
  ok "Enabled web search in ${BOLD}$profile${RESET}"
  WEBSEARCH_STATE="enabled"
}

# ---- run -------------------------------------------------------------------
printf '%s\n\n' "${BOLD}ai& for OpenCode — installer${RESET}"
install_opencode
configure
enable_websearch

cat <<EOF

${GREEN}${BOLD}Done.${RESET} Next steps:

  ${BOLD}opencode auth login${RESET}   choose ${BOLD}ai&${RESET} → paste your sk-... key
  ${BOLD}opencode${RESET}              start the TUI

  Get a key at ${BLUE}https://aiand.com${RESET}
  (Or, non-interactively: ${DIM}export AIAND_API_KEY=sk-...${RESET})
EOF

case "$WEBSEARCH_STATE" in
  enabled)
    cat <<EOF

  ${BOLD}Web search:${RESET} enabled. Open a new terminal (or ${DIM}source $(websearch_profile)${RESET}) first.
  Using the OpenCode Desktop app? It reads your shell profile at launch — just restart it.
EOF
    ;;
  skipped | manual)
    cat <<EOF

  ${BOLD}Web search:${RESET} not enabled. To turn it on later:
$(websearch_manual_hint)
EOF
    ;;
esac
