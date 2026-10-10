import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { claude } from '../src/adapters/claude.ts';
import { codex } from '../src/adapters/codex.ts';
import { copilot } from '../src/adapters/copilot.ts';

const fixture = (path: string) => fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url));
const sum = (events: { tokens: Record<string, number | undefined> }[], key: string) =>
  events.reduce((total, event) => total + (event.tokens[key] ?? 0), 0);

// Reverting the dedupe counts each streamed content block as its own request.
test('claude: one event per response, not per streamed line', async () => {
  const { events, warnings } = await claude.parse(fixture('claude-code/stream-duplicates.jsonl'));
  assert.equal(events.length, 22);
  assert.equal(new Set(events.map((e) => e.id)).size, 22);
  assert.equal(warnings, 0);
});

// Reverting the unchanged-total check double counts re-emitted token_count events.
test('codex pre-0.153: token_count events, repeats skipped, cached split out of input', async () => {
  const { events } = await codex.parse(fixture('codex/v0.145-token-count-only.jsonl'));
  assert.equal(events.length, 7);
  assert.ok(events.every((e) => e.tokens.input >= 0 && e.tokens.cacheRead >= 0));
  assert.equal(sum(events, 'input') + sum(events, 'cacheRead'), 311_093);
});

// Reverting the record path falls back to token_count and loses response_id dedupe.
test('codex 0.153+: one event per token_usage_record', async () => {
  const { events } = await codex.parse(fixture('codex/v0.155-token-usage-record.jsonl'));
  assert.equal(events.length, 6);
  assert.ok(events.every((e) => e.id.startsWith('codex:h_')));
});

// Dropping rate_limits parsing leaves the windows command empty.
test('codex: usage window comes from the last rate_limits snapshot', async () => {
  const { windows } = await codex.parse(fixture('codex/v0.155-token-usage-record.jsonl'));
  assert.ok(windows.length >= 1);
  const [w] = windows;
  assert.equal(w.agent, 'codex');
  assert.ok(w.usedPercent >= 0 && w.usedPercent <= 100);
  assert.ok(!Number.isNaN(Date.parse(w.resetsAt)));
  assert.equal(w.limit, 'codex');
});

// Treating inputTokens as uncached would bill cache writes twice.
test('copilot: one event per model per shutdown, cache split out of input', async () => {
  const { events } = await copilot.parse(fixture('copilot-cli/session-shutdown.jsonl'));
  assert.equal(events.length, 1);
  assert.equal(events[0].model, 'claude-opus-4.8');
  assert.equal(events[0].plan, undefined);
  assert.deepEqual(events[0].tokens, { input: 2, output: 535, cacheRead: 0, cacheWrite: 49_249, reasoning: 254 });
});
