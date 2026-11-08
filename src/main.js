import { diffBaselines, hasDifferences, readBaseline, toPolicy, validateBaseline, writeJson } from './baseline.js';
import { baselineFromProbe, probeServer } from './probe.js';

const USAGE = `usage:
  agenticmart-baseline fetch <type>/<slug> [--out file] [--force]
  agenticmart-baseline probe [--out file] [--force] [--timeout ms] [--name n] [--repo r] [--commit c] -- <command...>
  agenticmart-baseline diff <old> <new> [--json]
  agenticmart-baseline to-policy <baseline> [--out file] [--force]
exit codes: 0 ok, 1 differences found (diff only), 2 error
`;

const VALUE_FLAGS = new Set(['--out', '--timeout', '--name', '--repo', '--commit']);
const BOOL_FLAGS = new Set(['--force', '--json']);

class UsageError extends Error {}

function parse(argv) {
  const sep = argv.indexOf('--');
  const head = sep === -1 ? argv : argv.slice(0, sep);
  const flags = {};
  const positional = [];
  for (let i = 0; i < head.length; i += 1) {
    const a = head[i];
    if (VALUE_FLAGS.has(a)) {
      if (head[i + 1] === undefined) throw new UsageError(`${a} needs a value`);
      flags[a.slice(2)] = head[(i += 1)];
    } else if (BOOL_FLAGS.has(a)) flags[a.slice(2)] = true;
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else positional.push(a);
  }
  return { flags, positional, command: sep === -1 ? [] : argv.slice(sep + 1) };
}

function write(file, value, force, what) {
  try {
    writeJson(file, value, force);
  } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`${file} already exists; pass --force or choose --out`);
    throw e;
  }
  process.stdout.write(`wrote ${what} to ${file}\n`);
}

async function fetchCmd(ref, flags) {
  const m = /^(mcp|agent|skill)\/(.+)$/.exec(ref ?? '');
  if (!m) throw new UsageError('expected <type>/<slug> where type is mcp, agent or skill');
  const base = (process.env.AGENTICMART_API || 'https://agenticmart.org').replace(/\/+$/, '');
  const url = `${base}/api/v1/baseline/${m[1]}/${encodeURIComponent(m[2])}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`API returned HTTP ${res.status} for ${url}`);
  const baseline = validateBaseline(await res.json());
  write(flags.out ?? `${m[2].replace(/[^A-Za-z0-9._-]/g, '_')}.baseline.json`, baseline, flags.force, 'baseline');
  if (!baseline.coverage.toolsListed) process.stderr.write('note: this baseline has no observed tool list (coverage.toolsListed is false)\n');
}

async function probeCmd(command, flags) {
  if (command.length === 0) throw new UsageError('probe needs a server command after --');
  const timeoutMs = flags.timeout === undefined ? 15000 : Number(flags.timeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new UsageError('--timeout must be a positive integer of milliseconds');
  const probed = await probeServer(command, { timeoutMs });
  const baseline = baselineFromProbe(command, probed, flags);
  write(flags.out ?? 'local.baseline.json', baseline, flags.force, `baseline with ${baseline.observed.tools.length} tools`);
}

function list(title, items) {
  if (items.length) process.stdout.write(`${title}:\n${items.map((i) => `  ${i}`).join('\n')}\n`);
}

function diffCmd(oldFile, newFile, flags) {
  if (!oldFile || !newFile) throw new UsageError('diff needs two baseline files');
  const a = readBaseline(oldFile);
  const b = readBaseline(newFile);
  if (!a.coverage.toolsListed || !b.coverage.toolsListed) {
    throw new Error('cannot compare: at least one baseline has no observed tool list (coverage.toolsListed is false)');
  }
  const d = diffBaselines(a, b);
  const differs = hasDifferences(d);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ differs, ...d }, null, 2)}\n`);
  } else if (!differs) {
    process.stdout.write('no differences in the observed tools or hosts\n');
  } else {
    list('added tools', d.added);
    list('removed tools', d.removed);
    list('changed tools (description hash differs)', d.changed.map((c) => `${c.name}: ${c.oldSha256.slice(0, 12)} -> ${c.newSha256.slice(0, 12)}`));
    list('added hosts', d.hostsAdded);
    list('removed hosts', d.hostsRemoved);
  }
  return differs ? 1 : 0;
}

function toPolicyCmd(file, flags) {
  if (!file) throw new UsageError('to-policy needs a baseline file');
  const b = readBaseline(file);
  if (!b.coverage.toolsListed) throw new Error('cannot build a policy: this baseline has no observed tool list');
  write(flags.out ?? 'policy.json', toPolicy(b), flags.force, 'guard policy');
}

export async function main(argv) {
  try {
    const [cmd, ...rest] = argv;
    if (!cmd || cmd === '--help' || cmd === '-h') {
      process.stdout.write(USAGE);
      return;
    }
    const { flags, positional, command } = parse(rest);
    let code = 0;
    if (cmd === 'fetch') await fetchCmd(positional[0], flags);
    else if (cmd === 'probe') await probeCmd(command, flags);
    else if (cmd === 'diff') code = diffCmd(positional[0], positional[1], flags);
    else if (cmd === 'to-policy') toPolicyCmd(positional[0], flags);
    else throw new UsageError(`unknown command ${cmd}`);
    process.exitCode = code;
  } catch (e) {
    process.stderr.write(`agenticmart-baseline: ${e.message}\n${e instanceof UsageError ? USAGE : ''}`);
    process.exitCode = 2;
  }
}
