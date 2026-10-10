import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claude } from './adapters/claude.ts';
import { codex } from './adapters/codex.ts';
import { copilot } from './adapters/copilot.ts';
import { cursor } from './adapters/cursor.ts';
import { cost } from './pricing.ts';
import type { Adapter, ParseResult, UsageEvent, UsageWindow } from './types.ts';

export const adapters: Adapter[] = [claude, codex, copilot, cursor];

export interface AgentStats {
  agent: string;
  roots: string[];
  files: number;
  events: number;
  warnings: number;
  notes: string[];
}

export interface Scan {
  events: UsageEvent[];
  windows: UsageWindow[];
  warnings: number;
  files: number;
  agents: AgentStats[];
}

export interface Row {
  group: string;
  agent: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  apiEquivalentUsd: number;
  unpricedTokens: number;
  plans: string[];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

// Bump when ParseResult changes shape or an adapter changes what it derives from a file.
const CACHE_VERSION = 5;
type Cache = Record<string, { size: number; mtimeMs: number; result: ParseResult }>;
const cachePath = () => join(process.env.COSTLOG_CACHE_DIR ?? join(homedir(), '.cache', 'costlog'), 'index.json');

// The cache is never a source of truth: anything unreadable or from another version is dropped and rebuilt.
async function loadCache(): Promise<Cache> {
  try {
    const stored = JSON.parse(await readFile(cachePath(), 'utf8'));
    return stored.version === CACHE_VERSION ? stored.files : {};
  } catch {
    return {};
  }
}

async function saveCache(files: Cache): Promise<void> {
  const path = cachePath();
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify({ version: CACHE_VERSION, files }));
  await rename(`${path}.tmp`, path);
}

export async function scan(since: Date, until: Date, use: Adapter[] = adapters, useCache = true): Promise<Scan> {
  const cache = useCache ? await loadCache() : {};
  let parsed = 0;
  // ponytail: whole-file reuse keyed on size+mtime; a growing live session is re-read in full. Byte offsets if that shows up in timings.
  const parseCached = async (adapter: Adapter, file: string): Promise<ParseResult> => {
    const { size, mtimeMs } = await stat(file);
    const hit = cache[file];
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.result;
    parsed++;
    const result = await adapter.parse(file);
    if (!result.unsupported) cache[file] = { size, mtimeMs, result };
    return result;
  };

  const events = new Map<string, UsageEvent>();
  const windows = new Map<string, UsageWindow>();
  let warnings = 0;
  let files = 0;
  const agents: AgentStats[] = [];
  for (const adapter of use) {
    const located = await adapter.locate(since.getTime());
    files += located.length;
    const stats: AgentStats = { agent: adapter.id, roots: adapter.roots(), files: located.length, events: 0, warnings: 0, notes: [] };
    agents.push(stats);
    for (const result of await mapLimit(located, 16, (file) => parseCached(adapter, file))) {
      warnings += result.warnings;
      stats.warnings += result.warnings;
      if (result.unsupported && !stats.notes.includes(result.unsupported)) stats.notes.push(result.unsupported);
      for (const event of result.events) {
        const at = Date.parse(event.timestamp);
        if (at >= since.getTime() && at < until.getTime()) {
          if (!events.has(event.id)) stats.events++;
          events.set(event.id, event);
        }
      }
      for (const window of result.windows) {
        const key = [window.agent, window.account, window.plan, window.limit, window.label].join(':');
        const known = windows.get(key);
        if (!known || known.observedAt < window.observedAt) windows.set(key, window);
      }
    }
  }
  if (useCache && parsed) await saveCache(cache);
  return { events: [...events.values()], windows: [...windows.values()], warnings, files, agents };
}

// Partial data is never priced: a cost from a sample would read as the whole.
export const eventCost = (event: UsageEvent): number | undefined => (event.partial ? undefined : cost(event));

export function localDay(timestamp: string): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function aggregate(events: UsageEvent[], key: (event: UsageEvent) => string = (e) => localDay(e.timestamp)): Row[] {
  const rows = new Map<string, Row>();
  for (const event of events) {
    const group = key(event);
    // One plan per row, so per-plan figures are sums of rows a reader can see.
    const id = `${group}|${event.agent}|${event.plan ?? ''}`;
    const row = rows.get(id) ?? { group, agent: event.agent, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, apiEquivalentUsd: 0, unpricedTokens: 0, plans: event.plan ? [event.plan] : [] };
    row.requests++;
    row.input += event.tokens.input;
    row.output += event.tokens.output;
    row.cacheRead += event.tokens.cacheRead;
    row.cacheWrite += event.tokens.cacheWrite;
    const usd = eventCost(event);
    if (usd === undefined) row.unpricedTokens += event.tokens.input + event.tokens.output + event.tokens.cacheRead + event.tokens.cacheWrite;
    else row.apiEquivalentUsd += usd;
    rows.set(id, row);
  }
  return [...rows.values()].sort(
    (a, b) => a.group.localeCompare(b.group) || a.agent.localeCompare(b.agent) || (a.plans[0] ?? '').localeCompare(b.plans[0] ?? ''),
  );
}
