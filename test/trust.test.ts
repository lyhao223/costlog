import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
// --import takes a URL; a bare Windows path is read as a URL with scheme "d:".
const guard = pathToFileURL(join(repo, 'test/support/no-network.mjs')).href;
const SECRET = 'launch codes for project falcon';

const home = mkdtempSync(join(tmpdir(), 'costlog-trust-'));
mkdirSync(join(home, 'claude/projects/p'), { recursive: true });
mkdirSync(join(home, 'codex/sessions/2026/09/23'), { recursive: true });
mkdirSync(join(home, 'copilot/session-state/s1'), { recursive: true });
writeFileSync(
  join(home, 'claude/projects/p/s.jsonl'),
  [
    { type: 'user', timestamp: '2026-09-23T00:00:00Z', message: { role: 'user', content: SECRET } },
    { type: 'assistant', timestamp: '2026-09-23T00:00:01Z', cwd: '/work/repo', requestId: 'r1',
      message: { id: 'm1', model: 'claude-opus-5', content: [{ type: 'text', text: SECRET }], usage: { input_tokens: 10, output_tokens: 20 } } },
  ].map((row) => JSON.stringify(row)).join('\n'),
);
writeFileSync(
  join(home, 'codex/sessions/2026/09/23/rollout-a.jsonl'),
  [
    { type: 'session_meta', timestamp: '2026-09-23T00:00:00Z', payload: { session_id: 's', cwd: '/work/repo', base_instructions: SECRET } },
    { type: 'response_item', timestamp: '2026-09-23T00:00:01Z', payload: { type: 'message', content: [{ type: 'input_text', text: `${SECRET} "token_count"` }] } },
    { type: 'event_msg', timestamp: '2026-09-23T00:00:02Z',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, output_tokens: 6 }, total_token_usage: { total_tokens: 11 } } } },
  ].map((row) => JSON.stringify(row)).join('\n'),
);
writeFileSync(
  join(home, 'copilot/session-state/s1/events.jsonl'),
  [
    { type: 'session.start', timestamp: '2026-09-23T00:00:00Z', data: { sessionId: 's1', context: { cwd: '/work/repo', branch: SECRET } } },
    { type: 'user.message', timestamp: '2026-09-23T00:00:01Z', data: { content: SECRET } },
    { type: 'session.shutdown', timestamp: '2026-09-23T00:00:02Z', data: { modelMetrics: { 'claude-opus-4.8': { usage: { inputTokens: 3, outputTokens: 4 } } } } },
  ].map((row) => JSON.stringify(row)).join('\n'),
);
const cursorDb = new DatabaseSync(join(home, 'cursor.vscdb'));
cursorDb.exec('create table cursorDiskKV (key text primary key, value blob)');
const put = cursorDb.prepare('insert into cursorDiskKV values (?, ?)');
put.run('composerData:c1', JSON.stringify({ createdAt: Date.parse('2026-09-23T00:00:00Z'), modelConfig: { modelName: 'claude-opus-5' }, name: SECRET }));
put.run('bubbleId:c1:b1', JSON.stringify({ type: 1, text: SECRET }));
put.run('bubbleId:c1:b2', JSON.stringify({ type: 2, text: SECRET, tokenCount: { inputTokens: 100, outputTokens: 7 } }));
put.run('bubbleId:c1:b3', JSON.stringify({ type: 2, text: SECRET, tokenCount: { inputTokens: 0, outputTokens: 0 } }));
put.run('bubbleId:orphan:b4', JSON.stringify({ type: 2, tokenCount: { inputTokens: 5, outputTokens: 5 } }));
cursorDb.close();
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), COPILOT_HOME: join(home, 'copilot'), CURSOR_STATE_DB: join(home, 'cursor.vscdb'), COSTLOG_CACHE_DIR: join(home, 'cache'),
};
const run = (...args: string[]) =>
  execFileSync(process.execPath, ['--import', guard, join(repo, 'src/cli.ts'), '--since', '2026-01-01', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// If the guard stopped intercepting, the test below would pass even with a network call in the CLI.
test('the network guard itself blocks fetch and sockets', () => {
  const probe = (code: string) => () => execFileSync(process.execPath, ['--import', guard, '-e', code], { stdio: 'pipe' });
  assert.throws(probe('await fetch("https://example.com")'), /network access attempted: fetch/);
  assert.throws(probe('require("node:net").connect(80, "127.0.0.1")'), /network access attempted: socket/);
});

// Adding any network call to a report path makes these commands throw under the guard.
test('every command runs with the network blocked', () => {
  const daily = JSON.parse(run('--json'));
  assert.deepEqual(new Set(daily.rows.map((r: { agent: string }) => r.agent)), new Set(['claude-code', 'codex', 'copilot-cli', 'cursor']));
  // Counting user bubbles or orphaned rows would inflate Cursor's request count.
  const cursorRow = daily.rows.find((r: { agent: string }) => r.agent === 'cursor');
  assert.deepEqual([cursorRow.requests, cursorRow.input, cursorRow.output, cursorRow.apiEquivalentUsd], [2, 100, 7, 0]);
  assert.match(run(), /Cursor: 2 responses, 1 with token counts/);
  // Pricing a partial sample would print a small, wrong total that looks exact.
  assert.equal(cursorRow.unpricedTokens, 107);
  for (const args of [[], ['by', 'model']]) assert.ok(Math.max(...run(...args).split('\n').map((l) => [...l].length)) <= 80);
  for (const args of [['by', 'model'], ['by', 'project'], ['windows'], ['doctor']]) run(...args);
});

// Storing or printing message text would put prompts into the cache file and terminal scrollback.
test('prompt text never reaches output or the cache', () => {
  const printed = [[], ['--json'], ['by', 'model', '--json'], ['by', 'project', '--json'], ['windows', '--json'], ['doctor', '--json']]
    .map((args) => run(...args))
    .join('\n');
  const cache = readFileSync(join(home, 'cache/index.json'), 'utf8');
  assert.ok(cache.includes('claude-opus-5'), 'cache was not written');
  for (const text of [printed, cache]) {
    assert.ok(!text.includes('falcon'), 'prompt text leaked');
    assert.ok(!text.includes('launch codes'), 'prompt text leaked');
  }
});
