# Shep operating procedure

**Applies to:** Shep 0.4.0-checkpoint.1, the local project-aware dispatch preview inside Herdr.

**Scope:** Single-agent dispatch, project targeting, automatic placement, a task board, notifications and change summaries. Later fan-out, templates, named profiles, persisted history, in-Shep follow-ups and cleanup controls are deferred.

**Purpose:** Start coding agents, monitor their work, respond when they need input, review results, and close finished agent panes.

## 1. Know where to enter each command

| Location | What you enter | Example |
| --- | --- | --- |
| An ordinary shell prompt inside a Herdr pane | Commands that start or inspect the application | `shep`, `shep --version`, `herdr agent list` |
| The running Shep interface | Dispatch commands and Shep keyboard controls | `/dispatch claude: fix the ledger` |
| An individual agent's pane | Follow-up prompts, answers, and that agent's own commands | `Please add a regression test for that fix.` |
| Your assistant chat | Natural-language requests to use Herdr | `Use Herdr to inspect the agent that needs input.` |

**Type `/dispatch` inside Shep.** It is a command implemented by Shep. Installing the Herdr skill gives your assistant instructions for operating Herdr; it does not install Shep's command into other agents' input boxes or your shell.

If Shep is already visible in the pane to the right of your chat, click into that pane and continue with step 3. You do not need to launch a second copy.

## 2. Start Shep

1. Open an available shell pane inside Herdr. For a side-by-side workflow, use a pane beside your main chat.
2. Change to the project directory where new agents should work. Run `pwd` if you need to confirm the directory.
3. Start the application:

   ```sh
   shep
   ```

4. Confirm the header says **LIVE**.
5. Check the workspace and working directory on the **Default** line before launching a task.

`shep-run` is an equivalent launch command. Shep can start from any folder inside a Herdr pane; its initial task directory comes from the invoking pane. Starting it in a subdirectory can therefore make that subdirectory the initial task directory.

Shep shows agents across all workspaces in the current Herdr instance. It does not aggregate other Herdr instances, remote machines, unrelated terminals, or internal subagents that Herdr does not expose.

Use at least a 40-column by 15-row terminal pane. A larger pane is more comfortable for reading paths and viewing the selected agent beside the list.

**Expected result:** a live overview with Tasks/Agents views, a command input, and the correct default project directory.

### Configure projects once

Discovery roots start empty. Add this one-line config to `~/.config/shep/config.json` (or `$XDG_CONFIG_HOME/shep/config.json`) to discover projects under GitProjects:

```json
{"projects":{"roots":["~/Documents/DevLearning/GitProjects"]}}
```

Create the containing folder if needed. If a config already exists, merge the projects section rather than replacing other settings. Restart Shep or reload from its composer after editing. Shep also discovers projects from open workspaces. Use the project picker or **Other folder…** for an existing directory outside those sources. Shep does not write discovery roots on your behalf.

## 3. Dispatch a task

In Shep, type one command and press **Enter**:

```text
/dispatch claude@folio: fix the ledger
```

Other examples:

```text
/dispatch codex@shep: add a regression test for the settings page
/dispatch claude: review the current project
/dispatch fix the settings page
```

The syntax is:

```text
/dispatch [provider][@project[/subfolder]][+here]: task description
/dispatch task description
```

The brackets indicate an optional part; do not type the brackets.

| Command form | Selected provider |
| --- | --- |
| `/dispatch claude@folio: your task` | Claude in the folio project |
| `/dispatch codex@shep: your task` | Codex in the shep project |
| `/dispatch claude: your task` | Claude in the context project |
| `/dispatch kiro: your task` | Kiro, when installed |
| `/dispatch your task` | **Always Codex** |

The colon identifies an explicit provider. `/dispatch claude review this code` has no provider prefix, so it sends the entire text `claude review this code` to Codex. An unknown prefix such as `unknown-tool:` produces an error. An unavailable tool also produces an error; Shep does not substitute another provider.

When your task itself starts with a colon label, make the provider explicit to avoid ambiguity:

```text
/dispatch codex: Bug: saving settings resets the selected theme
```

Each accepted dispatch creates a **new agent in its own Herdr tab**, reusing the project's main workspace or creating a new workspace if none is open. Your Shep pane and focus stay in place. It does not send a follow-up to an existing agent.

When another agent is working in the same Git checkout, Shep uses a new worktree. Herdr starts a worktree's agent at its repository root. If you requested a subfolder, both the preview and a notice before launch explain that it will not apply. Inspect the actual working directory and branch in the task detail. Automatic placement relies on Herdr's current state; it is not a guarantee that another process will never edit the same files.

To deliberately share the main checkout, use `/dispatch codex@shep+here: your task`. The `+here` override skips automatic worktree isolation, so coordinate edits with the other agents. Forced worktrees (`+wt`), fan-out, named profiles and templates remain deferred.

If Git rejects a repository for dubious ownership, Shep can ask you to trust that exact canonical root. Cancel is the default. Confirmation is saved in Shep's config and applies only to that repository. Agent authentication and provider trust dialogs still require your attention in the created pane.

Shep starts the provider through Herdr, checks readiness, and submits the prompt. Wait for the result message before issuing another dispatch. Once submission completes, you can dispatch another task while the first agent continues working.

**Known sign-in limitation:** if an agent needs sign-in, Shep may submit the task into that screen, as 0.3.0 does. Complete sign-in before dispatching. If setup appears, inspect the created pane before sending anything again; successful submission does not prove the task was accepted. Shep does not add authentication handling or screen parsing.

**Expected result:** a submitted task with a pane ID in the Tasks view, plus the agent in its provider group. Submission confirms delivery; inspect subsequent status and output to confirm the agent actually worked on the task. Tab accepts a command/provider/project suggestion; Enter submits. Up/Down recalls single-line commands from this run.

## 4. Write a useful task

Include the outcome, relevant area of the project, constraints, and how the agent should verify its work. For example:

```text
/dispatch codex: Fix the settings page so the selected theme survives a reload. Follow the existing settings patterns, add a regression test, and report the files changed and test results.
```

For review work:

```text
/dispatch claude: Review the current ledger changes for correctness. Do not edit files. Report actionable findings with file locations and explain any remaining uncertainty.
```

Shep automatically isolates a Git checkout when another agent is working there. If several people or tools may edit files independently of Herdr's status, coordinate file ownership as well. A non-Git folder cannot gain Git worktree isolation.

## 5. Choose a project or write a longer prompt

1. Return to the overview with **Esc** if you are editing a command.
2. Press **n** to open setup and the optional composer.
3. Move between fields with **Tab** or **Shift+Tab**.
4. Select the provider and open the project picker. Filter the list, choose a project, or choose **Other folder…** and enter an existing absolute path.
5. Set an optional subfolder and task name. Check the placement preview and working directory.
6. Press **Esc** to retain your draft and return to the overview.

The composer offers one provider, project, optional subfolder/name, task and launch action. For a longer prompt, type or paste into the **Task** field. **Enter adds a newline there**; **Ctrl+S** submits the composer. You can also select its Dispatch button.

A custom agent name must be unique among live agents, begin with a lowercase letter, and use only lowercase letters, digits, `_`, or `-`, up to 32 characters. Leave it empty for an automatically generated name.

The provider chosen in the composer applies to composer launches. A slash command without a prefix still uses **Codex**. Generated names describe the task; an explicit `@project` targets that project. Nonempty configured default provider arguments require confirmation before first use; named profiles are not part of this checkpoint.

Settings and drafts last for the current Shep process. Esc keeps an unfinished draft; quitting Shep discards it. To resume a retained slash-command draft, click its command bar. Typing a new `/` from the overview starts a new command.

Prompts are limited to 64 KiB of UTF-8 text. Normal bracketed terminal paste preserves multiline prompt text and waits for an explicit submission.

## 6. Monitor progress

Press **g** to switch views. Tasks are grouped by project and show this run's dispatches, outcomes and changes. Agents are grouped by provider and include agents started outside Shep. Select a row, then press **d** or **Right** for details; use Up/Down to scroll and Esc to return. Use **n** to compose a new task; re-run shortcuts are deferred. Tasks are not restored after restarting; native agents remain visible in Agents.

| Status | Color | Meaning and next action |
| --- | --- | --- |
| Working | Yellow | Herdr detects active work. Let the agent continue or focus its pane to inspect progress. |
| Needs input | Red | Herdr detected a question, approval, or other blocked state. Focus the pane and read the request. |
| Done | Teal | Herdr reports completion that has not been marked seen. Inspect the result before closing. |
| Idle | Green | The agent is available for input. This alone does not prove your task succeeded. |
| Unknown | Gray | Herdr cannot confidently classify the state. Inspect the pane before deciding what to do. |

The overview refreshes roughly every two seconds. Press **r** from the overview to request a refresh. Shep displays Herdr's state; it does not independently judge whether a coding task is correct.

By default, Herdr notifies you when a Shep task finishes or needs input while you are viewing something else. Startup state is treated as a baseline, and an initially idle agent is not completion evidence. Notifications do not include unrelated external agents by default. Add `"notifications":{"enabled":false}` to your config to disable them, or `"notifications":{"sound":false}` for silent alerts. Configuration is never changed automatically.

Focusing an agent marks its completion seen, so **Done can become Idle**. Reading the overview does not do this. A Herdr client's own completion badge can also differ because clients track what has been viewed.

To find an agent:

1. Press **s** and enter an agent name, provider, pane ID, workspace name, or working-directory text.
2. Press **Enter** to return to the overview while keeping the search.
3. Press **f** from the overview to cycle status filters.
4. Press **Esc** from the overview to clear the search and filter.

While typing in a command, search, or prompt field, ordinary letters such as `q`, `x`, and `f` are text. Leave the editor before using overview shortcuts.

## 7. Open an agent and continue its work

1. Select an agent with **Up/Down**, **j/k**, or a mouse click.
2. Check its provider, workspace, and pane ID, especially when several jobs have similar names.
3. Press **Enter**, or click **Focus**, to move Herdr's focus to that agent.
4. Read its output and enter any follow-up directly into its own input.
5. Click the Shep pane or use your configured Herdr pane navigation to return.

A mouse click on an agent row selects it. The Focus action performs the actual pane switch.

To continue the same conversation, use the existing agent pane. Another `/dispatch` creates another agent.

## 8. Handle a question, authentication screen, or uncertain launch

For an agent marked **Needs input**, focus it, read the question, and answer through that provider's interface. Shep does not answer or approve dialogs automatically.

If dispatch reports **needs attention**, **startup could not be confirmed**, or **delivery could not be confirmed**:

1. Read the message and note the created pane ID, if one is available.
2. Use the **Focus pane** button, or **Ctrl+F** while the command/composer is open, to inspect the created agent.
3. If Herdr has not detected an agent yet, select the pane directly in Herdr.
4. Resolve any login, repository-trust, or startup question there.
5. Check whether the task already reached the agent before sending it again.
6. If the prompt was not sent, enter it directly in that existing agent once it is ready.

Shep preserves the pane and draft after a partial or uncertain launch. It does not automatically deliver the preserved draft after you resolve a dialog, and it blocks another launch until you acknowledge the previous outcome.

Use **Allow new launch**, or **Ctrl+Y** in the command/composer, only when you intend to allow another dispatch. This clears the launch hold; submitting again creates another agent. It does not resume or resend into the existing pane.

If pane creation itself was uncertain, inspect Herdr for an extra pane before retrying. A timeout is not proof that nothing happened.

## 9. Review and close a finished agent

1. Select the completed task to inspect its Git change summary, then focus its agent pane. The summary reports file/change counts and commits from the captured base where available; it is not a code review.
2. Read its final response, relevant changes, and test results.
3. Ask a follow-up in that pane if work remains.
4. Once you are finished with the agent, return to Shep and select it again.
5. Press **x**, or click **Close**.
6. Verify the confirmation shows the intended agent, pane, and terminal identity.
7. Press **y** or click **Close agent** to confirm. Press **Esc** to cancel. The initial keyboard choice is Cancel.
8. Confirm the agent disappears from Shep and its Herdr pane closes.

Closing ends the selected pane's process. The **x** action also works for agents that Shep did not launch, with the same identity checks and default-Cancel confirmation. It does not revert files, commit work, delete branches, or clean up worktrees. Keep any output you need before closing.

For a worktree created by the task, its detail view shows the full worktree path and the manual command `herdr worktree remove --workspace <id>` with the actual workspace ID. Review and preserve changes before running that command yourself. Shep does not run it for you. The **W** cleanup action is the first planned post-checkpoint item.

If the target or its status changed while the dialog was open, Shep can refuse the close. Cancel, inspect the current agent, and start a new confirmation. A Done or Idle status is a cue to review; Shep does not automatically close agents.

## 10. Stop and reopen Shep

To stop Shep, press **q** from the overview, or **Ctrl+C** in Shep at any time. When an editor is open, press Esc to return to the overview before using q.

Quitting stops the Shep interface and its localhost server. Existing agents continue running. During a pending launch, quitting stops Shep's local wait and prevents later launch/prompt steps; any pane already created remains available in Herdr.

Reopen from a shell inside Herdr:

```sh
shep
```

The new instance discovers the agents still running. Task records, command recall, prompt drafts, search state, and setup choices are not restored. This checkpoint neither reads nor writes a history file. Check the default directory again.

**Ctrl+C acts on the focused application.** Use it in the Shep pane when your intention is to stop Shep; in an agent pane it goes to that agent.

## 11. Use the browser companion or demo

While normal Shep is running, open [http://localhost:4317](http://localhost:4317). The browser offers a read-only view of the same snapshot, with search and filters. Agent dispatch, focus, and close are performed from the TUI.

The browser receives ordinary Herdr metadata, including task-derived names, labels and paths. It never receives task records, prompts, expanded templates, history, launch arguments or config. Avoid secrets in task titles. Agent tools and Herdr keep their own data according to their settings.

To serve only the browser dashboard, run this from a Herdr shell:

```sh
shep --web
```

To use another local port:

```sh
shep --port 4319
```

Then open `http://localhost:4319`. `SHEP_PORT` can also set the default port.

For a sample-data preview inside Herdr:

```sh
shep --demo --port 4318
```

Demo mode labels its sample agents and disables dispatch, focus, and close. Quitting a Shep process stops only the browser server associated with that process.

## 12. Use the Herdr skill from your chat

The installed Herdr skill lets a compatible assistant use Herdr's native commands when you explicitly request Herdr operations. For example:

- “Use Herdr to inspect the Claude agent that needs input.”
- “Use Herdr to read the finished ledger agent's result and summarize it.”
- “Use Herdr to start Codex in a sibling pane to review this change.”

The assistant must be running inside Herdr. The skill installation supplies operating instructions; Shep itself continues to run through the installed Herdr CLI. You can choose the Shep interface or an explicit chat request for a particular operation.

For direct diagnosis from another Herdr shell, these commands inspect current state:

```sh
herdr status
herdr agent list
```

To inspect one agent, replace the example name with a unique live name or a pane ID returned by `herdr agent list`:

```sh
herdr agent get ledger-review
herdr agent read ledger-review --source recent-unwrapped --lines 120
```

Use discovered IDs rather than assuming that example pane numbers refer to your current agents.

## 13. Troubleshoot

| Symptom | Procedure |
| --- | --- |
| `shep: command not found` | Try `~/.local/bin/shep --version`. If that works, add `$HOME/.local/bin` to PATH, then reopen the shell. |
| Shep says it runs only inside Herdr | Launch it from a real Herdr-managed shell pane. A separate terminal is insufficient even when Herdr is running elsewhere. |
| Port 4317 is already in use | Use the existing Shep instance, quit it before reopening, or intentionally launch another instance with `shep --port 4319`. |
| A provider is unavailable | Install that provider's CLI and make it available on PATH. Reopen Shep after changing the shell environment. Installation and authentication are separate requirements. |
| Wrong agent receives the task | Check the `provider:` syntax. No prefix always selects Codex; a composer provider choice does not change that rule. |
| Agent starts in the wrong folder | Press n and check the project, subfolder and placement preview. Worktrees always start at repository root; the preview and pre-launch notice explain this. |
| Invalid or missing directory | Enter an existing absolute directory in setup. Create the directory separately if it does not exist. |
| Stale/disconnected data | The retained list is the last successful snapshot. Check `herdr status` in another shell, restore the connection, then press r. Agent controls remain disabled until connected. |
| Settings fail to load or a workspace disappeared | Open setup and press Ctrl+R to reload configuration and discovery. Invalid settings produce a notice and use defaults for the affected section. Reopen Shep if its invoking pane/session changed. |
| A notice is too long for the pane | Click the notice or press i from the overview, then scroll its full text with Up/Down. Press Esc to return. |
| A dispatched agent is missing from the list | Clear search/filter with Esc from the overview and press r. Inspect the reported pane directly if startup is still awaiting authentication or detection. |
| “Too small or zoomed” when dispatching | Enlarge or unzoom the target area in Herdr, or close completed panes after review. Then retry only if no pane was already created. |
| “Enlarge this pane” | Give Shep at least 40 columns and 15 rows; more space improves readability. |
| Mouse does not work | Use keyboard controls. Mouse support depends on SGR mouse reporting through the terminal. |
| Colors are undesirable | Quit Shep and run `NO_COLOR=1 shep`. |
| Enter does the wrong thing | Check the current view: Enter submits a slash command, focuses an agent from the overview, and inserts a newline in the composer's prompt field. |
| q appears in the input | You are editing text. Press Esc, then q from the overview, or use Ctrl+C in the Shep pane. |
| Close is refused after confirmation | Cancel and review the current identity/status before confirming again. |
| Browser becomes unavailable after quitting | Reopen Shep; the browser server belongs to the running process. |

## 14. Install or update this version

The normal daily workflow needs only `shep`. Use this section when installing on another machine or updating the installed copy.

Requirements are Herdr 0.9.1 or newer and Node.js 22.23.2 or newer with npm. Automated verification covers Node.js 22.23.2 and 26.7.0 on macOS; Linux is unverified. Each provider needs its own CLI and authentication.

For a fresh source checkout:

```sh
git clone https://github.com/andrizzit/shep.git
cd shep
```

The checkpoint is a local, unpublished preview on `feat/smart-dispatch`; cloning public main does not obtain unpushed work. Build the reviewed feature checkout or use its reviewed tarball. For any source update, inspect `git status` and preserve local changes first.

Quit the running Shep process, then build and install from the source directory:

```sh
npm ci --ignore-scripts
npm pack
npm install --global --prefix "$HOME/.local" ./shep-herdr-plugin-0.4.0-checkpoint.1.tgz --offline --ignore-scripts --no-audit --no-fund
shep --version
```

For a later version, use the actual tarball name printed by `npm pack`. The dependency download occurs during `npm ci`; the packed runtime dependencies allow the tarball installation to work offline. The installed application is a copy, so changing source files does not update it automatically.

If needed, add this to the shell configuration used by your Herdr panes, such as `~/.zshrc`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

If you use the optional plugin registration, refresh it after installation:

```sh
herdr plugin link "$HOME/.local/lib/node_modules/shep-herdr-plugin"
```

Then reopen Shep in the desired Herdr pane. No npm registry release is required for this installation method.

## 15. Daily operating checklist

1. Open the existing Shep pane, or launch `shep` from the intended project directory.
2. Confirm LIVE, workspace, and working directory.
3. Enter `/dispatch provider@project: task`, or omit the prefix for Codex in the context project.
4. Wait for the submission result; use the overview to track work.
5. Focus agents needing input and answer in their own panes.
6. Review completed output and verification results before closing agents.
7. Close finished agents with x and an explicit confirmation.
8. Quit Shep with q when finished monitoring, or leave it open while agents continue.

See the [README](../README.md) for the project overview, optional plugin pane shortcut, and development checks.
