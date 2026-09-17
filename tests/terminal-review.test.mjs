import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { execFileSync } from 'node:child_process';
import { boardLines, displayWidth, startTerminal } from '../src/terminal.mjs';

function example() {
  return {
    mode: 'live', source: { state: 'connected', scope: 'Review session', message: null },
    updatedAt: '2026-09-16T22:00:00Z', agents: [
      { id: 'a1', provider: 'claude', name: 'Review ⌚ 中文 é 👨‍👩‍👧‍👦', status: 'blocked', paneId: 'w1:p1', workspace: { id: 'w1', name: '项目', path: '/projects/中文/👩🏽‍💻' } },
      { id: 'a2', provider: 'codex', name: 'Builder', status: 'working', paneId: 'w1:p2', workspace: { id: 'w1', name: 'Project', path: '/projects/app' } },
      { id: 'a3', provider: 'kiro', name: 'Idle review', status: 'idle', paneId: 'w2:p1', workspace: { id: 'w2', name: 'Second', path: null } },
    ],
  };
}

function terminal(snapshot, { interactive = true } = {}) {
  const input = new PassThrough();
  input.isTTY = interactive;
  input.setRawMode = () => {};
  const output = new EventEmitter();
  output.isTTY = interactive;
  output.columns = 150;
  output.rows = 45;
  let writes = '';
  let rows = [];
  output.write = chunk => {
    writes += chunk;
    if (chunk.includes('\x1b[2J')) rows = [];
    for (const match of chunk.matchAll(/\x1b\[(\d+);1H([\s\S]*?)(?=\x1b\[\d+;1H|$)/g)) {
      rows[Number(match[1]) - 1] = stripVTControlCharacters(match[2]);
    }
  };
  let refreshes = 0;
  let quits = 0;
  const monitor = { getSnapshot: () => snapshot, subscribe: () => () => {}, refresh: async () => { refreshes += 1; } };
  const stop = startTerminal({ monitor, url: 'http://localhost:4317', input, output, onQuit: () => { quits += 1; } });
  return { input, output, stop: () => { stop(); input.destroy(); }, get text() { return rows.join('\n'); }, get writes() { return writes; }, get refreshes() { return refreshes; }, get quits() { return quits; } };
}

test('display width covers default emoji, flags, CJK and joined graphemes', () => {
  for (const [text, width] of [['⌚', 2], ['⏰', 2], ['🐑', 2], ['🇺🇸', 2], ['中文', 4], ['é', 1], ['👨‍👩‍👧‍👦', 2], ['👩🏽‍💻', 2]]) {
    assert.equal(displayWidth(text), width, text);
  }
});

test('stale search remains visible at small usable heights and every frame stays clipped', () => {
  const snapshot = example();
  snapshot.source.state = 'disconnected';
  snapshot.source.message = 'Connection lost';
  for (let height = 10; height <= 24; height += 1) {
    for (const width of [40, 70, 100, 160]) {
      const board = boardLines(snapshot, { width, height, query: 'needle', searching: true, filter: 'blocked' });
      assert.equal(board.lines.length, height);
      assert(board.lines.every(line => displayWidth(line) <= width), `${width}×${height}: line overflow`);
      const text = board.lines.join('\n');
      assert.match(text, /STALE/, `${width}×${height}: lost freshness state`);
      assert.match(text, /needle|Enlarge this pane/, `${width}×${height}: search is hidden`);
    }
  }
});

test('compact renderer makes its active filter visible', () => {
  const text = boardLines(example(), { width: 70, height: 24, filter: 'blocked' }).lines.join('\n');
  assert.match(text, /Filter: Needs input/i);
});

test('real input keypress path keeps q in search, Enter preserves query, Escape clears controls', t => {
  const io = terminal(example());
  t.after(io.stop);
  io.input.write('/');
  io.input.write('q');
  assert.equal(io.quits, 0);
  assert.match(io.text, /\/ q/);
  io.input.write('\r');
  assert.match(io.text, /\/ q/);
  io.input.emit('keypress', '\x1b', { name: 'escape' });
  assert.doesNotMatch(io.text, /\/ q/);
  assert.match(io.text, /Builder/);
  io.input.write('3');
  assert.match(io.text, /Filter: Needs input/);
  assert.doesNotMatch(io.text, /Builder/);
  io.input.emit('keypress', '\x1b', { name: 'escape' });
  assert.match(io.text, /Filter: All/);
  io.input.write('r');
  assert.equal(io.refreshes, 1);
  io.input.write('q');
  assert.equal(io.quits, 1);
});

test('search Backspace removes one complete grapheme and Ctrl+C exits while searching', t => {
  const io = terminal(example());
  t.after(io.stop);
  io.input.emit('keypress', '/', { name: '/' });
  io.input.emit('keypress', '👩🏽‍💻', {});
  assert.match(io.text, /👩🏽‍💻/);
  io.input.emit('keypress', '\x7f', { name: 'backspace' });
  assert.doesNotMatch(io.text, /\/ 👩🏽‍💻/);
  io.input.write('\x03');
  assert.equal(io.quits, 1);
});

test('NO_COLOR suppresses RGB paint and noninteractive output has no terminal escapes', t => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  const io = terminal(example());
  t.after(() => { io.stop(); if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; });
  assert.doesNotMatch(io.writes, /(?:38|48);2;/);
  assert.match(stripVTControlCharacters(io.writes), /shep/);
  const plain = terminal(example(), { interactive: false });
  t.after(plain.stop);
  assert.doesNotMatch(plain.writes, /\x1b/);
});

test('hostile metadata never supplies control instructions in styled output', () => {
  const snapshot = example();
  const payload = '\x1b[2J\x1b]52;c;ZXhmaWx0cmF0ZQ==\x07\nATTACK\u202e';
  snapshot.agents[0].name = payload;
  snapshot.agents[0].workspace.name = payload;
  snapshot.agents[0].workspace.path = payload;
  snapshot.source.scope = payload;
  const board = boardLines(snapshot, { width: 160, height: 60, query: payload });
  assert(board.lines.every(line => !/[\x00-\x1f\x7f-\x9f\u202e]/.test(line)));
  for (const line of board.styledLines) {
    const withoutPaint = line.replace(/\x1b\[[0-9;]*m/g, '');
    assert.doesNotMatch(withoutPaint, /[\x00-\x1f\x7f-\x9f\u202e]/);
  }
});

test('first connection failure is unavailable rather than a stale snapshot', () => {
  const snapshot = example();
  snapshot.source.state = 'disconnected';
  snapshot.source.message = 'Herdr is unavailable';
  snapshot.updatedAt = null;
  snapshot.agents = [];
  const text = boardLines(snapshot, { width: 70, height: 12 }).lines.join('\n');
  assert.match(text, /UNAVAILABLE/);
  assert.doesNotMatch(text, /STALE/);
});

test('large agent lists remain scrollable under a bounded heap', { timeout: 8000 }, () => {
  const moduleUrl = new URL('../src/terminal.mjs', import.meta.url).href;
  const program = `
    import { boardLines } from ${JSON.stringify(moduleUrl)};
    const agents = Array.from({length:10000}, (_,i) => ({
      id:String(i),provider:'codex',name:'Worker '+String(i).padStart(5,'0'),
      status:'working',paneId:'w1:p'+i,workspace:{id:'w1',name:'Load fixture',path:'/fixture'}
    }));
    const snapshot={mode:'live',source:{state:'connected',scope:'Fixture'},updatedAt:new Date().toISOString(),agents};
    const result=boardLines(snapshot,{width:160,height:80,offset:Number.MAX_SAFE_INTEGER});
    if(!result.lines.join(' ').includes('Worker 09999')) throw new Error('Last agent is not accessible');
    process.stdout.write('PASS');
  `;
  assert.equal(execFileSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', program], { encoding: 'utf8', timeout: 5000 }), 'PASS');
});
