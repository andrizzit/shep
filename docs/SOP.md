# Shep operating procedure

**Applies to:** Shep 0.4.0-checkpoint.9.3, the local project-aware dispatch preview inside Herdr.

**Scope:** Single-agent dispatch, project targeting, explicit worktree placement, a task board, notifications, change summaries, follow-ups and manual task clearing. Later fan-out, templates, named profiles, persisted history and worktree cleanup controls are deferred.

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

Use at least a 40-column by 15-row terminal pane. The live agent dock needs enough room in Shep's pane for at least 60 columns of Shep and 80 columns of agent terminal.

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
/dispatch [provider][@project][+here|+wt][:] task description
/dispatch task description
```

The brackets indicate an optional part; do not type the brackets.

| Command form | Selected provider |
| --- | --- |
| `/dispatch claude@folio: your task` | Claude in the folio project |
| `/dispatch codex@shep: your task` | Codex in the shep project |
| `/dispatch claude: your task` | Claude in the context project |
| `/dispatch kiro: your task` | Kiro, when installed |
| `/dispatch claude@folio your task` | Claude in folio, when installed and known |
| `/dispatch @folio your task` | Codex in the known folio project |
| `/dispatch your task` | **Codex**, unless the first word is a clear prefix |

Project prefixes accept names or aliases. Set a relative subfolder in the composer’s **Subfolder** field; `/subfolder` is not part of a project prefix.

The colon is optional for a clear prefix: a lowercase installed provider, a known `@project`, or their combination, optionally with `+here`. `/dispatch claude review this code` now sends `review this code` to Claude. Capitalized words (`Claude`), unavailable providers, unknown projects and file mentions (`@src/app.ts`) remain part of the literal Codex task. With a colon, unknown or unavailable providers and unknown projects keep their strict errors. Profiles and fan-out remain refused with or without a colon. `+wt` requests a worktree with either prefix form.

A first word such as `codex.md`, `claude.md` or `pi.js` is literal task text. Without a colon, a dotted agent word counts as deferred profile syntax only when its suffix is a configured profile or the prefix includes `@`, a comma or `+wt`. For example, `/dispatch codex.md is outdated, update it` sends the whole task to Codex. The colon form is unchanged.

To send a task that starts with an installed provider's name to Codex, be explicit: `/dispatch codex: claude said X`.

When your task itself starts with a colon label, make the provider explicit to avoid ambiguity:

```text
/dispatch codex: Bug: saving settings resets the selected theme
```

Each accepted dispatch creates a **new agent in its own Herdr tab**, reusing the project's main workspace or creating a new workspace if none is open. Your Shep pane and focus stay in place. It does not send a follow-up to an existing agent.

Dispatch uses the project's main folder even when another agent works there. Coordinate shared edits. Use `/dispatch codex@shep+wt: your task` for a worktree, or configure the project with `isolation: "always"`. That setting forces worktrees even with `+here`. A plain folder cannot create a Git worktree. Fan-out, named profiles and templates remain deferred.

Herdr starts a worktree at its repository root. If you requested a subfolder, the preview and pre-launch notice explain that it will not apply. If Git rejects a repository's ownership, Shep asks for trust of that exact root before worktree operations; it never answers the provider's own dialogs.

For Claude, Codex and Grok, an eligible task is one literal argument to the agent at startup. Shep does not subsequently type it. Other providers, tasks starting with `-`, one-word tasks, and tasks containing newlines or tabs use the existing typed path: wait for readiness, submit once, and check activity. No path retries or switches to another delivery method after a failure.

**Process-list visibility:** startup tasks appear in the agent's command line and can be read by local processes running as the same user. Task records and arguments remain excluded from the browser snapshot.

**Expected result:** Shep returns to the board with the new task selected as Starting while startup continues. You can launch another task immediately and press Enter to open a created pane. The final result updates its own row without changing your current view or selection. Double Enter never starts two agents for one submission. If startup reports idle without observed activity, the notice says the agent opened and asks you to check its pane, rather than claiming it started work.

**Needs you** means Herdr reported a block/setup question or Shep could not confirm delivery. Open the pane and handle the provider's dialog. The native reply-only checks confirmed Claude and Codex retained their startup task through the owner's trust confirmation and replied without retyping. Herdr nevertheless reported Codex idle while its trust screen was visible. Startup-delivered tasks that remain idle without observed work or completion now show Needs you, with one attention notification after about five seconds. A very fast completed reply can also trigger this state if Shep missed its activity; inspect the pane. Keep providers signed in and updated; the typed path retains its startup-screen limitation. Shep never reads screens to guess readiness or answers dialogs.

A startup timeout can remove Herdr's managed agent name. Shep verifies the original pane, terminal and provider, restores an absent name once, and reads the agent again. A matching working agent stays tracked through completion and its finished notification. A different name or changed identity stays uncertain; there is no automatic retry or task resend.

Agent and project suggestions appear vertically below the command line and scroll with the highlight. Click a row to accept it. Up/Down chooses with wraparound; Enter accepts only after an arrow move and otherwise submits. Tab accepts, Shift+Tab cycles. With no suggestions, Up/Down recalls commands from this run and Esc restores the displaced draft.

## 4. Write a useful task

Include the outcome, relevant area of the project, constraints, and how the agent should verify its work. For example:

```text
/dispatch codex: Fix the settings page so the selected theme survives a reload. Follow the existing settings patterns, add a regression test, and report the files changed and test results.
```

For review work:

```text
/dispatch claude: Review the current ledger changes for correctness. Do not edit files. Report actionable findings with file locations and explain any remaining uncertainty.
```

Main-folder dispatch shares the checkout. Use +wt for isolation, or coordinate file ownership with other people and tools. A non-Git folder cannot gain Git worktree isolation.

## 5. Choose a project or write a longer prompt

1. Return to the overview with **Esc** if you are editing a command.
2. Press **n New agent** (or **n New** in a narrow pane) to open the composer.
3. Move between fields with **Tab** or **Shift+Tab**.
4. In the focused provider field, choose from the vertical list of installed agents with **↑/↓** or **←/→**; **Enter** or **Tab** advances. Open the project picker. Filter the list, choose a project, or choose **Other folder…** and enter an existing absolute path.
5. Set an optional subfolder and task name. The Default toolbar reflects the composer provider; slash commands retain their Codex default. Check the placement preview and working directory.
6. Press **Esc** to retain your draft and return to the overview.

The composer offers one provider, project, optional subfolder/name, task and launch action. For a longer prompt, type or paste into the **Task** field. **Enter adds a newline there**; **Ctrl+S** submits the composer. You can also select its Dispatch button.

A custom agent name must be unique among live agents, begin with a lowercase letter, and use only lowercase letters, digits, `_`, or `-`, up to 32 characters. Leave it empty for an automatically generated name.

The provider chosen in the composer applies to composer launches. A slash command without a prefix still uses **Codex**. Generated names describe the task; an explicit `@project` targets that project. Nonempty configured default provider arguments require confirmation before first use; named profiles are not part of this checkpoint.

Settings and drafts last for the current Shep process. Esc keeps an unfinished draft; quitting Shep discards it. To resume a retained slash-command draft, click its command bar. Typing a new `/` from the overview starts a new command.

Prompts are limited to 64 KiB of UTF-8 text. Normal bracketed terminal paste preserves multiline prompt text and waits for an explicit submission.

## 6. Monitor progress

Press **g** to switch views. Tasks are grouped by project and show this run's dispatches, outcomes and changes. Agents are grouped by provider and include agents started outside Shep. Select a row, then press **d** or **Right** for details; use Up/Down to scroll and Esc to return. Use **n** to compose a new task; re-run shortcuts are deferred. Tasks are not restored after restarting; native agents remain visible in Agents.

| Status | Meaning and next action |
| --- | --- |
| Starting | Launch pending, or Herdr has not yet classified the agent. |
| Working | Herdr observes active work. |
| Needs you | A reported block/setup question or uncertain delivery. Open the pane. |
| Done | Herdr reports done or idle, except startup-delivered tasks with no observed activity. Review the result; idle alone does not prove the task ran. |
| Failed | The agent could not start; read the short reason. |
| Closed | The pane is confirmed gone; its task row disappears after about five seconds. |

Rows lead with a bold name, status and dimmed provider. Needs you sorts first within its group, Working is bright and Done muted. A second line appears only for an attention reason or finished-task changes. Short differing folders replace repeated full paths; details keep the full path and show IDs at the bottom.

Terminal rows align name, status, provider, model, effort and folder or age in columns. For **Claude and Grok**, model and effort use separate dimmed cells; missing cells preserve later columns. Every Claude family uses the same short format, such as `opus 5.5` or `fable 5.1`. Open details to see full IDs. At 110 columns or wider the list always uses 70% of the pane, keeping the divider still when model details appear. Gaps grow with the list's width. Narrow panes drop effort and model first, then folder or age, preserving name and status; details keep the fields. The browser snapshot is unchanged.

Model details need a Herdr session integration. Install the matching integration yourself with `herdr integration install claude` or `herdr integration install grok`, then start a new agent. Agents started before installation may lack a session ID. **Codex model and effort are not shown:** Herdr's current Codex hooks run in a shared `codex app-server`, which can report session IDs to the wrong pane. Shep ignores those IDs for identity and model lookup until [Herdr](https://herdr.dev/) fixes its integration. Re-check after a Codex or Herdr update. Codex dispatch and monitoring remain available; Shep does not guess session IDs.

Shep uses only the exact Herdr session ID. It reads at most the final 64 KiB of `~/.claude/projects/*/<session-id>.jsonl` (assistant `message.model`/`effort`) or `~/.grok/sessions/*/<session-id>/chat_history.jsonl` (assistant `model_id`/`reasoning_effort`). Only those fields are extracted; conversation text is not retained. The reader caches identity, size and modification time and refreshes at most every ten seconds. It reuses a safely validated session path instead of walking directories each refresh. Invalid or partial lines are skipped; the last verified fields remain when the same file grows without a complete assistant record in its tail. A replacement, unreadable or unsafe file cannot inherit them. An unrecorded selection between turns cannot appear yet. There are no provider-folder writes or new history files. Unsafe IDs, symlinks, ambiguous sessions or logs without verified fields produce no model details; Shep never uses a folder match or configuration default.

The overview refreshes roughly every two seconds. Press **r** from the overview to request a refresh. Shep displays Herdr's state; it does not independently judge whether a coding task is correct.

By default, Herdr notifies you when a Shep task finishes or needs input while you are viewing something else. Startup state is treated as a baseline, and an initially idle agent is not completion evidence. Notifications do not include unrelated external agents by default. Add `"notifications":{"enabled":false}` to your config to disable them, or `"notifications":{"sound":false}` for silent alerts. Configuration is never changed automatically.

Focusing an agent marks its native completion seen; the terminal labels done and idle as Done, except startup-delivered tasks with no observed activity. Reading the overview does not mark it seen. The read-only browser retains its native Needs input, Idle and Unknown labels. For startup delivery, idle before any observed working/done state shows Needs you and receives the delayed attention check; no screen text is inspected.

To find an agent:

1. Press **s** and enter an agent name, provider, pane ID, workspace name, or working-directory text.
2. Press **Enter** to return to the overview while keeping the search.
3. Press **f** from the overview to cycle status filters.
4. Press **Esc** from the overview to clear the search and filter.

While typing in a command, search, or prompt field, ordinary letters such as `q`, `x`, and `f` are text. Leave the editor before using overview shortcuts.

## 7. Open an agent and continue its work

1. Select an agent with **Up/Down**, **j/k**, or a mouse click.
2. When Shep's pane has room for at least 60 columns of Shep and 80 columns of agent terminal, pause for about 400 ms. Shep moves the selected agent's real pane to the right, giving it about 65% of the space while keeping focus on Shep's list. The header shows name, status, provider, model and effort when known. Shep uses its compact list layout when its side is narrow.
3. Press **Enter**, or click **Focus**, to move Herdr's focus to that agent. In a narrow tab or with the dock off, Enter focuses the agent in its original location as before.
4. Read its output and enter any follow-up directly into its own input.
5. From the right dock, press Herdr's default **Ctrl+B**, then **h** to focus the Shep pane on the left. If you changed Herdr's `focus_pane_left` binding, use your configured key. You can also click Shep's pane.

A mouse click on an agent row selects it. On a wide dock, switching brings the next agent pane in before returning the previous one to its original tab and split position. When there is not room for both agent panes, Shep returns the previous one first. Press **t** to turn off the dock and show Shep's details panel; press **t** again to resume docking. Shep leaves agents that are still starting in place. The dock moves a pane; it does not send text or keys to it.

Herdr 0.9.1 does not swap panes across tabs, so Shep keeps a `shep-dock` labeled placeholder in the agent's original tab and moves the real pane beside Shep. While docked, the original tab reads **`<agent name> · in Shep`** and the agent appears in Shep's tab; **t** returns the agent and restores the original tab label. On a wide dock, switching brings the next agent pane in before returning the previous one so Shep's width stays steady. Turning the dock off, pressing **q** or **Ctrl+C**, and closing a docked agent with **x** return it first. If the placeholder is running a command, Shep restores the agent beside it, removes the marker, leaves the busy pane open, and shows a notice. **Quit Shep with q before closing this tab — closing the tab also closes the docked agent.** Closing only Shep's pane sends SIGHUP, which makes Shep try one restore before exiting. After a crash, the next Shep startup uses the placeholder to restore the agent when its identity can be verified. If the original tab was closed, Shep returns it to a new tab labeled with the agent name in its original workspace; if the workspace was closed, it can use a new workspace. If a dock ends uncertain and Shep confirms the agent remains in its tab, it sends one Herdr notification alongside the existing notice. Inspect Herdr before moving it manually; Shep does not retry uncertain moves.

To continue the same conversation from Shep, select the task or agent and press **p** (also available in details). Check the name, pane and status shown above the editor. Type or paste multiline text; Enter adds a newline. **Ctrl+S** sends once and **Esc** cancels while retaining that agent's draft in memory. Another `/dispatch` creates another agent.

A submitted follow-up shows “Follow-up submitted”. This uses native submission without an activity wait; it does not guarantee the text ran. If the agent needs input, nothing is sent and Shep says “The agent is waiting for input in its pane. Answer it there.” On an uncertain result, inspect the agent before sending again. Shep never retries automatically. Own-pane, stale/demo and identity protections apply to follow-ups too.

To rename an agent, select it in Tasks or Agents and press **e Rename**, also available in details. The one-line editor is prefilled with the current name, or empty for unnamed agents opened outside Shep. Names start with `a`–`z`, then use `a`–`z`, `0`–`9`, `_` or `-`, up to 32 characters. **Enter** sends the rename once; **Esc** cancels. Invalid names show an inline error. Shep rechecks the exact pane, terminal and provider before renaming and confirms with a fresh read. Its own pane, stale/demo data and agents mid-startup cannot be renamed. A tracked task keeps matching its renamed agent.

| Key | Task or agent action |
| --- | --- |
| `p` | Open the selected agent's follow-up editor |
| `e` | Rename the selected agent; Enter saves, Esc cancels |
| `Ctrl+S` / `Esc` in that editor | Send once / cancel and keep the draft |
| `c` | Clear the selected closed or failed task |
| `C` | Clear all eligible closed and failed tasks |
| `x` | Confirm closing the selected agent's pane |

## 8. Handle a question or startup issue

For **Needs you**, select the task and press Enter to open its pane. A startup-path outcome clears its old command and prompt draft; the typed path keeps unsent text. Command recall can recover the original slash command after a launch failure. Answer trust, sign-in or other provider questions there yourself. On startup delivery Shep includes the task in the start arguments, but an uncertain result does not confirm receipt. Inspect the pane before manually sending anything; Shep never resends it. If no agent is detected, select the recorded pane directly in Herdr.

On the typed path, a task may not have been sent, or its pickup may be uncertain. Inspect the pane and the result before manually sending anything. A timeout never proves nothing happened. Shep preserves uncertain panes and drafts and does not answer dialogs or retry delivery.

There is no launch hold, Allow new launch button or Ctrl+Y acknowledgement. You can start another task while native startup is still pending. Another dispatch always creates a new agent; it does not resume the previous attempt.

## 9. Review and close a finished agent

1. Select the completed task to inspect its Git change summary, then focus its agent pane. The summary reports file/change counts and commits from the captured base where available; it is not a code review.
2. Read its final response, relevant changes, and test results.
3. Ask a follow-up in that pane, or use p in Shep, if work remains.
4. Once you are finished with the agent, return to Shep and select it again.
5. Press **x**, or click **Close**.
6. Verify the confirmation shows the intended agent, pane, and terminal identity.
7. Press **y** or click **Close agent** to confirm. Press **Esc** to cancel. The initial keyboard choice is Cancel.
8. Confirm the agent disappears from Shep and its Herdr pane closes.

Closing ends the selected pane's process. The **x** action also works for agents that Shep did not launch, with the same identity checks and default-Cancel confirmation. It does not revert files, commit work, delete branches, or clean up worktrees. Keep any output you need before closing.

For a worktree created by the task, its detail view shows the full worktree path and the manual command `herdr worktree remove --workspace <id>` with the actual workspace ID. Review and preserve changes before running that command yourself. Shep does not run it for you. The **W** cleanup action is the first planned post-checkpoint item.

If the target or its status changed while the dialog was open, Shep can refuse the close. Cancel, inspect the current agent, and start a new confirmation. A Done status is a cue to review; Shep does not automatically close agents.

About five seconds after private topology confirms its pane is gone, the closed task row disappears. Press **c** to clear a selected eligible closed/failed row sooner, or **C** to clear all eligible closed and failed rows. Failed rows remain until cleared, and retained panes must be closed first. An open detected agent is refused: “This agent is still open. Close it with x first, or keep it.” If a failed task has a pane but no detected agent, x cannot close it. Close the pane identified in the notice directly in Herdr, then press c again. Clearing only hides rows and releases local reservations. It never closes a pane, removes a worktree or deletes a branch.

## 10. Stop and reopen Shep

To stop Shep, press **q** from the overview, or **Ctrl+C** in Shep at any time. When an editor is open, press Esc to return to the overview before using q.

Quitting stops the Shep interface and its localhost server. Existing agents continue running. During a pending launch, quitting stops Shep's local wait and prevents later launch/prompt steps; any pane already created remains available in Herdr.

Reopen from a shell inside Herdr:

```sh
shep
```

The new instance discovers the agents still running. Task records, command recall, prompt drafts, search state, and composer choices are not restored. This checkpoint neither reads nor writes a history file. Check the default directory again.

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
| Wrong agent receives the task | Use `provider@project: task` for an explicit target. Without a colon only lowercase installed providers and known projects count as prefixes; other first words remain literal Codex tasks. |
| Agent starts in the wrong folder | Press n and check the project, subfolder and placement preview. Worktrees always start at repository root; the preview and pre-launch notice explain this. |
| Invalid or missing directory | Enter an existing absolute directory in the New agent composer. Create the directory separately if it does not exist. |
| Stale/disconnected data | The retained list is the last successful snapshot. Check `herdr status` in another shell, restore the connection, then press r. Agent controls remain disabled until connected. |
| Settings fail to load or a workspace disappeared | Open New agent and press Ctrl+R to reload configuration and discovery. Invalid settings produce a notice and use defaults for the affected section. Reopen Shep if its invoking pane/session changed. |
| A notice is too long for the pane | Click the notice or press i from the overview, then scroll its full text with Up/Down. Press Esc to return. |
| A dispatched agent is missing from the list | Clear search/filter with Esc from the overview and press r. Inspect the reported pane directly if startup is still awaiting authentication or detection. |
| “Too small or zoomed” when dispatching | Enlarge or unzoom the target area in Herdr, or close completed panes after review. Then retry only if no pane was already created. |
| “Enlarge this pane” | Give Shep at least 40 columns and 15 rows; more space improves readability. |
| Mouse does not work | Use keyboard controls. Mouse support depends on SGR mouse reporting through the terminal. |
| Colors are undesirable | Quit Shep and run `NO_COLOR=1 shep`. |
| Enter does the wrong thing | Check the current view: Enter accepts a suggestion after arrow selection, otherwise submits a slash command; it focuses an agent from the overview and inserts a newline in composer/follow-up prompt fields. |
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
npm install --global --prefix "$HOME/.local" ./shep-herdr-plugin-0.4.0-checkpoint.9.3.tgz --offline --ignore-scripts --no-audit --no-fund
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
