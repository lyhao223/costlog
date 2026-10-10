#!/usr/bin/env node
// Usage: node scripts/demo.mjs [costlog args]   Runs costlog on made-up logs, for screenshots and for trying it without real data.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'costlog-demo-'));
const at = (daysAgo, minute = 0) => new Date(Date.now() - daysAgo * 86_400_000 - (60 - minute) * 60_000).toISOString();
const write = (path, rows) => {
  mkdirSync(join(home, path, '..'), { recursive: true });
  writeFileSync(join(home, path), rows.map((row) => JSON.stringify(row)).join('\n'));
};

const claudeRows = [];
const codexRows = [{ type: 'session_meta', timestamp: at(6), payload: { session_id: 'demo', cwd: '/work/api', creator_account_id: 'acct-demo-1' } }];
let total = 0;
for (let day = 6; day >= 0; day--) {
  for (let n = 0; n < 4; n++) {
    const scale = 1 + ((day * 7 + n * 3) % 5);
    claudeRows.push({
      type: 'assistant', timestamp: at(day, n), cwd: '/work/web', requestId: `r${day}-${n}`,
      message: { id: `m${day}-${n}`, model: n ? 'claude-opus-5' : 'claude-sonnet-5-5',
        usage: { input_tokens: 40 * scale, output_tokens: 9_000 * scale, cache_read_input_tokens: 600_000 * scale, cache_creation_input_tokens: 20_000 * scale } },
    });
    const usage = { input_tokens: 420_000 * scale, cached_input_tokens: 400_000 * scale, output_tokens: 6_000 * scale, reasoning_output_tokens: 2_000 * scale };
    total += usage.input_tokens + usage.output_tokens;
    codexRows.push({ type: 'turn_context', timestamp: at(day, n), payload: { model: n % 2 ? 'gpt-5.6-sol' : 'qwen3.8-max' } });
    codexRows.push({
      type: 'event_msg', timestamp: at(day, n),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: { total_tokens: total } },
        rate_limits: { plan_type: 'pro', limit_id: 'codex',
          primary: { used_percent: 62 - day * 8, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3 * 3600 },
          secondary: { used_percent: 31 - day * 3, window_minutes: 10_080, resets_at: Math.floor(Date.now() / 1000) + 4 * 86_400 } } },
    });
  }
}
write('claude/projects/web/session.jsonl', claudeRows);
write('codex/sessions/2026/01/01/rollout-demo.jsonl', codexRows);
write('copilot/session-state/demo/events.jsonl', [
  { type: 'session.start', timestamp: at(2), data: { sessionId: 'demo', context: { cwd: '/work/docs' } } },
  { type: 'session.shutdown', timestamp: at(2, 30), data: { modelMetrics: { 'claude-opus-4.8': { usage: { inputTokens: 5_600_000, outputTokens: 74_000, cacheReadTokens: 5_200_000, cacheWriteTokens: 380_000 } } } } },
]);

const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), COPILOT_HOME: join(home, 'copilot'),
  CURSOR_STATE_DB: join(home, 'none.vscdb'), COSTLOG_CACHE_DIR: join(home, 'cache'),
};
// Node older than 22.18 cannot run the TypeScript sources, so it uses the build.
const [major, minor] = process.versions.node.split('.').map(Number);
const entry = major > 22 || (major === 22 && minor >= 18) ? '../src/cli.ts' : '../dist/cli.js';
const cli = fileURLToPath(new URL(entry, import.meta.url));
process.exit(spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { env, stdio: 'inherit' }).status ?? 1);
