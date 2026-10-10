import { homedir } from 'node:os';
import { join } from 'node:path';
import { findFiles, readLines } from '../files.ts';
import type { Adapter, ParseResult, UsageEvent } from '../types.ts';

const root = () => join(process.env.COPILOT_HOME ?? join(homedir(), '.copilot'), 'session-state');

export const copilot: Adapter = {
  id: 'copilot-cli',
  roots: () => [root()],
  locate: (sinceMs) => findFiles(root(), (name) => name === 'events.jsonl', sinceMs),

  async parse(file): Promise<ParseResult> {
    const events: UsageEvent[] = [];
    let warnings = 0;
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let segment = 0;

    for await (const line of readLines(file)) {
      if (!line.includes('"session.start"') && !line.includes('"session.shutdown"')) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        warnings++;
        continue;
      }
      if (row.type === 'session.start') {
        sessionId = row.data?.sessionId;
        cwd = row.data?.context?.cwd;
      } else if (row.type === 'session.shutdown') {
        // ponytail: Copilot only writes totals when a session shuts down, so an open or crashed session reports nothing.
        segment++;
        for (const [model, metrics] of Object.entries<any>(row.data?.modelMetrics ?? {})) {
          const usage = metrics?.usage;
          if (!usage) continue;
          const cacheRead = usage.cacheReadTokens ?? 0;
          const cacheWrite = usage.cacheWriteTokens ?? 0;
          events.push({
            id: `copilot-cli:${sessionId ?? file}:${segment}:${model}`,
            agent: 'copilot-cli',
            timestamp: row.timestamp,
            model,
            sessionId,
            cwd,
            tokens: {
              input: Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite),
              output: usage.outputTokens ?? 0,
              cacheRead,
              cacheWrite,
              reasoning: usage.reasoningTokens ?? 0,
            },
          });
        }
      }
    }
    return { events, windows: [], warnings };
  },
};
