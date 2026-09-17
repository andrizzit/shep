#!/usr/bin/env node
// Controlled stand-in for the external Herdr executable. Tests never contact Herdr.
const mode = process.env.SHEP_TEST_MODE;
if (mode === 'hang') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'failure') {
  process.stderr.write('PRIVATE_OUTPUT_SHOULD_NOT_LEAK');
  process.exitCode = 1;
} else if (mode === 'malformed') {
  process.stdout.write('PRIVATE_OUTPUT_SHOULD_NOT_LEAK');
} else if (mode === 'overflow') {
  process.stdout.write('x'.repeat(100000));
} else if (mode === 'wrong-shape') {
  process.stdout.write(JSON.stringify({ result: { agents: [] } }));
} else {
  process.stdout.write(JSON.stringify({
    result: {
      snapshot: {
        version: '0.9.1-test',
        panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }],
        agents: [{
          pane_id: 'w1:p1', terminal_id: 't1', agent: 'codex', agent_status: 'working',
          name: JSON.stringify(process.argv.slice(2)),
          workspace_id: 'w1', cwd: process.env.HERDR_SOCKET_PATH || '/fixture',
        }],
        workspaces: [{ workspace_id: 'w1', label: 'Controlled CLI' }],
      },
    },
  }));
}
