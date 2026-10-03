#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createMonitor } from './monitor.mjs';
import { getHerdrContext, readHerdrSnapshot, readDemoSnapshot } from './herdr.mjs';
import { startServer } from './server.mjs';
import { startTerminal } from './terminal.mjs';
import { startTui } from './tui.mjs';
import { createController } from './control.mjs';
import { loadConfig, addTrustedRepo } from './config.mjs';
import { createProjectRegistry } from './projects.mjs';
import { createGitRunner, summarize } from './gitinfo.mjs';
import { createNotifier } from './notify.mjs';
import { DEFAULT_CONFIG } from './dispatch/contracts.mjs';

// Private TUI services. Browser/plain-terminal modes never create this runtime.
export async function createDispatchRuntime({ context, monitor, mode = 'live', configFile } = {}) {
  const configOptions = configFile ? { path: configFile } : {};
  let settings = mode === 'demo'
    ? { path: null, config: structuredClone(DEFAULT_CONFIG), errors: [], warnings: [] }
    : await loadConfig(configOptions);
  let controller, tui, notifier, disposed = false, configQueue = Promise.resolve();
  const lifetime = new AbortController();
  const notices = [], reportedConfig = new Set();
  const getConfig = () => settings.config;
  const notice = message => {
    if (disposed) return;
    if (tui) tui.showNotice?.(message, 'warning');
    else notices.push(message);
  };
  const reportConfig = () => {
    const prefix = `Config ${settings.path}: `;
    const messages = [...settings.errors, ...settings.warnings].map(issue => issue.message.startsWith(prefix)
      ? `Config ${issue.message.slice(prefix.length)}; file: ${settings.path}` : issue.message)
      .filter(message => !reportedConfig.has(message));
    messages.forEach(message => reportedConfig.add(message));
    if (messages.length) notice(messages.join('; '));
  };
  const runGit = createGitRunner({ env: context.env, getConfig });
  const git = (args, options = {}) => runGit(args, { ...options,
    signal: options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal });
  const registry = createProjectRegistry({ getConfig, git, history: [], snapshot: () => mode === 'demo'
    ? { workspaces: [], tabs: [], panes: [], agents: [] } : controller.getControlSnapshot() });
  controller = createController({ context, monitor, mode, getConfig, registry, git, onNotice: notice,
    delivery: context.env?.SHEP_TEST_DELIVERY === 'type' ? 'type' : 'auto' });
  function startNotifier() {
    notifier?.dispose();
    notifier = undefined;
    if (!disposed && tui && mode !== 'demo') {
      notifier = createNotifier({ monitor, controller, config: getConfig(), getTasks: () => tui.getTasks?.() ?? [] });
    }
  }
  function updateConfig(read) {
    const next = configQueue.then(async () => {
      if (disposed) throw new Error('Shep is stopping.');
      const previousNotifications = JSON.stringify(getConfig().notifications);
      settings = await read();
      reportConfig();
      if (JSON.stringify(getConfig().notifications) !== previousNotifications) startNotifier();
      return settings;
    });
    configQueue = next.catch(() => {});
    return next;
  }
  return {
    controller,
    tuiOptions: {
      registry, getConfig,
      reloadConfig: () => mode === 'demo' ? Promise.resolve(settings) : updateConfig(() => loadConfig(configOptions)),
      addTrustedRepo: root => mode === 'demo'
        ? Promise.reject(new Error('Repository trust cannot be changed in demo mode.'))
        : updateConfig(() => addTrustedRepo(root, configOptions)),
      summarize: (dir, { baseCommit } = {}) => {
        if (disposed) return Promise.reject(new Error('Shep is stopping.'));
        const project = registry.containing(dir);
        const trustedRoot = project && getConfig().worktrees.trustedRepos.includes(project.root) ? project.root : undefined;
        return summarize(dir, { baseCommit, git, trustedRoot });
      },
    },
    attachTui(handle) {
      if (disposed) return;
      tui = handle;
      reportConfig();
      notices.splice(0).forEach(message => notice(message));
      startNotifier();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      notifier?.dispose();
      lifetime.abort();
      controller.dispose();
      notices.length = 0;
    },
  };
}

export function parseArgs(args, env = process.env) {
  const options = { terminal: true, demo: false, port: env.SHEP_PORT ?? '4317', help: false, version: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--terminal') options.terminal = true;
    else if (arg === '--web') options.terminal = false;
    else if (arg === '--demo') options.demo = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg === '--session') throw new Error('Shep uses the current Herdr instance. Run shep in the session you want to monitor.');
    else if (arg === '--port') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      options[arg.slice(2)] = value;
    } else throw new Error(`Unknown option: ${arg}. Run with --help for usage.`);
  }
  if (options.help || options.version) return options;
  if (!/^\d+$/.test(String(options.port)) || Number(options.port) < 1 || Number(options.port) > 65535) throw new Error('Port must be an integer from 1 to 65535.');
  options.port = Number(options.port);
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(`Shep — your Herdr agents, together.

Usage: shep [options]  (alias: shep-run)

Run in any Herdr pane, from any directory. The Ink TUI and browser
companion connect automatically to that pane's current Herdr instance.

  --web            Serve only the browser page from this Herdr pane
  --terminal       Show the interactive orchestrator (the default)
  --demo           Show clearly labeled sample agents inside Herdr
  --port PORT      Local HTTP port (default 4317, or SHEP_PORT)
  --version        Show the installed version
  --help           Show this help

Live mode reads all workspaces in the current Herdr instance.
Herdr supplies the socket and pane context; SHEP_SESSION is ignored.
Type /dispatch claude@project: your task to target a project.
Type /dispatch your task for Codex in the context project.
Use g to switch Tasks/Agents, or n for the project picker and composer.
Use Enter to focus a selected agent and x to confirm closing it.
Use Ctrl+C to stop Shep; agents keep running. Use q outside editors.`);
    return;
  }
  if (options.version) {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(`Shep ${version}`);
    return;
  }
  const context = getHerdrContext();
  // Refuse missing, stale, or unreachable host context before starting a server
  // or switching terminal modes. Every subsequent read uses this same context.
  let initial = await readHerdrSnapshot(context);
  const read = options.demo ? readDemoSnapshot : () => {
    if (initial) {
      const result = initial;
      initial = null;
      return result;
    }
    return readHerdrSnapshot(context);
  };
  const monitor = createMonitor({
    read,
    mode: options.demo ? 'demo' : 'live',
    scope: options.demo ? 'Sample agents · not live monitoring' : 'Current Herdr session',
  });
  await monitor.refresh();
  let server;
  try { server = await startServer({ monitor, port: options.port }); }
  catch (error) {
    monitor.stop();
    if (error.code === 'EADDRINUSE') throw new Error(`Port ${options.port} is already in use. Stop the other Shep instance or run shep --port ${options.port === 65535 ? 4317 : options.port + 1}.`);
    throw error;
  }
  const url = `http://localhost:${server.address().port}`;
  let stopTerminal = () => {};
  let controller;
  let dispatchRuntime;
  let stopping = false;
  let shutdownPromise;
  const shutdown = () => {
    if (stopping) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      try {
        // Keep the controller and Herdr socket alive until the real agent pane
        // has been returned to its original location (or recovery is left for
        // the next start). The TUI hook also cancels a pending selection timer.
        const restored = await stopTerminal.restoreDock?.();
        if (restored === false) process.stderr.write('Shep dock: restore is uncertain; inspect Herdr before moving this pane.\n');
      } catch (error) {
        process.stderr.write('Shep dock: restore is uncertain; inspect Herdr before moving this pane.\n');
      } finally {
        if (dispatchRuntime) dispatchRuntime.dispose();
        else controller?.dispose();
        monitor.stop();
        stopTerminal();
        server.close();
        server.closeAllConnections();
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        process.off('SIGHUP', shutdown);
      }
    })();
    return shutdownPromise;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  try {
    if (options.terminal) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        dispatchRuntime = await createDispatchRuntime({ context, monitor, mode: options.demo ? 'demo' : 'live' });
        controller = dispatchRuntime.controller;
        if (stopping) {
          dispatchRuntime.dispose();
          return { server, monitor, shutdown };
        }
      }
      stopTerminal = process.stdin.isTTY && process.stdout.isTTY
        ? startTui({ monitor, controller, ...dispatchRuntime.tuiOptions, url, onQuit: shutdown })
        : startTerminal({ monitor, url, onQuit: shutdown });
      dispatchRuntime?.attachTui(stopTerminal);
    } else console.log(`Shep ${options.demo ? '(DEMO — sample agents)' : '(live Herdr monitoring)'}\n${url}\nPress Ctrl+C to stop.`);
  } catch (error) {
    shutdown();
    throw error;
  }
  monitor.start();
  return { server, monitor, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Shep: ${error.message}`);
    process.exitCode = 1;
  });
}
