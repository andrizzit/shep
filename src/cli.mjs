#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createMonitor } from './monitor.mjs';
import { getHerdrContext, readHerdrSnapshot, readDemoSnapshot } from './herdr.mjs';
import { startServer } from './server.mjs';
import { startTerminal } from './terminal.mjs';

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

Run in any Herdr pane, from any directory. The terminal board and browser
companion connect automatically to that pane's current Herdr instance.

  --web            Serve only the browser page from this Herdr pane
  --terminal       Show the terminal board (the default)
  --demo           Show clearly labeled sample agents inside Herdr
  --port PORT      Local HTTP port (default 4317, or SHEP_PORT)
  --version        Show the installed version
  --help           Show this help

Live mode reads all workspaces in the current Herdr instance.
Herdr supplies the socket and pane context; SHEP_SESSION is ignored.
Use Ctrl+C to stop; in the terminal board use q outside search.`);
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
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    monitor.stop();
    stopTerminal();
    server.close();
    server.closeAllConnections();
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (options.terminal) stopTerminal = startTerminal({ monitor, url, onQuit: shutdown });
  else console.log(`Shep ${options.demo ? '(DEMO — sample agents)' : '(live Herdr monitoring)'}\n${url}\nPress Ctrl+C to stop.`);
  monitor.start();
  return { server, monitor, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Shep: ${error.message}`);
    process.exitCode = 1;
  });
}
