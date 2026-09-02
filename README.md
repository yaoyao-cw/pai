# pai-switch - Multi-Agent Desktop Configuration Manager

`pai-switch` is a Linux-first Electron desktop app for switching the local
configuration used by newly launched AI coding-agent sessions.

Supported agents and profiles:

- Claude Code: B.AI, DashScope DeepSeek, DashScope Qwen, Anthropic OAuth
- OpenAI Codex: OpenAI OAuth, OpenAI API key, Mega API, AnyRouter, SharedChat, Hotaru API, WZW API
- Antigravity CLI (`agy`): native Google OAuth/model configuration
- Grok: official OAuth and Mega API

The main process owns native files and encrypted credentials. The renderer
only receives masked profile status. Every switch takes a snapshot, uses an
exclusive lock, writes files atomically, and restores the snapshot on failure.
Changes affect new sessions; already-running processes keep their environment.

Codex credentials are deliberately split: official ChatGPT OAuth stays in
`~/.codex/auth.json`, while Mega and other API-key Profiles use independent
`auth.json.key.<provider>` files plus Codex `auth.command` readers. Switching the
default Provider never replaces the official OAuth file and never writes a
global `OPENAI_API_KEY` into `.env`.

The workbench separates two actions:

- **Set as default** updates the Agent's native global configuration.
- **Run with this profile** prepares a profile-scoped command and opens it in a
  terminal. Codex and Grok use isolated `CODEX_HOME` / `GROK_HOME` directories,
  so profiles such as Codex Official and Mega can run at the same time. Codex
  additionally uses its native `-p <profile>` option and writes the matching
  `<profile>.config.toml`. Claude uses `CLAUDE_CONFIG_DIR` plus `--settings`
  (and copies the native OAuth file when present; Anthropic named credentials can
  also be selected with `ANTHROPIC_PROFILE`), Grok uses `GROK_HOME` plus
  `--model`, and Antigravity currently has one shared native Google OAuth
  profile because its CLI does not document an alternate config directory.

Launch commands are generated from known profile metadata. The renderer cannot
submit arbitrary shell commands, and API keys never appear in the displayed
command. Native Login also sets the managed home explicitly (`CODEX_HOME`,
`GROK_HOME`, or `CLAUDE_CONFIG_DIR`), so launching pai-switch from an Orca
terminal cannot redirect login writes into Orca's account directory.

## Requirements

- Node.js 20 or newer
- pnpm 10 or newer
- A desktop keyring supported by Electron `safeStorage` for saving credentials
- The relevant CLI binaries (`claude`, `codex`, `agy`, `grok`) for native login

## Development

```bash
cd /path/to/pai-switch
pnpm install
pnpm dev
```

`pnpm dev` starts Vite and the Electron window. Use `pnpm type-check` for
TypeScript validation, `pnpm test` for adapter tests, and `pnpm build` to create
the Linux unpacked/installer artifacts under `release/`.

### Electron UI inspection

Remote debugging is disabled during normal startup. For local Electron QA with
`agent-browser` 0.35 or newer, start the dedicated inspection mode:

```bash
pnpm dev:inspect
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix pai-switch)"
agent-browser connect 9333
agent-browser snapshot -i
agent-browser screenshot /tmp/pai-switch-electron.png
```

The inspection script binds Chromium CDP to `127.0.0.1:9333`. Do not expose
that port outside the local machine. Closing the Electron app ends the CDP
endpoint.

## Credentials

API-key Profiles require the key issued by that Profile's service provider.
For example, DashScope DeepSeek and DashScope Qwen use the same Alibaba Cloud
Bailian API Key. Paste it into the Inspector's **Credentials** section and
choose **Save key**. OAuth Profiles do not accept a pasted API key; use their
**Login** action to complete the Agent's native authorization flow.

Codex Official uses the built-in ChatGPT OAuth route (`model_provider =
"openai"`). If Codex reports `token_revoked` or
`refresh_token_invalidated`, the server-side session has ended; run `codex
logout` and then `codex login` in the same `CODEX_HOME` used by the command.
Orca terminals and pai-switch intentionally use separate Codex homes, so
re-authenticate each home if both paths are needed:

```bash
# Orca terminal (uses the current Orca CODEX_HOME)
codex logout
codex login

# pai-switch's normal desktop-managed home
CODEX_HOME="$HOME/.codex" codex logout
CODEX_HOME="$HOME/.codex" codex login
```

This does not touch `auth.json.key.mega`; Mega remains an API-key Profile
loaded from its own file.

If Codex reports `provider auth cannot be combined with
requires_openai_auth`, the error is in the base `config.toml`, not in the
selected `official` profile. Codex validates that base file before applying
`-p`. Repair each home once, then retry the unchanged native commands:

```bash
# Normal pai-switch home
env -u CODEX_HOME codex-switch repair

# The current Orca home (preserves its own key-file paths)
CODEX_HOME="${CODEX_HOME}" codex-switch repair

codex -p official
codex -p mega
```

The repair only removes invalid Provider field combinations and rewrites
managed `auth.json.key.*` paths to the active `CODEX_HOME`; it never replaces
the OAuth `auth.json` with a Mega key. If Official then returns
`token_revoked` or `refresh_token_invalidated`, re-authenticate that same home
with `codex logout` followed by `codex login`.

## Availability checks

**Check availability** is not a static completeness check. For API-key Profiles,
the app sends a minimal authenticated model request using that Profile's current
Endpoint, the provider API model ID, and Credential. The provider API model ID
may differ from the native CLI model name; for example, Claude's local
`deepseek-v4-pro[1m]` is probed as `deepseek-v4-pro`. A Profile is marked
available only when that request succeeds. The result includes latency, check
time, HTTP status, and an actionable provider error when available. Each check
may consume a very small number of model tokens. Missing credentials or models
are reported as a precondition that prevented the check from running.

## Managed files

The adapters intentionally touch only the native files required by each
agent, including `~/.claude/settings.json`, `~/.codex/config.toml`,
`~/.gemini/antigravity-cli/settings.json`, and `~/.grok/config.toml`. App-owned
state, snapshots, and the encrypted credential vault live under Electron's
`userData` directory.

See [AGENT_SWITCH_SPEC.md](./AGENT_SWITCH_SPEC.md) for native format details
and [ELECTRON_APP_DESIGN.md](./ELECTRON_APP_DESIGN.md) for the architecture.

The current desktop stack is Electron + React 19 with Zustand. An evidence-
based comparison of Agent platforms (including React, Tauri, and VS Code
WebView implementations) is maintained in
[AGENT_PLATFORM_TECH_RESEARCH.md](./AGENT_PLATFORM_TECH_RESEARCH.md).
