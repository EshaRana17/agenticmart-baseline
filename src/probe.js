import crypto from 'node:crypto';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { startServer, killTree } from './spawn.js';

const LEGACY_VERSION = '2025-11-25';
const STATELESS_VERSION = '2026-07-28';
const CLIENT = { name: 'agenticmart-baseline', version: '0.1.0' };
const MAX_PAGES = 100;

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function statelessMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': STATELESS_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': CLIENT,
  };
}

// Starts the server, lists its tools, and always stops it before returning.
export async function probeServer(command, { timeoutMs = 15000 } = {}) {
  const posix = process.platform !== 'win32';
  const child = startServer(command[0], command.slice(1), ['pipe', 'pipe', 'ignore'], { detached: posix });
  const decoder = new StringDecoder('utf8');
  const pending = new Map();
  let buf = '';
  let nextId = 1;
  let fail;
  const failed = new Promise((_, reject) => { fail = reject; });
  failed.catch(() => {});

  const send = (msg) => { if (child.stdin.writable) child.stdin.write(`${JSON.stringify(msg)}\n`); };

  child.on('error', (e) => fail(new Error(`could not start server: ${e.message}`)));
  child.on('exit', (code, signal) => fail(new Error(`server exited early with ${signal ?? code}`)));
  child.stdin.on('error', () => {});
  child.stdout.on('data', (chunk) => {
    buf += decoder.write(chunk);
    let at;
    while ((at = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg?.method && msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported during a probe' } });
      } else if (msg?.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  const request = (method, params) => {
    const id = nextId;
    nextId += 1;
    const answer = new Promise((resolve) => pending.set(id, resolve));
    send({ jsonrpc: '2.0', id, method, params });
    return Promise.race([answer, failed]);
  };

  const timer = setTimeout(() => fail(new Error(`timed out after ${timeoutMs} ms waiting for the server`)), timeoutMs);

  try {
    const init = await request('initialize', { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: CLIENT });
    const legacy = !init.error && init.result;
    if (legacy) send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const tools = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = {};
      if (cursor !== undefined) params.cursor = cursor;
      if (!legacy) params._meta = statelessMeta();
      const res = await request('tools/list', params);
      if (res.error) throw new Error(`tools/list failed: ${res.error.message}`);
      if (!Array.isArray(res.result?.tools)) throw new Error('tools/list result has no tools array');
      tools.push(...res.result.tools);
      cursor = res.result.nextCursor;
      if (!cursor) return { tools, serverName: init.result?.serverInfo?.name ?? null, protocol: legacy ? 'legacy' : 'stateless' };
      if (seen.has(cursor)) throw new Error('tools/list repeated a cursor');
      seen.add(cursor);
    }
    throw new Error(`tools/list did not finish within ${MAX_PAGES} pages`);
  } finally {
    clearTimeout(timer);
    child.removeAllListeners('exit');
    try { child.stdin.end(); } catch { /* already closed */ }
    killTree(child, { group: posix });
    child.stdout.destroy();
    child.unref();
  }
}

export function baselineFromProbe(command, probed, { name, repo = null, commit = null } = {}) {
  const tools = probed.tools
    .filter((t) => typeof t?.name === 'string')
    .map((t) => ({ name: t.name, descriptionSha256: sha256(typeof t.description === 'string' ? t.description : '') }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    schema: 'agenticmart.baseline/v0',
    subject: { name: name ?? probed.serverName ?? path.basename(command[0]), repo, commit },
    generatedAt: new Date().toISOString(),
    source: 'local-probe',
    observed: { tools, hosts: [] },
    coverage: { booted: true, toolsListed: true, toolsExecuted: false },
    limits: 'Records only the tool names and description hashes this server returned once on this machine; no tool was executed and network hosts were not observed.',
  };
}
