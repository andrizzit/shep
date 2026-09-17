import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.mjs';

test('CLI selects live mode by default and keeps explicit sample mode separate', () => {
  assert.deepEqual(parseArgs([], {}), {terminal:true,demo:false,port:4317,help:false,version:false});
  assert.equal(parseArgs(['--demo'], {}).demo, true);
  assert.equal(parseArgs(['--terminal'], {}).terminal, true);
  assert.equal(parseArgs(['--web'], {}).terminal, false);
});
test('CLI options override the port environment but cannot select another Herdr session', () => {
  const result = parseArgs(['--port','4321'], {SHEP_PORT:'4319',SHEP_SESSION:'old'});
  assert.equal(result.port, 4321);
  assert.equal(result.session, undefined);
  assert.throws(() => parseArgs(['--session','other'], {}), /current Herdr instance/);
  assert.equal(parseArgs([], {SHEP_PORT:'4319'}).port, 4319);
});
test('CLI rejects malformed ports, missing values and unsupported options', () => {
  for (const port of ['0','-1','65536','4317oops','1.5','Infinity','']) {
    assert.throws(() => parseArgs(['--port',port], {}));
  }
  for (const args of [['--session'],['--port'],['--port','--demo'],['--wat']]) assert.throws(() => parseArgs(args, {}));
});
test('help and version remain available outside Herdr even with an invalid configured port', () => {
  assert.equal(parseArgs(['--help'], {SHEP_PORT:'invalid'}).help, true);
  assert.equal(parseArgs(['--version'], {SHEP_PORT:'invalid'}).version, true);
});
