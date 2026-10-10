#!/usr/bin/env node
// Usage: node scripts/anonymize.mjs <in.jsonl> <out.jsonl>   |   node scripts/anonymize.mjs --self-test
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// Allowlist: any string under a key not listed here is redacted.
const KEEP = new Set([
  'type', 'subtype', 'role', 'model', 'modelName', 'currentModel', 'timestamp', 'sessionStartTime',
  'stop_reason', 'service_tier', 'version', 'cli_version', 'model_provider', 'originator', 'source',
  'plan_type', 'limit_id', 'limit_name', 'shutdownType', 'userType', 'entrypoint',
]);
const HASH = new Set(['cwd', 'gitBranch', 'requestId', 'response_id']);
const SAFE = /^[\w.:+-]{1,64}$/;
const isIdKey = (k) => HASH.has(k) || /(^id$|_id$|Id$|uuid$|Uuid$)/.test(k);
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function scrub(value, key) {
  if (typeof value === 'string') {
    if (KEEP.has(key) && SAFE.test(value)) return value;
    if (isIdKey(key)) return `h_${hash(value)}`;
    return '<redacted>';
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [SAFE.test(k) ? k : `k_${hash(k)}`, scrub(v, k)]),
    );
  }
  return value;
}

function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
}

export function anonymize(text) {
  const lines = text.split('\n').filter(Boolean);
  const out = lines.map((line) => JSON.stringify(scrub(JSON.parse(line), '')));
  const result = out.join('\n') + '\n';
  // Independent of the allowlist: no long redacted input string may survive verbatim.
  const keptList = [];
  for (const line of out) collectStrings(JSON.parse(line), keptList);
  const kept = new Set(keptList);
  const keptText = keptList.join('\n');
  const leaks = [];
  for (const line of lines) {
    const strings = [];
    collectStrings(JSON.parse(line), strings);
    for (const s of strings) if (s.length >= 12 && !kept.has(s) && keptText.includes(s)) leaks.push(s.slice(0, 20));
  }
  if (leaks.length) throw new Error(`anonymize: ${leaks.length} input strings leaked into output (${[...new Set(leaks)].join(", ")})`);
  return result;
}

function selfTest() {
  const secret = 'my secret prompt about project falcon';
  const row = {
    type: 'assistant', cwd: '/Users/someone/private-repo', requestId: 'req_abc', timestamp: '2026-10-01T00:00:00Z',
    message: { id: 'msg_1', model: 'claude-opus-5', content: [{ type: 'text', text: secret }], usage: { input_tokens: 7, output_tokens: 9 } },
    model: `${secret}`, '/Users/someone/file.ts': { note: secret },
  };
  const out = anonymize(`${JSON.stringify(row)}\n${JSON.stringify(row)}\n`);
  const [a, b] = out.trim().split('\n').map((l) => JSON.parse(l));
  const assert = (ok, msg) => { if (!ok) { console.error(`FAIL: ${msg}`); process.exit(1); } };
  assert(!out.includes('secret') && !out.includes('falcon'), 'prompt text survived');
  assert(!out.includes('someone'), 'path survived');
  assert(a.message.usage.input_tokens === 7 && a.message.usage.output_tokens === 9, 'usage numbers changed');
  assert(a.message.model === 'claude-opus-5' && a.type === 'assistant', 'metadata lost');
  assert(a.message.id === b.message.id && a.requestId === b.requestId && a.message.id !== 'msg_1', 'ids not hashed deterministically');
  assert(a.message.id !== a.requestId, 'distinct ids collapsed to one value');
  console.log('self-test ok');
}

const [, , input, output] = process.argv;
if (input === '--self-test') selfTest();
else if (input && output) {
  writeFileSync(output, anonymize(readFileSync(input, 'utf8')));
  console.log(`wrote ${output}`);
} else if (import.meta.url === `file://${process.argv[1]}`) {
  console.error('usage: anonymize.mjs <in.jsonl> <out.jsonl> | --self-test');
  process.exit(1);
}
