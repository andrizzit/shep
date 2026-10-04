<p align="center">
  <img src="public/favicon.svg" width="72" height="72" alt="Shep shepherd dog logo">
</p>

<h1 align="center">Shep</h1>
<p align="center"><strong>Your agents, together.</strong></p>

Shep is an [Ink](https://github.com/vadimdemedes/ink) terminal interface for dispatching and managing coding agents inside [Herdr](https://herdr.dev/). Run `shep`, then type `/dispatch claude@folio: add unit tests` to choose an agent, project and task. Follow tasks by project or agents by provider, see who needs input, and focus or close agent panes from the same interface.

This branch provides **0.4.0-checkpoint.9.4**, a local, unpublished preview of project-aware dispatch with a live agent dock. Fan-out, templates, named profiles, persisted task history, worktree cleanup controls and additional shell subcommands are deferred.

Keep it beside your chat in a terminal pane, or open its browser companion at **http://localhost:4317**. Both views show agent metadata from your current Herdr instance; the task board stays private to the terminal interface.

For the full daily workflow, read the [Shep operating procedure](docs/SOP.md): dispatch, monitoring, follow-ups, closing agents, recovery, and updates.

![Shep browser dashboard showing grouped agents and workspace details with sample data](docs/images/shep-desktop.png)

*Preview uses clearly labeled sample agents. Shep reads live status from Herdr when you run it normally.*

## What Shep does

- Dispatches a literal prompt into its own Herdr tab, reusing the project's workspace or creating one.
- Opens in the project’s main folder by default. Use `+wt` for a separate Git worktree, with a placement preview and notice.
- Offers a project picker, command suggestions and command recall for the current run.
- Groups tasks by project, shows Git change summaries and sends Herdr notifications when a task finishes or needs input.
- Groups agents by provider, including Claude, Codex, Grok, Kiro, and additional types reported by Herdr.
- Shows the session's recorded model and reasoning effort for linked Claude and Grok agents in the terminal.
- Lets you select agents with arrow keys or a mouse, rename them, focus their real panes, send follow-ups and confirm closing them.
- Docks the selected agent's real Herdr pane beside the list when there is room for at least 60 columns of Shep and 80 columns of agent terminal, then returns it to its original location when you switch or quit.
- Hides confirmed closed task rows after about five seconds; clears failed rows on request without removing panes, files or worktrees.
- Shows Starting, Working, Needs you, Done, Failed and briefly Closed in the terminal; the browser retains Herdr's native statuses.
- Displays each agent's workspace and working directory across the current Herdr session.
- Supports search and keyboard navigation in the terminal, plus search and status filters in the browser companion.
- Brings a small pixel-art shepherd dog to the terminal header, with a compact mark in narrow panes.
- Refreshes about every two seconds and marks retained data as stale if the connection drops.
- Runs locally without a model account or cloud service of its own. Each agent uses its existing installation and authentication.

Shep is a coordinator, not another AI model. It sends the prompt you write to the tool you select, while Herdr owns the agent process and status. It does not automatically approve trust dialogs or questions, rewrite prompts, or replay an uncertain submission. The browser companion stays read-only.

## Requirements

| Requirement | Details |
| --- | --- |
| Herdr | Version 0.9.1 or newer, with a running session |
| Node.js | Version 22.23.2 or newer, with `node` and `npm` on your PATH |
| Operating system | macOS or Linux |
| Git | Needed for repository discovery, change summaries and worktree isolation |

Automated checks cover Node.js 22.23.2 and 26.7.0 on macOS; native integration targets Herdr 0.9.1. Linux has not been verified.

**Run Shep inside a Herdr pane.** It can start from any folder in that pane. A regular terminal outside Herdr cannot start the dashboard; `shep --help` and `shep --version` work anywhere.

## Installation

### 1. Get the source

```sh
git clone https://github.com/andrizzit/shep.git
cd shep
```

The public default branch may still be 0.3.0 while this preview is unpushed. To build the checkpoint, use its reviewed `feat/smart-dispatch` checkout or the supplied checkpoint tarball; do not expect a fresh clone to contain local work.

### 2. Build and install the local package

```sh
npm ci --ignore-scripts
npm pack
npm install --global --prefix "$HOME/.local" ./shep-herdr-plugin-0.4.0-checkpoint.9.4.tgz --offline --ignore-scripts --no-audit --no-fund
```

This installs the `shep` and `shep-run` commands into `$HOME/.local/bin`, and copies the app and browser assets into `$HOME/.local/lib/node_modules/shep-herdr-plugin`. The package's internal name is `shep-herdr-plugin`; the app and command are **Shep** and **`shep`**.

`npm ci` downloads the locked Ink/React dependencies when building from source. `npm pack` bundles the runtime dependencies, so installing the resulting tarball works offline. The installed app is a copy: it does not depend on the source checkout remaining in its original location. No npm registry release is published; use the package built from this repository.

### 3. Make the commands available

If `$HOME/.local/bin` is not already on your PATH, run:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Add that same line to your shell configuration to keep it for future terminals: `~/.zshrc` for zsh or `~/.bashrc` for bash. Verify the installation:

```sh
shep --version
```

## Run, close, and reopen

In any Herdr pane, from any folder:

```sh
shep
```

`shep-run` is an equivalent command. Shep stays in the pane where you launch it, so run it in the pane on the right of your chat for a side-by-side view. It automatically connects to **that pane's current Herdr instance** and shows agents across all its workspaces.

Type a command in Shep and press **Enter**:

```text
/dispatch claude@folio: add unit tests for the ledger
/dispatch codex@shep: fix the settings page
/dispatch review the current changes
```

A clear prefix can omit the colon: `/dispatch claude@folio add unit tests`, `/dispatch @folio fix the title`, or `/dispatch claude review this`. A prefix without a colon requires a lowercase installed provider and/or a known project. Capitalized words, unavailable providers, unknown projects and file mentions such as `@src/app.ts` stay literal task text for **Codex**. A leading filename such as `codex.md`, `claude.md` or `pi.js` also stays literal unless its suffix names a configured profile or it uses explicit deferred syntax (`@`, a comma or `+wt`). Use `/dispatch codex: claude said X` when the task starts with a provider name. Colon forms keep their strict errors for unknown or unavailable providers and ambiguous projects. `+here` works with either form; profiles and fan-out remain deferred and are refused before launch; `+wt` requests a worktree.

To request a project subfolder, press **n**, choose the project, and enter a relative path such as `src/api` in **Subfolder**. Command prefixes accept project names or aliases, not subfolder paths. Suggestions appear in a vertical list below the command line, with fewer visible rows in compact panes. Click a row to accept it. **↑/↓** move through visible suggestions and wrap; **Enter** accepts a suggestion only after an arrow moved the highlight. Otherwise Enter submits. **Tab** accepts and **Shift+Tab** cycles suggestions. Without suggestions, arrows recall commands from this run; **Esc** restores the displaced draft.

Press **n New agent** (or **n New** in a narrow pane) for the composer: provider, project or **Other folder…**, subfolder, optional name and multiline prompt. When the provider field is focused, its vertical list shows installed agents. **↑/↓** or **←/→** change the selection; **Enter** or **Tab** moves to the next field. The Default toolbar shows the current composer provider; entering a slash command shows its Codex default. Review the proposed location before dispatch. Herdr starts a worktree at its repository root; when a requested subfolder cannot apply, Shep shows that notice before launch.

Dispatches use the project's main folder even when another agent is working there. Coordinate edits in a shared checkout. Use `/dispatch codex@shep+wt: your task` to create a worktree; a project configured with `isolation: "always"` also forces one. `+here` selects the main folder unless that project setting forces worktrees. A worktree's detail shows its path and manual removal command, `herdr worktree remove --workspace <id>`. Preserve changes before removing it. **W** cleanup, fan-out, named profiles and templates remain deferred.

For Claude, Codex and Grok, Shep gives eligible tasks to the agent **when it starts**, as one literal argument. Other agents, tasks beginning with `-`, one-word tasks, and tasks containing newlines or tabs use the existing typed path. Shep chooses once before launch and never retries or switches delivery after a failure. **Startup tasks appear in the local process list, visible to processes running as the same user.**

After you submit, Shep returns to the board with the new task selected as **Starting** while startup continues. You can launch another task straight away. **Enter** opens the new agent once its pane is available. A late startup result updates its row without moving you out of another task or editor. The double-Enter guard prevents a single submission from starting two agents.

If an agent needs setup or a prompt isn't picked up, the terminal shows **Needs you** and sends one attention notification under your existing settings. Open the pane and answer the provider's own dialog. With startup delivery Shep includes the task in the start arguments and does not retype it after a dialog. An uncertain result does not confirm receipt; inspect the pane before manually sending anything. Herdr can report idle while a trust screen is visible. For startup delivery, an agent that is idle before Shep has observed any work or completion shows **Needs you**; if that lasts about five seconds, Shep sends one attention notification. A very fast reply can also show Needs you if its activity was missed. Open the pane to check. On the typed path, startup screens can still receive or lose input; keep CLIs signed in and updated. Shep never parses screens, approves dialogs or resends an uncertain task.

If startup times out while the agent is still working, Shep restores a missing managed name once after verifying the original pane, terminal and provider. The task then keeps tracking the agent and its completion. A different name or changed identity stays uncertain; the task is never resent.

Startup-path Needs you clears the submitted draft; the typed path keeps unsent text. Saved command recall can recover a failed launch’s original command.

Press **g** to switch between Tasks grouped by project and Agents grouped by provider. Tasks and drafts last only for this run. After restarting, still-running agents appear in the Agents view.

When Shep's pane has room for at least 60 columns of Shep and 80 columns of agent terminal, use **↑/↓** or click a row and pause for about 400 ms. Shep moves that agent's actual Herdr pane into a dock on the right while keeping keyboard focus on Shep. The agent gets about 65% of that space; Shep uses its compact list layout on the left when needed. The details panel gives way to the list and a one-line selected-agent header. **Enter** focuses the docked pane so you can type, scroll, and answer dialogs there. With Herdr's default keys, press **Ctrl+B**, then **h** to return to Shep from the right pane; use your configured `focus_pane_left` binding if you changed it. When there is room for both agent panes during a switch, Shep brings the next pane in before returning the previous one; otherwise it returns the previous one first. **t** turns the dock off and shows details again; press **t** again to resume it. When the two minimum widths cannot fit, Shep keeps the prior layout and Enter behavior.

Shep keeps a labeled placeholder in the agent's original tab while its pane is docked and names that tab **`<agent name> · in Shep`**. The agent appears in Shep's tab during this time; press **t** to return it to its own tab and restore the original tab label. To keep the recovery marker small, Shep manages labels only when both the original and docked titles fit within 128 UTF-8 bytes; otherwise it leaves the origin title as it is and shows a warning. On a wide dock, switching agents places the next pane before returning the previous one, keeping Shep's width steady. On a normal quit, switch, toggle, or close, it returns the pane. Shep closes an idle placeholder; if someone is running a command there, it leaves the pane open, removes its marker, and shows a notice. If the original tab is gone, restoration creates a tab labeled with the agent's name. If Shep crashes, the next startup checks for that marker and restores the agent when its identity is still certain; otherwise it shows a notice so you can inspect Herdr. If a dock ends uncertain and Shep confirms the agent remains beside it, Shep sends one Herdr notification with the request sound, warning you to keep Shep's tab open; inspect the panes before closing that tab. The dock does not close, restart, or type into an agent. **x** opens a close confirmation after returning a docked agent; closing still ends that pane's process only after you confirm. **Quit Shep with q before closing this tab — closing the tab also closes the docked agent.** A SIGHUP from closing only Shep's pane attempts one restore before exit.

Press **e Rename** on a selected agent in either Tasks or Agents. The one-line editor starts with its current name, or is empty for an unnamed agent. Use **Enter** to rename or **Esc** to cancel. Names start with `a`–`z`, then use `a`–`z`, `0`–`9`, `_` or `-`, up to 32 characters; invalid names are refused inline. Agents opened outside Shep can be renamed too. Shep verifies the pane, terminal and provider before sending the rename once, and checks the result afterwards. Its own pane, stale/demo data and agents still starting stay protected. Renaming a tracked task keeps its agent attached.

Press **p** on a task or agent to write a follow-up. The editor shows its identity and status; paste or type multiple lines, use **Ctrl+S** to send once, or **Esc** to keep that agent's draft. Agents waiting for input must be answered in their own panes. An uncertain follow-up is never resent automatically; inspect the pane before sending again. Follow-ups do not wait for activity, and a submitted result is not proof the agent executed the text.

Press **c** to clear the selected closed or failed task, or **C** to clear eligible closed and failed tasks. Confirmed closed rows also disappear after about five seconds. An open detected agent must be closed separately with **x** first. If a failed task retains a pane without a detected agent, close the identified pane in Herdr, then clear the task. Clearing only hides task rows and releases their local reservations; it does not remove worktrees or Git branches.

While Shep is running, open [localhost:4317](http://localhost:4317) for the read-only browser dashboard. Quitting Shep also stops that browser server.

- **Close:** press `q` outside editors, or press `Ctrl+C` at any time.
- **Reopen:** run `shep` again in the pane.
- **Agents:** continue running when Shep closes.

### Enable project discovery

Open `~/.config/shep/config.json` (or `$XDG_CONFIG_HOME/shep/config.json`) and add a projects section. For example, this is a complete one-line config for projects in `~/Documents/DevLearning/GitProjects`:

```json
{"projects":{"roots":["~/Documents/DevLearning/GitProjects"]}}
```

If the file already contains settings, merge this section into it instead of replacing the file. Restart Shep or reload configuration from the composer. Discovery roots default to empty. Open workspaces also contribute projects; the picker offers **Other folder…** for an existing folder outside your registered projects. Configured roots are scanned with bounds, not recursively without limit.

Shep only persists a configuration change when you explicitly confirm trust for an exact repository. It grants no blanket repository trust and adds no handling for agent trust dialogs. To turn off notifications, add `"notifications":{"enabled":false}` to your config; `"sound":false` keeps them silent. Notifications cover Shep tasks by default and suppress alerts for an agent you are already viewing.

![Shep terminal board with sample agents](docs/images/shep-terminal.png)

*Terminal preview rendered by the actual Ink components with sample data. Colors and glyph appearance depend on your terminal.*

### Command options

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

### Terminal controls

| Key | Action |
| --- | --- |
| `↑` / `↓` or `k` / `j` | Select an agent |
| `Enter` | Focus the docked agent, or the selected agent in a narrow tab or with the dock off |
| `t` | Toggle the live dock and details panel in a wide tab |
| `Ctrl+B`, then `h` | Return from a right dock to Shep with Herdr's default pane navigation |
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

### Model and reasoning effort

For **Claude and Grok**, terminal rows align name, status, provider, model, effort and folder or age in columns. Missing values leave an empty cell so later columns stay aligned. Claude names are shortened consistently, such as `opus 5.5` or `fable 5.1`; details show the full model ID and effort. At 110 columns or wider the list always gets 70% of the pane, so model fields appearing do not move the divider. Column gaps grow with the list's width. Narrow panes drop effort and model first, then folder or age, preserving names and statuses. Missing data adds no placeholder. The read-only browser and `/api/snapshot` do not receive these fields.

This needs the provider's Herdr integration and a session ID reported by an agent started **after** installation. Install the appropriate integration yourself:

```sh
herdr integration install claude
herdr integration install grok
```

**Codex model and effort are not shown:** Herdr's current Codex integration runs hooks in a shared `codex app-server`, whose environment can report session IDs to the wrong pane. Shep ignores Codex session IDs for identity and model lookup until [Herdr](https://herdr.dev/) fixes the integration. Codex dispatch and monitoring still work. Re-check the integration after a Codex or Herdr update; Shep never guesses a session from its folder or configuration defaults.

The terminal reads at most the last **64 KiB** of the exact session's local log: `~/.claude/projects/*/<session-id>.jsonl` (assistant `message.model` and `effort`), or `~/.grok/sessions/*/<session-id>/chat_history.jsonl` (assistant `model_id` and `reasoning_effort`). It extracts only those fields and caches them with file identity, size and modification time, refreshing at most every ten seconds. The resolved session path is reused while safe and unchanged. Malformed or partial lines are skipped; when the same file grows beyond a complete readable assistant record, its last verified values remain steady. Replacement, unreadable or unsafe files do not inherit them. Values describe the most recently read authoritative response; an unrecorded model selection cannot appear yet. Shep does not retain conversation text or write to provider folders. Invalid IDs, unsafe symlinks, ambiguous matches and logs without verified fields show nothing.

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

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `shep: command not found` | Check that `$HOME/.local/bin` is on PATH. Try `$HOME/.local/bin/shep --version`, then open a fresh shell if needed. |
| “Shep runs only inside Herdr” | Open a shell pane inside Herdr and run `shep` there. A regular terminal is not enough, even if Herdr is running elsewhere. |
| Current pane/session is unavailable | Quit and reopen Shep from a current Herdr pane. It checks the pane, tab, workspace, and socket supplied by the host before starting. |
| Port 4317 is already in use | Stop the other Shep instance or run `shep --port 4319`; then visit localhost:4319. |
| No agents found | Start a supported agent inside the same Herdr instance. Empty provider groups are expected until matching agents exist. |
| Connection interrupted / stale data | Check that Herdr is running, then press `r` or use the browser's Retry button. Polling retries automatically. |
| Browser stops responding after quitting | The browser server belongs to the Shep process. Run `shep` again to reopen it. |

## Dispatch and close behavior

Agent availability means the command is installed, not that it is authenticated or ready. Shep starts tools through Herdr’s supported agent interface. If startup or prompt delivery times out, the created pane is preserved and the result explains what is known; Shep never retries a prompt automatically. Focus the pane to inspect a login, trust prompt, question, or uncertain submission before sending anything again.

Controls are disabled when the view is stale/disconnected or showing demo data. Every mutation also refreshes the current session and target identity. Closing requires confirmation and rejects a changed target/status, including an agent that started working after you opened the dialog. Shep protects its own pane. Herdr 0.9.1 does not provide an atomic identity-conditional close, so a small interval remains between the final identity check and the close request.

## Local data and privacy

Shep reads agent identity, status, pane/workspace metadata, and working directories through `herdr api snapshot`, and uses local Git metadata for project discovery, placement and change summaries. Task records, command recall and drafts stay in memory; this checkpoint does not create or read a history file. Repository trust confirmations are saved in Shep's local config. Shep does not collect credentials or transmit data to a hosted service of its own. On dispatch, your selected agent receives the prompt and applies its own data and provider settings.

The read-only `/api/snapshot` endpoint publishes ordinary Herdr metadata, which may include task-derived agent names, tab/workspace labels and paths. It never includes task records, prompts, expanded templates, history, launch arguments or config. Names and labels summarize tasks, so avoid putting secrets into task titles. Native Herdr and agent tools retain their own data according to their settings.

The browser server binds to `127.0.0.1` and serves only the dashboard assets and the snapshot endpoint. Other local processes and users with access to your machine may be able to read this dashboard. Host/Origin checks restrict browser requests; the Herdr environment check is host integration, not authentication against deliberately forged environment variables.

## Update or uninstall

To update, stop Shep, pull the latest source, then repeat the package/install commands from the installation section. Reopen it with `shep`. Source edits do not change an already installed copy. If the plugin manifest changed, repeat the optional `herdr plugin link` command.

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

## License

Shep is available under the [MIT License](LICENSE). You can use, modify, and redistribute it, including commercially, under that license's terms.
