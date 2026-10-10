import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scan } from '../src/core.ts';
import type { Adapter } from '../src/types.ts';

// Without the size+mtime check a session that grew after the first scan keeps its stale totals.
test('cache reuses unchanged files and re-reads changed ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'costlog-'));
  process.env.COSTLOG_CACHE_DIR = join(dir, 'cache');
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, 'a\n');
  let parses = 0;
  const adapter: Adapter = {
    id: 'codex',
    roots: () => [dir],
    locate: async () => [file],
    parse: async () => {
      parses++;
      const id = `e${parses}`;
      return { warnings: 0, windows: [], events: [{ id, agent: 'codex', timestamp: '2026-01-02T00:00:00Z', model: 'm', tokens: { input: parses, output: 0, cacheRead: 0, cacheWrite: 0 } }] };
    },
  };
  const run = () => scan(new Date('2026-01-01'), new Date('2026-01-03'), [adapter]);

  assert.equal((await run()).events[0].id, 'e1');
  assert.equal((await run()).events[0].id, 'e1');
  assert.equal(parses, 1);

  appendFileSync(file, 'b\n');
  assert.equal((await run()).events[0].id, 'e2');
  assert.equal(parses, 2);

  writeFileSync(join(dir, 'cache', 'index.json'), '{broken');
  assert.equal((await run()).events[0].id, 'e3');
});

// Caching "this runtime cannot read it" would keep the source empty after upgrading Node.
test('an unsupported result is reported and never cached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'costlog-'));
  process.env.COSTLOG_CACHE_DIR = join(dir, 'cache');
  const file = join(dir, 'state.db');
  writeFileSync(file, 'x');
  let supported = false;
  const adapter: Adapter = {
    id: 'cursor',
    roots: () => [dir],
    locate: async () => [file],
    parse: async () =>
      supported
        ? { warnings: 0, windows: [], events: [{ id: 'c1', agent: 'cursor', timestamp: '2026-01-02T00:00:00Z', model: 'm', tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }] }
        : { warnings: 0, windows: [], events: [], unsupported: 'needs a newer runtime' },
  };
  const run = () => scan(new Date('2026-01-01'), new Date('2026-01-03'), [adapter]);
  assert.deepEqual((await run()).agents[0].notes, ['needs a newer runtime']);
  supported = true;
  assert.equal((await run()).events.length, 1);
});
