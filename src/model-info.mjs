import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const TAIL_BYTES = 64 * 1024;
const REFRESH_MS = 10_000;
const SESSION_ID = /^[A-Za-z0-9-]+$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const EFFORT = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const contained = (root, path) => { const child = relative(root, path); return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep)); };

function fields(model, effort) {
  return { ...(typeof model === 'string' && MODEL_ID.test(model) ? { model } : {}),
    ...(typeof effort === 'string' && EFFORT.test(effort) ? { effort } : {}) };
}
const adapters = {
  claude: { folder: '.claude', location: ['projects'], depth: 1,
    filename: (name, id) => name === `${id}.jsonl`,
    record: item => item?.type === 'assistant' && item.message?.role === 'assistant' && Object.hasOwn(item.message, 'model')
      ? fields(item.message.model, item.effort) : null },
  grok: { folder: '.grok', location: ['sessions'], depth: 2,
    directory: (name, level, id) => level === 1 ? name === id : true,
    filename: name => name === 'chat_history.jsonl',
    record: item => item?.type === 'assistant' && Object.hasOwn(item, 'model_id')
      ? fields(item.model_id, item.reasoning_effort) : null },
};

async function safePath(root, path, directory = false) {
  // Refusing even internal symlinks keeps lookup predictable. No log is opened
  // through a linked project/session directory or a linked final file.
  if (!contained(root, path)) return null;
  const info = await lstat(path);
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) return null;
  if (!contained(root, await realpath(path))) return null;
  return info;
}

async function locate(home, adapter, sessionId) {
  const root = resolve(home, adapter.folder);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return null;
  const canonical = await realpath(root);
  const location = join(root, ...adapter.location);
  if (!await safePath(canonical, location, true)) return null;
  const matches = [];
  let inspected = 0;
  async function visit(path, level) {
    if (matches.length > 1) return;
    const entries = await readdir(path, { withFileTypes: true });
    inspected += entries.length;
    if (inspected > 20_000) throw new Error('Directory lookup limit');
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      if (level < adapter.depth) {
        if (entry.isDirectory() && (!adapter.directory || adapter.directory(entry.name, level, sessionId))
          && await safePath(canonical, child, true)) await visit(child, level + 1);
      } else if (entry.isFile() && adapter.filename(entry.name, sessionId)) {
        const info = await safePath(canonical, child);
        if (info) matches.push({ path: child, info });
      }
      if (matches.length > 1) return;
    }
  }
  await visit(location, 0);
  return matches.length === 1 ? matches[0] : null;
}

async function tailFields(file, info, adapter) {
  const offset = Math.max(0, info.size - TAIL_BYTES);
  const buffer = Buffer.alloc(Math.min(TAIL_BYTES, info.size));
  const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
  let text = buffer.subarray(0, bytesRead).toString('utf8');
  // A truncated first record is not a JSONL record. Never inspect the body
  // outside this bounded tail or retain any text after extracting the fields.
  if (offset) {
    const boundary = text.indexOf('\n');
    if (boundary < 0) return undefined;
    text = text.slice(boundary + 1);
  }
  let result;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    const next = adapter.record(item);
    if (next !== null) result = Object.keys(next).length ? next : undefined;
  }
  return result;
}

/** Read only provider-reported fields for an exact Herdr session identity. */
export function createModelReader({ home = homedir(), now = Date.now } = {}) {
  const cache = new Map();
  return async function read(request = {}) {
    const provider = request?.provider, sessionId = request?.sessionId;
    if (typeof provider !== 'string') return undefined;
    const adapter = Object.hasOwn(adapters, provider) ? adapters[provider] : null;
    if (!adapter || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return undefined;
    const key = `${provider}:${sessionId}`;
    const previous = cache.get(key), checkedAt = now();
    if (previous && (previous.pending || checkedAt - previous.checkedAt < REFRESH_MS)) {
      const value = previous.pending ? await previous.pending : previous.value;
      return value && { ...value };
    }
    const entry = { checkedAt, value: undefined };
    cache.set(key, entry);
    entry.pending = (async () => {
      try {
        const match = await locate(home, adapter, sessionId);
        if (!match) return undefined;
        // A stat-only cache hit would keep showing fields after read access is
        // revoked. Open safely on each refresh, without rereading unchanged logs.
        const file = await open(match.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const current = await file.stat();
          if (!current.isFile() || current.dev !== match.info.dev || current.ino !== match.info.ino
            || current.size !== match.info.size || current.mtimeMs !== match.info.mtimeMs) return undefined;
          entry.path = match.path; entry.size = current.size; entry.mtimeMs = current.mtimeMs;
          if (previous?.path === entry.path && previous.size === entry.size && previous.mtimeMs === entry.mtimeMs) return previous.value;
          return await tailFields(file, current, adapter);
        } finally { await file.close(); }
      } catch { return undefined; }
    })();
    entry.value = await entry.pending;
    delete entry.pending;
    return entry.value && { ...entry.value };
  };
}
