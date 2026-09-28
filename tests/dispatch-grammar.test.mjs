import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCommand, suggest, format } from '../src/dispatch/grammar.mjs';
import { validateDispatchSpec, MESSAGES } from '../src/dispatch/contracts.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/dispatch-grammar.json', import.meta.url), 'utf8'));
const context = fixture.context;
for (const vector of fixture.cases) test(`grammar: ${vector.id}`, () => {
  const actual = parseCommand(vector.input, { ...context, ...vector.context });
  if (vector.expected.error) {
    assert.equal(actual.error, vector.expected.error);
    if (vector.expected.trust) assert.deepEqual(actual.trust, vector.expected.trust);
  } else {
    const { project, kind, ...rest } = actual;
    assert.equal(kind, 'dispatch');
    assert.deepEqual({ ...rest, projectKey: project.key }, vector.expected);
    assert.deepEqual(validateDispatchSpec(actual), []);
  }
});

test('grammar keeps UTF-8 literals and validates byte/control limits before dispatch', () => {
  const prompt = '🙂'.repeat(16384);
  assert.equal(parseCommand(`/dispatch ${prompt}`, context).task, prompt);
  assert.equal(parseCommand(`/dispatch ${prompt}a`, context).error, MESSAGES.invalidPrompt);
  for (const control of ['\0', '\r', '\x1b', '\x7f', '\x85']) assert.equal(parseCommand(`/dispatch x${control}y`, context).error, MESSAGES.invalidPrompt);
  assert.equal(parseCommand('/dispatch codex:\t \tline\nnext: $&', context).task, ' \tline\nnext: $&');
});

test('grammar keeps context subfolder and one-command override; format round-trips intent and literal task', () => {
  const parsed = parseCommand('/fix claude.fast@folio+here: $&\nline two', context);
  assert.equal(parseCommand('/dispatch x', { ...context, contextSubfolder: 'src/api' }).subfolder, 'src/api');
  assert.equal(parsed.subfolder, '');
  assert.deepEqual(parseCommand(format(parsed), context), parsed);
  assert.equal(parseCommand('/dispatch x', { ...context, contextProjectKey: null }).code, 'project_required');
});

test('unknown project suggestions use full Damerau-Levenshtein distance', () => {
  const projects = [{ ...context.projects[0], name: 'ABC', aliases: [] }];
  // CA → AC (transpose) → ABC (insert), distance2; restricted OSA would report3.
  assert.equal(parseCommand('/dispatch @CA: x', { ...context, projects }).error, 'Unknown project “CA”. Did you mean ABC?');
});

test('suggestions rank prefix, substring and subsequence, preserving recent input order', () => {
  const projects = ['name', 'abacus', 'cab', 'axb', 'absolute'].map((name, index) => ({ ...context.projects[0], name, aliases: [], key: `git:/fixture/${index}/.git` }));
  const items = suggest('/dispatch @ab', 13, { ...context, projects });
  assert.deepEqual(items.map(item => item.value), ['abacus', 'absolute', 'cab', 'axb']);
  assert.ok(items.every(item => item.replaceStart === 11 && item.replaceEnd === 13));
});

test('suggestions are token-aware, installed-only, and never replace literal task text', () => {
  assert.deepEqual(suggest('/dispatch codex: @fo', 19, context), []);
  assert.deepEqual(suggest('/dispatch g', 11, { ...context, providers: context.providers.map(provider => ({ ...provider, available: provider.id === 'codex' })) }), []);
  assert.equal(suggest('/dispatch claude.f', 18, context)[0].value, 'fast');
  assert.deepEqual(suggest('/dispatch @fo+here: x', 13, context)[0], { label: 'folio  /fixture/folio', value: 'folio', projectKey: 'git:/fixture/folio/.git', replaceStart: 11, replaceEnd: 13 });
  const duplicate = fixture.cases.find(item => item.id === 'ambiguous-project').context;
  const line = '/dispatch @app.wrong+here: x';
  const result = suggest(line, 16, { ...context, ...duplicate }).find(item => item.value === 'app.work');
  assert.equal(result.replaceEnd, line.indexOf('+'));
  assert.equal(suggest('/re', 3, context)[0].value, 'review');
});
