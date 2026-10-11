# Shep reference

**Applies to:** Shep 0.4.0-checkpoint.9.5.

See the [README](../README.md) for installation and first use, or the [operating procedure](SOP.md) for the daily workflow. This reference covers controls, status and metadata behavior, local data, and development.

- [Command options](#command-options)
- [Terminal controls](#terminal-controls)
- [Statuses and session scope](#what-the-statuses-mean)
- [Agent age](#agent-age)
- [Model and reasoning effort](#model-and-reasoning-effort)
- [Optional Herdr plugin shortcut](#optional-herdr-plugin-shortcut)
- [Dispatch and close behavior](#dispatch-and-close-behavior)
- [Local data and privacy](#local-data-and-privacy)
- [Update or uninstall](#update-or-uninstall)
- [Development](#development)
- [Herdr integration references](#herdr-integration-references)

## Command options

| Command | Behavior |
| --- | --- |
| `shep` | Interactive Ink orchestrator and read-only browser companion |
| `shep-run` | Alias for `shep` |
| `shep --web` | Browser companion only; keep this process running in Herdr |
| `shep --port 4319` | Use a different localhost port |
| `shep --demo --port 4318` | Show sample agents with dispatch/focus/close disabled |
| `shep --help` | Show command help |
| `shep --version` | Show the installed version |

`SHEP_PORT` sets the default port; `--port` overrides it. `NO_COLOR=1 shep` disables terminal colors. `--terminal` explicitly selects the default terminal view. Redirected/noninteractive output uses a plain read-only board; orchestration requires an interactive terminal.

For browser setup and sample-data previews, see the [browser workflow](SOP.md#11-use-the-browser-companion-or-demo).

## Terminal controls

| Key | Action |
| --- | --- |
| `↑` / `↓` or `k` / `j` | Select an agent |
| `Enter` | Focus the selected agent in its existing Herdr pane |
| `/` | Enter `/dispatch [provider][@project][:] your task`; press Enter to launch |
| `g` | Switch Tasks / Agents |
| `d` / `→` | Open selected task or agent details; use Up/Down to scroll |
| `i` | Read the full notice, including long diagnostic paths |
| `n` | New agent: choose provider, project, name and task |
| `Tab` / `Shift+Tab` | Move between composer fields; accept / cycle command suggestions |
| `↑` / `↓` in command input | Choose visible suggestions; otherwise recall commands |
| `Enter` in command input | Accept after an arrow selection; otherwise dispatch |
| `←` / `→` | Change the selected composer option |
| `Ctrl+S` | Submit the composer or send the follow-up once |
| `s` | Search agents and workspaces |
| `f` | Cycle status filters |
| `p` | Open a follow-up editor for the selected task or agent |
| `e` | Rename the selected agent; Enter saves, Esc cancels |
| `c` / `C` | Clear the selected closed/failed task / all eligible closed and failed tasks |
| `x` | Confirm closing the selected agent |
| `Esc` | Cancel or leave the current editor/dialog |
| `r` | Refresh the overview |
| `Ctrl+R` | Reload configuration, providers and projects |
| `q` | Quit outside editors |
| `Ctrl+C` | Quit Shep; leave agents running |

Pasted multiline prompts remain prompt text rather than keyboard shortcuts. Mouse support uses the terminal’s SGR mouse protocol; keyboard controls are always available. When focus moves to an agent, use Herdr’s pane navigation to return to Shep.

## What the statuses mean

The terminal uses **Starting**, **Working**, **Needs you**, **Done**, **Failed** and briefly **Closed**. Needs you covers a reported block, startup input or uncertain delivery. Failed means the agent could not start, with a short reason. Unknown native status displays Starting. A startup agent that is idle without observed work/completion shows Needs you; after observed work, idle displays Done. Done does not prove your specific task succeeded. A later observed Working or Done state replaces an earlier attention outcome.

Status accuracy follows Herdr's detectors. The read-only browser retains its native Working, Needs input, Done, Idle and Unknown labels. Names lead each row, with Needs you first within its group, bright Working and muted Done. Attention also has a text marker under NO_COLOR. Rows show a short differing folder, not a repeated absolute path; task details retain full paths and dimmed IDs. Reading the overview does not mark work seen; focusing an agent does. If Herdr becomes unavailable, retained data is marked stale and controls are disabled.

The scope is **one current Herdr instance**. Agents in other instances, other terminal applications, remote machines, or internal subagents that Herdr does not expose are not shown. Startup requires the host-provided socket and pane context; there is no manual session selector. `--session` is rejected and `SHEP_SESSION` is ignored.

### Agent age

The terminal age column shows how long the agent's current process has been running: `<1m`, minutes (`16m`), hours (`2h`) or days (`3d`). It appears alongside the folder. Details show a fuller duration and local start time, such as “Running for 2h 14m (since 20:57)”; durations with days also include the local start date. For a resumed session (`codex resume`), this is the running process's age, not the conversation's age.

Age works for Shep launches, agents started elsewhere in the current Herdr instance, and agents still running after Shep restarts. Shep matches exactly one foreground process whose parent is the pane's shell, using only process IDs and elapsed times. An exited helper omitted from `ps` does not hide a surviving direct child. A missing candidate, ambiguous matches or unreadable process information leaves the age blank; a Starting task without a detected agent process has no age. Checks run at most once every 30 seconds per agent, so process changes can take that long to appear. Cached start times drive the age on each render. Known ages survive STALE snapshots for unchanged agent identities; checks pause until reconnection. Age stays in terminal memory and never enters the browser, `/api/snapshot` or files; Shep does not inspect process command lines for this feature.

### Model and reasoning effort

For **Claude, Grok and verified Codex sessions**, terminal rows align name, status, provider, model, effort, age and folder in columns. Missing values leave an empty cell so later columns stay aligned. Claude names are shortened consistently, such as `opus 5.5` or `fable 5.1`; details show the full model ID and effort. At 110 columns or wider the list always gets 70% of the pane, so model fields appearing do not move the divider. Column gaps grow with the list's width. Narrow panes drop effort, model, age and folder in that order, preserving names and statuses. Missing data adds no placeholder. The read-only browser and `/api/snapshot` do not receive these fields.

Claude and Grok need the provider's Herdr integration and a session ID reported by an agent started **after** installation. Install the appropriate integration yourself:

```sh
herdr integration install claude
herdr integration install grok
```

**Codex:** Shep verifies the pane's foreground Codex process and reads its uniquely owned root session log. The latest `turn_context` supplies model and effort. This works for standalone sessions, including sessions started with `codex --no-daemon`. For shared-server clients, Shep matches the foreground process’s local listening endpoint to exactly one loaded root session and reads its live model and effort from the existing server. Herdr's Codex hook IDs remain untrusted: a shared app-server can report an ID to the wrong pane. Shep never guesses from folders, process arguments or configuration defaults, and does not restart agents or change their configuration.

For Claude and Grok, the terminal reads at most the last **64 KiB** of the exact session's local log: `~/.claude/projects/*/<session-id>.jsonl` (assistant `message.model` and `effort`), or `~/.grok/sessions/*/<session-id>/chat_history.jsonl` (assistant `model_id` and `reasoning_effort`). It extracts only those fields and caches them with file identity, size and modification time, refreshing at most every ten seconds. The resolved session path is reused while safe and unchanged. Malformed or partial lines are skipped; when the same file grows beyond a complete readable assistant record, its last verified values remain steady. Replacement, unreadable or unsafe files do not inherit them. Values describe the most recently read authoritative response; an unrecorded model selection cannot appear yet. Shep does not retain conversation text or write to provider folders. Invalid IDs, unsafe symlinks, ambiguous matches and logs without verified fields show nothing.

Codex lookup requires `ps` and `lsof` and projects process IDs, parent IDs, executable names, open-file paths and local listening endpoints. It validates a regular session log under `~/.codex/sessions/YYYY/MM/DD/`, reads at most 64 KiB from its head to verify the root session identity, then scans backward in 64 KiB chunks through at most the last 32 MiB for the latest recorded model and effort. Shared clients use the existing local WebSocket control socket with read-only session and endpoint queries. Subagents, multiple roots, incomplete server responses, changed listeners, unsafe paths and changed processes leave the fields blank. The lookup never starts or resumes a session, sends a turn, or calls a tool. Checks refresh at most every ten seconds. Only model and effort enter terminal state; no process paths or conversation text are retained there. Known fields survive STALE for unchanged pane/terminal identities while reads pause.

## Optional Herdr plugin shortcut

You can also register the installed app as a Herdr plugin that opens a new split pane:

```sh
herdr plugin link "$HOME/.local/lib/node_modules/shep-herdr-plugin"
herdr plugin pane open --plugin shep --entrypoint board --direction right --no-focus
```

The new pane is labeled **🐕 Shep**. The plugin and the `shep` command use the same application. Stop an existing Shep instance first, or give the new one another port:

```sh
herdr plugin pane open --plugin shep --entrypoint board --direction right --no-focus --env SHEP_PORT=4319
```

The plugin shortcut is optional. Typing `shep` in an existing pane is enough to use the app.

## Dispatch and close behavior

Agent availability means the command is installed, not that it is authenticated or ready. Shep starts tools through Herdr’s supported agent interface. If startup or prompt delivery times out, the created pane is preserved and the result explains what is known; Shep never retries a prompt automatically. Focus the pane to inspect a login, trust prompt, question, or uncertain submission before sending anything again.

Controls are disabled when the view is stale/disconnected or showing demo data. Every mutation also refreshes the current session and target identity. Closing requires confirmation and rejects a changed target/status, including an agent that started working after you opened the dialog. Shep protects its own pane. Herdr 0.9.1 does not provide an atomic identity-conditional close, so a small interval remains between the final identity check and the close request.

## Local data and privacy

Shep reads agent identity, status, pane/workspace metadata, and working directories through `herdr api snapshot`, and uses local Git metadata for project discovery, placement and change summaries. Task records, command recall and drafts stay in memory; this checkpoint does not create or read a history file. Repository trust confirmations are saved in Shep's local config. Shep does not collect credentials or transmit data to a hosted service of its own. On dispatch, your selected agent receives the prompt and applies its own data and provider settings.

The read-only `/api/snapshot` endpoint publishes ordinary Herdr metadata, which may include task-derived agent names, tab/workspace labels and paths. It never includes task records, prompts, expanded templates, history, launch arguments or config. Names and labels summarize tasks, so avoid putting secrets into task titles. Native Herdr and agent tools retain their own data according to their settings.

The browser server binds to `127.0.0.1` and serves only the dashboard assets and the snapshot endpoint. Other local processes and users with access to your machine may be able to read this dashboard. Host/Origin checks restrict browser requests; the Herdr environment check is host integration, not authentication against deliberately forged environment variables.

## Update or uninstall

To update, stop Shep, pull the latest source, then repeat the [package/install commands](../README.md#installation). Reopen it with `shep`. Source edits do not change an already installed copy. If the plugin manifest changed, repeat the optional `herdr plugin link` command.

To uninstall, first stop Shep. If you registered the optional plugin, remove its registration:

```sh
herdr plugin unlink shep
```

Then remove the installed commands and application:

```sh
npm uninstall --global --prefix "$HOME/.local" shep-herdr-plugin
```

Your agents, Herdr sessions, and source checkout remain intact.

## Development

Install the locked development/runtime dependencies, then run the checks. There is no transpilation build step:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

The tests use Node's built-in test runner, controlled Herdr fixtures, temporary localhost servers, and Python 3 for installed-package terminal checks. They cover literal prompt delivery, provider routing, keyboard/mouse controls, close confirmation, current-instance validation, uncertain outcomes, shutdown, package installation, stale recovery, and HTTP boundaries. Tests do not need a running Herdr session.

To run from source inside Herdr:

```sh
npm start         # Ink orchestrator and browser companion
npm run demo     # Browser demo at localhost:4318
```

Optional browser checks need a separately installed Playwright with Chromium. An axe module enables the accessibility scan:

```sh
SHEP_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
SHEP_AXE_MODULE=/absolute/path/to/@axe-core/playwright/dist/index.mjs \
node scripts/verify-ui.mjs
```

The browser runner starts and stops its own controlled test server. Set `SHEP_LIVE_URL=http://localhost:4317` to check an already-running live app instead. `scripts/preview-terminal.mjs` renders the sample terminal preview using the same optional Playwright setup. Browser tooling is not included in the installed app.

| Location | Purpose |
| --- | --- |
| `bin/` | Installed command entrypoint |
| `src/` | Ink components, native agent controls, CLI, polling, plain terminal fallback, and HTTP server |
| `public/` | Browser dashboard and shepherd-dog icon |
| `tests/` | Automated tests and controlled sample fixtures |
| `scripts/` | Syntax and optional visual checks |
| `docs/images/` | Sample dashboard previews |
| `herdr-plugin.toml` | Optional Herdr plugin entrypoint |

## Herdr integration references

- [Plugin interface](https://herdr.dev/docs/plugins/)
- [Socket API](https://herdr.dev/docs/socket-api/)
- [Agent detection](https://herdr.dev/docs/agents/)
- [CLI reference](https://herdr.dev/docs/cli-reference/)
