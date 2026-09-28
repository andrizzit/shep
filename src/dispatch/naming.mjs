import { randomBytes } from 'node:crypto';
import { LIMITS, PATTERNS, PROVIDER_IDS } from './contracts.mjs';
import { safeText } from '../terminal.mjs';

const stopwords = new Set('a an the for to of in on and with please this that my our'.split(' '));
const random = length => randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);

export function slug(task) {
  const words = String(task).normalize('NFKD').replace(/\p{Mark}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/ +/).filter(word => word && !stopwords.has(word));
  let value = '';
  for (const word of words) {
    if (!value) value = word.slice(0, LIMITS.slugCharacters);
    else if (value.length + 1 + word.length <= LIMITS.slugCharacters) value += `-${word}`;
    else break;
  }
  value ||= 'task';
  return /^[0-9]/.test(value) ? `t-${value}` : value;
}

export function agentName(task, provider, { takenNames = [], randomHex = random } = {}) {
  if (!PROVIDER_IDS.includes(provider)) throw new TypeError('Choose a supported agent provider.');
  const taken = new Set(takenNames);
  const base = slug(task);
  const candidate = suffix => `${base.slice(0, LIMITS.agentNameCharacters - provider.length - suffix.length - 1).replace(/[-_]+$/, '')}-${provider}${suffix}`;
  for (const suffix of ['', ...Array.from({ length: 8 }, (_, index) => `-${index + 2}`)]) {
    const name = candidate(suffix);
    if (!taken.has(name)) return name;
  }
  // A bad/injected random source must not leave the dispatcher in an infinite loop.
  for (let attempt = 0; attempt < 4096; attempt += 1) {
    const hex = randomHex(3);
    if (typeof hex !== 'string' || !/^[a-f0-9]{3}$/i.test(hex)) throw new TypeError('Random name suffix must be three hexadecimal characters.');
    const name = candidate(`-${hex.toLowerCase()}`);
    if (!taken.has(name)) return name;
  }
  throw new Error('No unique agent name is available. Choose a name explicitly.');
}

export function tabLabel(task) {
  const text = safeText(String(task).split(/\r?\n/, 1)[0]).replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  return chars.length > LIMITS.tabLabelCharacters ? `${chars.slice(0, LIMITS.tabLabelCharacters).join('')}…` : text;
}

export function branchName(task, { branchPrefix = 'shep/', randomHex = random } = {}) {
  if (!PATTERNS.branchPrefix.test(branchPrefix)) throw new TypeError('Invalid worktree branch prefix.');
  const hex = randomHex(4);
  if (typeof hex !== 'string' || !/^[a-f0-9]{4}$/i.test(hex)) throw new TypeError('Random branch suffix must be four hexadecimal characters.');
  return `${branchPrefix}${slug(task)}-${hex.toLowerCase()}`;
}
