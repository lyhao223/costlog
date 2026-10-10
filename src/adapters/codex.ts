import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findFiles, readLines } from '../files.ts';
import type { Adapter, ParseResult, UsageEvent, UsageWindow } from '../types.ts';

const home = () => process.env.CODEX_HOME ?? join(homedir(), '.codex');
const isRollout = (name: string) => name.startsWith('rollout-') && name.endsWith('.jsonl');

type Tier = UsageEvent['tier'];
const toTier = (value: unknown): Tier => (value === 'priority' ? 'priority' : value ? 'standard' : undefined);

// Sessions that never record their tier ran with whatever config.toml set at the top level.
function configTier(): Tier {
  try {
    const top = readFileSync(join(home(), 'config.toml'), 'utf8').split(/^\[/m)[0];
    return toTier(/^service_tier\s*=\s*"([^"]+)"/m.exec(top)?.[1]) ?? 'standard';
  } catch {
    return 'standard';
  }
}

interface RawUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

function toEvent(id: string, usage: RawUsage, timestamp: string, model: string, tier: Tier, sessionId?: string, cwd?: string): UsageEvent {
  const cached = usage.cached_input_tokens ?? 0;
  return {
    id: `codex:${id}`,
    agent: 'codex',
    timestamp,
    model,
    sessionId,
    cwd,
    tier,
    tokens: {
      input: (usage.input_tokens ?? 0) - cached,
      output: usage.output_tokens ?? 0,
      cacheRead: cached,
      cacheWrite: usage.cache_write_input_tokens ?? 0,
      reasoning: usage.reasoning_output_tokens ?? 0,
    },
  };
}

function toWindows(limits: any, account: string, observedAt: string): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const label of ['primary', 'secondary']) {
    const w = limits?.[label];
    if (!w || typeof w.used_percent !== 'number' || typeof w.resets_at !== 'number') continue;
    windows.push({
      agent: 'codex',
      account,
      plan: limits.plan_type ?? undefined,
      limit: limits.limit_id ?? undefined,
      label,
      windowMinutes: w.window_minutes,
      usedPercent: w.used_percent,
      resetsAt: new Date(w.resets_at * 1000).toISOString(),
      observedAt,
    });
  }
  return windows;
}

export const codex: Adapter = {
  id: 'codex',
  roots: () => ['sessions', 'archived_sessions'].map((dir) => join(home(), dir)),
  async locate(sinceMs) {
    const found = await Promise.all(codex.roots().map((dir) => findFiles(dir, isRollout, sinceMs)));
    return found.flat();
  },

  async parse(file): Promise<ParseResult> {
    const fromRecords = new Map<string, UsageEvent>();
    const fromCounts: UsageEvent[] = [];
    let windows: UsageWindow[] = [];
    let warnings = 0;
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let account = 'unknown';
    let model = 'unknown';
    let previousTotal: number | undefined;
    let tier = configTier();
    let plan: string | undefined;
    let lineNo = 0;

    for await (const line of readLines(file)) {
      lineNo++;
      if (lineNo > 1 && !line.includes('"token_') && !line.includes('"turn_context"') && !line.includes('"thread_settings_applied"')) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        warnings++;
        continue;
      }
      const payload = row.payload ?? {};
      if (row.type === 'session_meta') {
        sessionId = payload.session_id ?? payload.id;
        cwd = payload.cwd;
        account = payload.creator_account_id ?? account;
      } else if (row.type === 'turn_context') {
        model = payload.model ?? model;
      } else if (payload.type === 'thread_settings_applied') {
        tier = toTier(payload.thread_settings?.service_tier) ?? tier;
      } else if (row.type === 'token_usage_record' && payload.usage) {
        const id = payload.response_id ?? `${file}:${lineNo}`;
        fromRecords.set(id, toEvent(id, payload.usage, row.timestamp, model, tier, sessionId, cwd));
      } else if (row.type === 'event_msg' && payload.type === 'token_count') {
        const observed = toWindows(payload.rate_limits, account, row.timestamp);
        if (observed.length) windows = observed;
        plan = payload.rate_limits?.plan_type ?? plan;
        const info = payload.info;
        if (!info?.last_token_usage) continue;
        const total = info.total_token_usage?.total_tokens;
        // Codex re-emits the same count after a turn; an unchanged running total means no new request.
        if (total !== previousTotal) {
          fromCounts.push(toEvent(`${sessionId ?? file}:${lineNo}`, info.last_token_usage, row.timestamp, model, tier, sessionId, cwd));
        }
        previousTotal = total;
      }
    }
    // ponytail: a file is read as all-records or all-counts; a session resumed across the 0.153 format change undercounts its older half.
    const events = fromRecords.size ? [...fromRecords.values()] : fromCounts;
    for (const event of events) event.plan = plan;
    return { events, windows, warnings };
  },
};
