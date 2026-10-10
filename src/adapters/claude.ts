import { homedir } from 'node:os';
import { join } from 'node:path';
import { findFiles, readLines } from '../files.ts';
import type { Adapter, ParseResult, UsageEvent, UsageWindow } from '../types.ts';

const WINDOW_MINUTES: Record<string, number> = { five_hour: 300, seven_day: 10_080 };

const root = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');

export const claude: Adapter = {
  id: 'claude-code',
  roots: () => [root()],
  locate: (sinceMs) => findFiles(root(), (name) => name.endsWith('.jsonl'), sinceMs),

  async parse(file): Promise<ParseResult> {
    const byId = new Map<string, UsageEvent>();
    let warnings = 0;
    let limitHit: UsageWindow | undefined;
    for await (const line of readLines(file)) {
      if (!line.includes('"usage"') && !line.includes('"quotaLimits"')) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        warnings++;
        continue;
      }
      const quota = row.quotaLimits;
      // Claude Code logs no running quota, only the moment a limit rejects a request.
      if (quota?.status === 'rejected' && typeof quota.resetsAt === 'number') {
        limitHit = {
          agent: 'claude-code',
          account: 'unknown',
          limit: WINDOW_MINUTES[quota.rateLimitType] ? undefined : quota.rateLimitType,
          label: 'primary',
          windowMinutes: WINDOW_MINUTES[quota.rateLimitType] ?? 0,
          usedPercent: 100,
          limitHit: true,
          resetsAt: new Date(quota.resetsAt * 1000).toISOString(),
          observedAt: row.timestamp,
        };
      }
      const message = row.message;
      const usage = message?.usage;
      if (!usage || typeof usage.input_tokens !== 'number') continue;
      // One response is written once per content block; requestId can be absent, so message.id leads.
      const id = message.id ?? row.requestId ?? row.uuid;
      if (!id) {
        warnings++;
        continue;
      }
      byId.set(`claude-code:${id}`, {
        id: `claude-code:${id}`,
        agent: 'claude-code',
        timestamp: row.timestamp,
        model: message.model ?? 'unknown',
        sessionId: row.sessionId,
        cwd: row.cwd,
        tokens: {
          input: usage.input_tokens,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
          cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        },
        tier: usage.speed === 'fast' ? 'priority' : 'standard',
      });
    }
    return { events: [...byId.values()], windows: limitHit ? [limitHit] : [], warnings };
  },
};
