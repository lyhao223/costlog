import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cost } from '../src/pricing.ts';
import type { UsageEvent } from '../src/types.ts';

const models = {
  m: {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 10e-6,
    cache_read_input_token_cost: 0.1e-6,
    cache_creation_input_token_cost: 2e-6,
    input_cost_per_token_above_200k_tokens: 2e-6,
    input_cost_per_token_priority: 3e-6,
    input_cost_per_token_above_200k_tokens_priority: 6e-6,
  },
  claudeish: { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6, cache_creation_input_token_cost: 2e-6, cache_creation_input_token_cost_above_1hr: 4e-6, fast_multiplier: 2 },
};
const event = (model: string, tokens: Partial<UsageEvent['tokens']>, tier?: UsageEvent['tier']): UsageEvent => ({
  id: 'x', agent: 'codex', timestamp: '2026-01-01T00:00:00Z', model, tier,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...tokens },
});
const usd = (e: UsageEvent) => Number(cost(e, models)!.toFixed(6));

// Returning 0 for an unknown model would hide unpriced usage as free.
test('unknown model has no cost', () => assert.equal(cost(event('nope', { input: 1000 }), models), undefined));

test('standard rates', () => assert.equal(usd(event('m', { input: 100_000, output: 100_000, cacheRead: 50_000 })), 1.105));

// Dropping the tier logic prices long prompts and priority requests at the base rate.
test('long-context tier applies once the prompt crosses the threshold', () => {
  assert.equal(usd(event('m', { input: 100_000, cacheRead: 100_000 })), 0.11);
  assert.equal(usd(event('m', { input: 100_001, cacheRead: 100_000 })), 0.210002);
});
test('priority tier uses its own rate, and stacks with long context', () => {
  assert.equal(usd(event('m', { input: 1_000 }, 'priority')), 0.003);
  assert.equal(usd(event('m', { input: 300_000 }, 'priority')), 1.8);
});
test('fast multiplier is the fallback when no priority rate exists', () => assert.equal(usd(event('claudeish', { output: 1_000_000 }, 'priority')), 10));
test('one-hour cache writes use the one-hour rate', () => assert.equal(usd(event('claudeish', { cacheWrite: 1_000_000, cacheWrite1h: 250_000 })), 2.5));
