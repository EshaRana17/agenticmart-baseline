import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'agenticmart-baseline.js');
const FAKE = path.join(here, 'fixtures', 'fake-server.fixture');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-'));

function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function make(tools, coverage = {}) {
  return {
    schema: 'agenticmart.baseline/v0',
    subject: { name: 'x', repo: null, commit: null },
    generatedAt: '2026-01-01T00:00:00Z',
    source: 'local-probe',
    observed: { tools: Object.entries(tools).map(([name, d]) => ({ name, descriptionSha256: sha(d) })), hosts: [] },
    coverage: { booted: true, toolsListed: true, toolsExecuted: false, ...coverage },
    limits: 'test',
  };
}

function save(dir, name, obj) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return f;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('probe lists tools over the legacy handshake, writes a baseline and stops the server', async () => {
  const dir = tmp();
  const out = path.join(dir, 'b.json');
  const pidFile = path.join(dir, 'pid');
  const callsFile = path.join(dir, 'calls');
  const r = await run(['probe', '--out', out, '--', process.execPath, FAKE], { FAKE_PID_FILE: pidFile, FAKE_CALLS: callsFile });
  assert.equal(r.code, 0, r.stderr);
  const b = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(b.schema, 'agenticmart.baseline/v0');
  assert.equal(b.source, 'local-probe');
  assert.equal(b.subject.name, 'fake-server');
  assert.deepEqual(b.observed.tools.map((t) => t.name), ['delete_all', 'read_file', 'write_file']);
  assert.equal(b.observed.tools[1].descriptionSha256, sha('Read a file'));
  assert.deepEqual(b.coverage, { booted: true, toolsListed: true, toolsExecuted: false });
  assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false);
  const methods = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l).method);
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list']);
});

test('probe falls back to stateless _meta when initialize is rejected', async () => {
  const dir = tmp();
  const out = path.join(dir, 'b.json');
  const r = await run(['probe', '--out', out, '--', process.execPath, FAKE], { FAKE_MODE: 'stateless' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).observed.tools.length, 3);
});

test('probe follows pagination', async () => {
  const dir = tmp();
  const out = path.join(dir, 'b.json');
  const r = await run(['probe', '--out', out, '--', process.execPath, FAKE], { FAKE_PAGED: '1' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).observed.tools.length, 3);
});

test('probe times out, writes nothing and stops the server', async () => {
  const dir = tmp();
  const out = path.join(dir, 'b.json');
  const pidFile = path.join(dir, 'pid');
  const r = await run(['probe', '--timeout', '400', '--out', out, '--', process.execPath, FAKE], { FAKE_MODE: 'silent', FAKE_PID_FILE: pidFile });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /timed out/);
  assert.equal(fs.existsSync(out), false);
  assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false);
});

test('probe reports a server that cannot start', async () => {
  const dir = tmp();
  const r = await run(['probe', '--out', path.join(dir, 'b.json'), '--', 'agenticmart-no-such-binary-xyz']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /could not start/);
});

test('probe reports a server that exits early', async () => {
  const dir = tmp();
  const r = await run(['probe', '--out', path.join(dir, 'b.json'), '--', process.execPath, '-e', 'process.exit(3)']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /exited early/);
});

test('output files are not replaced without --force', async () => {
  const dir = tmp();
  const out = save(dir, 'b.json', 'keep me');
  const r = await run(['probe', '--out', out, '--', process.execPath, FAKE]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /already exists/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'keep me');
  assert.equal((await run(['probe', '--force', '--out', out, '--', process.execPath, FAKE])).code, 0);
});

test('diff exits 0 when nothing changed', async () => {
  const dir = tmp();
  const r = await run(['diff', save(dir, 'a', make({ a: '1' })), save(dir, 'b', make({ a: '1' }))]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no differences/);
});

test('diff reports added, removed and changed tools and exits 1', async () => {
  const dir = tmp();
  const r = await run(['diff', save(dir, 'a', make({ keep: '1', gone: '2', mod: '3' })), save(dir, 'b', make({ keep: '1', fresh: '4', mod: 'altered' })), '--json']);
  assert.equal(r.code, 1);
  const d = JSON.parse(r.stdout);
  assert.deepEqual(d.added, ['fresh']);
  assert.deepEqual(d.removed, ['gone']);
  assert.equal(d.changed[0].name, 'mod');
  assert.equal(d.changed[0].newSha256, sha('altered'));
});

test('diff catches a description change after approval, using two real probes', async () => {
  const dir = tmp();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  await run(['probe', '--out', a, '--', process.execPath, FAKE]);
  await run(['probe', '--out', b, '--', process.execPath, FAKE], { FAKE_RUG: 'always' });
  const r = await run(['diff', a, b]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /changed tools[\s\S]*write_file/);
});

test('diff exits 2 on a bad file, not 0 or 1', async () => {
  const dir = tmp();
  const r = await run(['diff', save(dir, 'a', '{oops'), save(dir, 'b', make({}))]);
  assert.equal(r.code, 2);
});

test('diff refuses baselines with no observed tool list', async () => {
  const dir = tmp();
  const r = await run(['diff', save(dir, 'a', make({}, { toolsListed: false })), save(dir, 'b', make({}))]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot compare/);
});

test('to-policy writes a policy with allow list and hashes', async () => {
  const dir = tmp();
  const out = path.join(dir, 'p.json');
  const r = await run(['to-policy', save(dir, 'a', make({ read: 'Read', write: 'Write' })), '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  const p = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(p.allowTools, ['read', 'write']);
  assert.equal(p.expectedTools.read, sha('Read'));
  assert.equal(p.onToolListChange, 'block');
  assert.equal(p.limits.maxIdenticalCalls, 5);
});

test('to-policy refuses a baseline with no tool list', async () => {
  const dir = tmp();
  const r = await run(['to-policy', save(dir, 'a', make({}, { toolsListed: false })), '--out', path.join(dir, 'p')]);
  assert.equal(r.code, 2);
});

test('fetch writes the baseline returned by the API', async () => {
  const dir = tmp();
  const out = path.join(dir, 'b.json');
  const body = make({ a: '1' });
  let seen;
  const { server, url } = await serve((req, res) => { seen = req.url; res.end(JSON.stringify(body)); });
  const r = await run(['fetch', 'mcp/some-slug', '--out', out], { AGENTICMART_API: url });
  server.close();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(seen, '/api/v1/baseline/mcp/some-slug');
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), body);
});

test('fetch rejects a response in the wrong format', async () => {
  const dir = tmp();
  const out = path.join(dir, 'b.json');
  const { server, url } = await serve((req, res) => res.end('{"schema":"something/else"}'));
  const r = await run(['fetch', 'mcp/x', '--out', out], { AGENTICMART_API: url });
  server.close();
  assert.equal(r.code, 2);
  assert.equal(fs.existsSync(out), false);
});

test('fetch reports HTTP errors', async () => {
  const { server, url } = await serve((req, res) => { res.statusCode = 404; res.end('{}'); });
  const r = await run(['fetch', 'mcp/missing', '--out', path.join(tmp(), 'b')], { AGENTICMART_API: url });
  server.close();
  assert.equal(r.code, 2);
  assert.match(r.stderr, /404/);
});

test('fetch rejects an unknown type', async () => {
  const r = await run(['fetch', 'plugin/x']);
  assert.equal(r.code, 2);
});
