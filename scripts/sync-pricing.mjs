#!/usr/bin/env node
// Usage: node scripts/sync-pricing.mjs [path-to-litellm-json]   (no argument fetches LiteLLM main)
import { readFileSync, writeFileSync } from 'node:fs';

const SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PROVIDERS = new Set(['openai', 'anthropic', 'gemini']);
const RATE = /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)(_above_\d+k_tokens|_above_1hr)?(_priority)?$/;

const local = process.argv[2];
const raw = local ? JSON.parse(readFileSync(local, 'utf8')) : await (await fetch(SOURCE)).json();

const models = {};
for (const [name, entry] of Object.entries(raw).sort(([a], [b]) => a.localeCompare(b))) {
  if (!PROVIDERS.has(entry?.litellm_provider) || name.includes('/')) continue;
  const rates = Object.fromEntries(Object.entries(entry).filter(([key, value]) => RATE.test(key) && typeof value === 'number'));
  if (rates.input_cost_per_token === undefined) continue;
  if (typeof entry.provider_specific_entry?.fast === 'number') rates.fast_multiplier = entry.provider_specific_entry.fast;
  models[name] = rates;
}
writeFileSync(new URL('../data/pricing.json', import.meta.url), `${JSON.stringify({ source: SOURCE, fetchedAt: new Date().toISOString().slice(0, 10), models }, null, 1)}\n`);
console.log(`wrote data/pricing.json with ${Object.keys(models).length} models`);
