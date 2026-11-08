import fs from 'node:fs';

export const SCHEMA = 'agenticmart.baseline/v0';

export function validateBaseline(b) {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new Error('baseline must be a JSON object');
  if (b.schema !== SCHEMA) throw new Error(`unsupported schema ${JSON.stringify(b.schema)}, expected ${SCHEMA}`);
  if (typeof b.subject !== 'object' || b.subject === null) throw new Error('baseline has no subject');
  if (!Array.isArray(b.observed?.tools)) throw new Error('baseline has no observed.tools array');
  if (!Array.isArray(b.observed?.hosts)) throw new Error('baseline has no observed.hosts array');
  for (const t of b.observed.tools) {
    if (typeof t?.name !== 'string' || !/^[a-f0-9]{64}$/i.test(t?.descriptionSha256 ?? '')) {
      throw new Error(`invalid tool entry ${JSON.stringify(t)}`);
    }
  }
  if (typeof b.coverage !== 'object' || b.coverage === null || typeof b.coverage.toolsListed !== 'boolean') {
    throw new Error('baseline has no coverage.toolsListed');
  }
  return b;
}

export function readBaseline(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  try {
    return validateBaseline(parsed);
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

export function diffBaselines(a, b) {
  const oldTools = new Map(a.observed.tools.map((t) => [t.name, t.descriptionSha256.toLowerCase()]));
  const newTools = new Map(b.observed.tools.map((t) => [t.name, t.descriptionSha256.toLowerCase()]));
  const added = [...newTools.keys()].filter((n) => !oldTools.has(n)).sort();
  const removed = [...oldTools.keys()].filter((n) => !newTools.has(n)).sort();
  const changed = [...newTools.keys()]
    .filter((n) => oldTools.has(n) && oldTools.get(n) !== newTools.get(n))
    .sort()
    .map((n) => ({ name: n, oldSha256: oldTools.get(n), newSha256: newTools.get(n) }));
  const oldHosts = new Set(a.observed.hosts);
  const newHosts = new Set(b.observed.hosts);
  const hostsAdded = [...newHosts].filter((h) => !oldHosts.has(h)).sort();
  const hostsRemoved = [...oldHosts].filter((h) => !newHosts.has(h)).sort();
  return { added, removed, changed, hostsAdded, hostsRemoved };
}

export function hasDifferences(d) {
  return d.added.length + d.removed.length + d.changed.length + d.hostsAdded.length + d.hostsRemoved.length > 0;
}

export function toPolicy(b) {
  return {
    allowTools: b.observed.tools.map((t) => t.name),
    denyTools: [],
    denyArgPatterns: [],
    limits: { maxCallsPerMinute: 60, maxIdenticalCalls: 5, maxTotalCalls: 1000 },
    onToolListChange: 'block',
    expectedTools: Object.fromEntries(b.observed.tools.map((t) => [t.name, t.descriptionSha256.toLowerCase()])),
  };
}

// wx: never replace an earlier baseline by accident, or the diff has nothing to compare with.
export function writeJson(file, value, force) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: force ? 'w' : 'wx' });
}
