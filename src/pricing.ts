import { readFileSync } from 'node:fs';
import type { UsageEvent } from './types.ts';

type Rates = Record<string, number>;

const data = JSON.parse(readFileSync(new URL('../data/pricing.json', import.meta.url), 'utf8'));
const bundled: Record<string, Rates> = data.models;
export const pricedAt: string = data.fetchedAt;

// Throws on anything malformed: a silently ignored price file would report wrong costs as if they were right.
export function loadOverrides(path: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read pricing file ${path}: ${(error as Error).message}`);
  }
  const models = (parsed as { models?: unknown })?.models ?? parsed;
  if (!models || typeof models !== 'object' || Array.isArray(models)) throw new Error(`pricing file ${path} must be a JSON object of models`);
  for (const [name, rates] of Object.entries(models as Record<string, Rates>)) {
    if (typeof rates?.input_cost_per_token !== 'number' || Object.values(rates).some((v) => typeof v !== 'number' || v < 0)) {
      throw new Error(`pricing file ${path}: "${name}" needs numeric, non-negative rates including input_cost_per_token`);
    }
    bundled[name] = rates;
  }
}

function lookup(models: Record<string, Rates>, model: string): Rates | undefined {
  // Copilot writes claude-opus-4.8 where the price table has claude-opus-4-8.
  return models[model] ?? models[model.replace(/-\d{8}$/, '')] ?? models[model.replace(/\./g, '-')];
}

export const inputRate = (model: string): number | undefined => lookup(bundled, model)?.input_cost_per_token;

function threshold(rates: Rates): number | undefined {
  for (const key of Object.keys(rates)) {
    const match = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(key);
    if (match) return Number(match[1]) * 1000;
  }
  return undefined;
}

// Returns undefined when the model has no price, so callers report unpriced tokens instead of $0.
export function cost(event: UsageEvent, models: Record<string, Rates> = bundled): number | undefined {
  const rates = lookup(models, event.model);
  if (!rates) return undefined;
  const t = event.tokens;
  const limit = threshold(rates);
  // The long-context tier reprices the whole request once its prompt crosses the threshold.
  const above = limit !== undefined && t.input + t.cacheRead + t.cacheWrite > limit ? `_above_${limit / 1000}k_tokens` : '';
  const priority = event.tier === 'priority';

  const rate = (base: string): number => {
    const standard = rates[base + above] ?? rates[base] ?? 0;
    if (!priority) return standard;
    return rates[`${base}${above}_priority`] ?? standard * (rates.fast_multiplier ?? 1);
  };
  const write1h = t.cacheWrite1h ?? 0;
  const write1hRate = rates.cache_creation_input_token_cost_above_1hr;
  const writeCost =
    write1hRate === undefined
      ? t.cacheWrite * rate('cache_creation_input_token_cost')
      : (t.cacheWrite - write1h) * rate('cache_creation_input_token_cost') +
        write1h * write1hRate * (priority ? (rates.fast_multiplier ?? 1) : 1);

  return (
    t.input * rate('input_cost_per_token') +
    t.output * rate('output_cost_per_token') +
    t.cacheRead * rate('cache_read_input_token_cost') +
    writeCost
  );
}
