import test from 'node:test';
import assert from 'node:assert/strict';
import { boardLines, safeText } from '../src/terminal.mjs';

const snapshot = { mode: 'live', source: { state: 'connected', scope: 'Current Herdr session', message: null }, updatedAt: new Date().toISOString(), agents: [
  {id:'1',provider:'codex',name:'Reviewer',status:'blocked',paneId:'w1:p1',workspace:{id:'w1',name:'Project',path:'/projects/one'}},
  {id:'2',provider:'codex',name:'Builder',status:'working',paneId:'w1:p2',workspace:{id:'w1',name:'Project',path:'/projects/one'}},
] };

test('terminal board keeps sessions sharing a workspace and groups with no agents', () => {
  const output = boardLines(snapshot, {height: 60}).lines.join('\n');
  assert.match(output, /Reviewer/);
  assert.match(output, /Builder/);
  assert.match(output, /Claude  \(0\)/);
  assert.match(output, /Kiro  \(0\)/);
  assert.match(output, /NEEDS INPUT/);
  assert.match(output, /\/projects\/one/);
});
test('host metadata cannot inject terminal commands or additional rows', () => {
  assert.equal(safeText('\x1b[2Jhello\nworld\x1b]52;c;YWJj\x07'), 'hello world');
  const dangerous = structuredClone(snapshot);
  dangerous.agents[0].name = '\x1b[31mName\r\nFAKE\u202e';
  const output = boardLines(dangerous, {height:60}).lines;
  assert.ok(output.every(line => !/[\x00-\x1f\x7f-\x9f\u202e]/.test(line)));
});
test('scrolling stays within content and narrow boards are clipped', () => {
  const board = boardLines(snapshot, {height: 12, width: 42, offset: 999});
  assert.equal(board.offset, board.maxOffset);
  assert.ok(board.maxOffset > 0);
  assert.ok(board.lines.length <= 12);
  assert.ok(board.lines.every(line => Array.from(line).length <= 42));
});
test('tiny terminals show a compact fallback without overflowing', () => {
  const compact = boardLines(snapshot, {height: 3, width: 18});
  assert.ok(compact.lines.length <= 3);
  assert.ok(compact.lines.every(line => Array.from(line).length <= 18));
  assert.equal(compact.maxOffset, 0);
});
test('disconnected snapshot is explicitly stale instead of appearing empty', () => {
  const stale = structuredClone(snapshot);
  stale.source.state = 'disconnected';
  stale.source.message = 'Herdr is unavailable';
  const output = boardLines(stale, {height:60}).lines.join('\n');
  assert.match(output, /STALE/);
  assert.match(output, /Reviewer/);
  assert.match(output, /Herdr is unavailable/);
});
