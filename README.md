<p align="center">
  <img src="public/favicon.svg" width="72" height="72" alt="Shep shepherd dog logo">
</p>

<h1 align="center">Shep</h1>
<p align="center"><strong>Your agents, together.</strong></p>

Shep is a terminal dashboard for dispatching and managing coding agents inside [Herdr](https://herdr.dev/). Start a task, see who is working or needs input, and open the agent's pane from one overview.

It runs locally and uses your existing agent installations and authentication. A read-only browser companion is available at [localhost:4317](http://localhost:4317) while Shep is running.

![Shep browser companion showing sample agents](docs/images/shep-desktop.png)

*Browser preview uses clearly labeled sample agents. Shep reads live status from Herdr when you run it normally.*

## What you get

- Dispatch to Claude, Codex, Grok, Kiro and other agents supported by Herdr.
- Group tasks by project or agents by provider, with search and status filters.
- See running age, folder, and verified model and reasoning effort for supported sessions.
- Choose projects and subfolders; request a Git worktree for isolated changes.
- Receive completion and attention notifications, and inspect Git change summaries.
- Open agent panes, send follow-ups, rename agents and confirm closing them.

The current version, **0.4.0-checkpoint.9.5**, is a project-aware dispatch preview. Fan-out, templates, named profiles, persisted task history and automatic worktree cleanup are deferred.

## Requirements

| Requirement | Version or setup |
| --- | --- |
| Herdr | 0.9.1 or newer, with a running session |
| Node.js | 22.23.2 or newer, with `node` and `npm` on PATH |
| Git | For project discovery, change summaries and worktrees |
| Agent tools | Install and authenticate each provider you want to use |

Automated checks cover Node.js 22.23.2 and 26.7.0 on macOS; native integration targets Herdr 0.9.1. Linux has not been verified.

**Launch Shep from a shell pane inside Herdr.** It connects to that pane's current Herdr instance and shows agents across its workspaces. `shep --help` and `shep --version` also work outside Herdr.

## Installation

Build from the default `main` branch:

```sh
git clone https://github.com/andrizzit/shep.git
cd shep
npm ci --ignore-scripts
npm pack
npm install --global --prefix "$HOME/.local" ./shep-herdr-plugin-0.4.0-checkpoint.9.5.tgz --offline --ignore-scripts --no-audit --no-fund
```

`npm ci` downloads the locked dependencies; `npm pack` bundles the runtime dependencies for offline installation. No npm registry release is published.

This installs `shep` and its alias `shep-run` into `$HOME/.local/bin`. The installed app is a copy and works independently of the source checkout.

If needed, add the command directory to PATH:

```sh
export PATH="$HOME/.local/bin:$PATH"
shep --version
```

Add the export line to `~/.zshrc` or `~/.bashrc` to keep it for future shells. To update, quit Shep, pull the latest source and repeat the build/install commands. For later versions, use the actual tarball name printed by `npm pack`.

## First task

In a Herdr shell pane, go to the folder where you want agents to work, then run:

```sh
shep
```

Check the working directory on the **Default** line. Type a command **inside Shep**, then press Enter:

```text
/dispatch codex: fix the settings page and add a regression test
/dispatch claude: review the current changes
```

Each dispatch starts a new agent in its own Herdr tab. Without an explicit provider, dispatch defaults to Codex. Press **n** for a composer with a provider picker, project, subfolder, optional name and multiline prompt; **Ctrl+S** submits it.

Single click or use arrows to select a row. **Double click or press Enter** to open its existing agent pane. Read output and answer provider dialogs there, then return through Herdr's pane or tab navigation.

For **Needs you**, open the pane and inspect the agent. Shep sends your literal task once and leaves trust or sign-in questions to you. If delivery is uncertain, inspect the pane before manually sending anything again.

### Add your projects

To discover projects under `~/Projects`, add this section to `~/.config/shep/config.json` (or `$XDG_CONFIG_HOME/shep/config.json`):

```json
{"projects":{"roots":["~/Projects"]}}
```

Create the containing folder if needed. Merge into an existing config rather than replacing other settings, then restart Shep. Open Herdr workspaces also contribute projects; the composer offers **Other folder…** for another existing directory.

Once a project is known, target it by name:

```text
/dispatch codex@shep: fix the settings page
/dispatch codex@shep+wt: fix the settings page in a worktree
```

Dispatch normally uses the project's main folder, so coordinate shared edits. `+wt` requests a separate Git worktree; review the placement preview before launching. Worktree cleanup is manual.

## Essential controls

| Key or action | Result |
| --- | --- |
| Single click / `↑` / `↓` | Select a row |
| Double click / `Enter` | Open the selected agent's pane |
| `/` / `n` | Enter a dispatch command / open the composer |
| `g` | Switch Tasks / Agents |
| `d` / `→` | Open details |
| `s` / `f` | Search / cycle status filters |
| `p` / `e` | Write a follow-up / rename the selected agent |
| `x` | Confirm closing the selected agent |
| `Esc` | Leave an editor or dialog |
| `q` / `Ctrl+C` | Quit Shep; agents keep running |

Use `q` from the overview; letters are ordinary text while editing. Tasks, drafts and command recall last for the current run. After reopening, still-running agents appear in the Agents view.

## Local data and privacy

Shep has no hosted service of its own. Your chosen agent receives the prompt and uses its own provider settings. The browser binds to `127.0.0.1` and exposes ordinary Herdr metadata, including names, labels and paths; avoid secrets in task titles.

Prompts, task records, model/effort and process ages stay out of the browser snapshot. Startup-delivered prompts can appear in the local process list. See the [privacy reference](docs/REFERENCE.md#local-data-and-privacy) for data boundaries and local access details.

## Documentation

- [Operating procedure](docs/SOP.md): daily workflow, dispatch syntax, follow-ups, recovery and troubleshooting.
- [Reference](docs/REFERENCE.md): all controls, model/effort lookup, agent age, privacy, optional plugin setup, uninstalling and development commands.

Shep is built with [Ink](https://github.com/vadimdemedes/ink) and available under the [MIT License](LICENSE).
