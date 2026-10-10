import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'costlog-cli-'));
mkdirSync(join(home, 'claude/projects/p'), { recursive: true });
mkdirSync(join(home, 'codex/sessions/2026/09/23'), { recursive: true });
cpSync(join(repo, 'fixtures/claude-code/stream-duplicates.jsonl'), join(home, 'claude/projects/p/s.jsonl'));
cpSync(join(repo, 'fixtures/codex/v0.155-token-usage-record.jsonl'), join(home, 'codex/sessions/2026/09/23/rollout-a.jsonl'));
const longRow = {
  type: 'assistant', timestamp: '2026-09-23T00:00:00Z', cwd: `/home/someone/${'deeply/nested/'.repeat(8)}project`, requestId: 'r1',
  message: { id: 'm1', model: 'some-extremely-long-model-name-2026-01-01-preview', usage: { input_tokens: 123_456_789_012, output_tokens: 5, cache_read_input_tokens: 987_654_321, cache_creation_input_tokens: 1 } },
};
const limitRow = {
  type: 'assistant', timestamp: '2026-09-23T01:00:00Z', requestId: 'r2',
  quotaLimits: { status: 'rejected', resetsAt: 1789312200, rateLimitType: 'five_hour' },
  message: { id: 'm2', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } },
};
writeFileSync(join(home, 'claude/projects/p/long.jsonl'), `${JSON.stringify(longRow)}\n${JSON.stringify(limitRow)}\n`);
const env = { ...process.env, CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), COPILOT_HOME: join(home, 'copilot'), CURSOR_STATE_DB: join(home, 'cursor.vscdb'), COSTLOG_CACHE_DIR: join(home, 'cache') };
const run = (...args: string[]) => execFileSync(process.execPath, [join(repo, 'src/cli.ts'), '--since', '2026-01-01', ...args], { env, encoding: 'utf8' });
const sorted = (o: object) => Object.keys(o).sort();

// Renaming or dropping any of these keys breaks scripts that read --json; bump schemaVersion instead.
test('--json schema v1 is stable', () => {
  const daily = JSON.parse(run('--json'));
  assert.deepEqual(sorted(daily), ['groupBy', 'planValue', 'pricedAt', 'rows', 'schemaVersion', 'since', 'totals', 'until', 'warnings']);
  assert.equal(daily.schemaVersion, 1);
  assert.deepEqual(sorted(daily.rows[0]), ['agent', 'apiEquivalentUsd', 'cacheRead', 'cacheWrite', 'group', 'input', 'output', 'plans', 'requests', 'unpricedTokens']);
  assert.deepEqual(sorted(daily.totals), ['apiEquivalentUsd', 'byPlan', 'unpricedTokens']);
  assert.deepEqual(new Set(daily.rows.map((r: { agent: string }) => r.agent)), new Set(['claude-code', 'codex']));

  const windows = JSON.parse(run('windows', '--json')).windows;
  assert.deepEqual(sorted(windows[0]), ['account', 'agent', 'expired', 'label', 'limit', 'observedAt', 'plan', 'resetsAt', 'usedPercent', 'windowMinutes']);
  // Without the quotaLimits branch Claude Code never shows up in the windows report.
  const claudeLimit = windows.find((w: { agent: string }) => w.agent === 'claude-code');
  assert.deepEqual([claudeLimit.limitHit, claudeLimit.windowMinutes], [true, 300]);
  assert.deepEqual(sorted(JSON.parse(run('doctor', '--json')).agents[0]), ['agent', 'events', 'files', 'notes', 'roots', 'warnings']);
});

// The README screenshot and narrow terminals depend on this.
test('tables fit 80 columns', () => {
  for (const args of [[], ['by', 'model'], ['by', 'project'], ['windows'], ['windows', '--all'], ['--help'], ['--plan-price', 'codex:prolite=200,claude=200,copilot=10']]) {
    const widest = Math.max(...run(...args).split('\n').map((line) => [...line].length));
    assert.ok(widest <= 80, `${args.join(' ') || 'daily'} is ${widest} columns wide`);
  }
});

// A daily row mixes priced and unpriced models, so the footer has to say where to look.
test('unpriced tokens point to the view that shows them', () => {
  assert.match(run(), /no known price: run `costlog by model`/);
  assert.match(run('by', 'model'), /no known price: shown as n\/a/);
});

// An empty table with $0.00 tells a newcomer they spent nothing, when costlog simply found no logs.
test('no logs at all exits 3 and says where it looked', () => {
  const empty = mkdtempSync(join(tmpdir(), 'costlog-empty-'));
  const bare = { ...process.env, CLAUDE_CONFIG_DIR: join(empty, 'c'), CODEX_HOME: join(empty, 'x'), COPILOT_HOME: join(empty, 'p'), CURSOR_STATE_DB: join(empty, 'u'), COSTLOG_CACHE_DIR: join(empty, 'cache') };
  const result = spawnSync(process.execPath, [join(repo, 'src/cli.ts')], { env: bare, encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no agent logs found on this machine/);
  assert.match(result.stderr, /missing {2}claude/);
  const json = spawnSync(process.execPath, [join(repo, 'src/cli.ts'), '--json'], { env: bare, encoding: 'utf8' });
  assert.deepEqual([json.status, JSON.parse(json.stdout).rows], [0, []]);
});

// Showing months-old percentages as if current was the main complaint about the windows report.
test('windows report separates open windows from ones that have reset', () => {
  const out = run('windows');
  assert.match(out, /No quota window is open right now/);
  assert.match(out, /\(reset\)/);
  assert.doesNotMatch(out, /^agent.*limit/m);
  assert.match(run('windows', '--all'), /hit \(reset\)/);
});

// Without the per-plan split the report cannot say how much usage a subscription covered.
test('cost is split by the plan recorded in the log', () => {
  const { totals } = JSON.parse(run('--json'));
  const sum = Object.values(totals.byPlan as Record<string, number>).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - totals.apiEquivalentUsd) < 1e-9);
  assert.ok(totals.byPlan.pro > 0);
  assert.match(run(), /ran on a plan per the log: pro \$/);
});

// A wrong proration or agent filter would tell someone their plan is worth several times more or less than it is.
test('--plan-price compares one agent against its prorated plan price', () => {
  const args = ['--since', '2026-09-01', '--until', '2026-09-30', '--plan-price', 'codex=20,claude=200'];
  const { planValue, rows } = JSON.parse(run(...args, '--json'));
  const codexUsd = rows.filter((r: { agent: string }) => r.agent === 'codex').reduce((sum: number, r: { apiEquivalentUsd: number }) => sum + r.apiEquivalentUsd, 0);
  const codex = planValue.find((p: { agent: string }) => p.agent === 'codex');
  assert.deepEqual([codex.days, codex.monthlyUsd, codex.periodUsd], [30, 20, 20]);
  assert.ok(codexUsd > 0 && Math.abs(codex.apiEquivalentUsd - codexUsd) < 1e-9);
  assert.ok(Math.abs(codex.ratio - codexUsd / 20) < 1e-9);
  assert.match(run(...args), /codex: \$[\d.]+ API-eq, \$20\.00 paid \(30d at \$20\.00\/mo\): (under )?[\d.]+(x|%)/);
  const onePlan = JSON.parse(run('--since', '2026-01-01', '--plan-price', 'codex:pro=20', '--json'));
  const proUsd = onePlan.rows.filter((r: { agent: string; plans: string[] }) => r.agent === 'codex' && r.plans[0] === 'pro').reduce((sum: number, r: { apiEquivalentUsd: number }) => sum + r.apiEquivalentUsd, 0);
  assert.ok(proUsd > 0 && Math.abs(onePlan.planValue[0].apiEquivalentUsd - proUsd) < 1e-9);
  const half = JSON.parse(run('--since', '2026-09-16', '--until', '2026-09-30', '--plan-price', 'codex=20', '--json')).planValue[0];
  assert.deepEqual([half.days, half.periodUsd], [15, 10]);
  assert.throws(() => run('--plan-price', 'cursor=20'), /never priced/);
  assert.throws(() => run('--plan-price', 'gemini=20'), /unknown agent/);
  assert.throws(() => run('--plan-price', 'codex=free'), /monthly price in USD/);
});

// Totals that change between views, or drift from the table without saying so, look like bugs in a cost tool.
test('totals are the same in every view and never drift silently from the table', () => {
  const totals = new Set<string>();
  for (const args of [['--since', '2026-01-01'], ['by', 'model', '--since', '2026-01-01'], ['by', 'project', '--since', '2026-01-01']]) {
    const out = run(...args, '--plan-price', 'codex=20,claude=100');
    const lines = out.split('\n');
    const cells = lines.slice(2, lines.indexOf('')).map((line) => line.trim().split(/\s+/));
    const cents = (text: string) => Math.round(Number(text) * 100);
    const sum = (rows: string[][]) => rows.reduce((total, row) => total + (row.at(-2) === 'n/a' ? 0 : cents(row.at(-2)!)), 0);
    const figure = (pattern: RegExp) => cents(pattern.exec(out)![1]);
    const total = figure(/API-eq total \$(\d+\.\d\d)/);
    totals.add(`${total} ${figure(/codex: \$(\d+\.\d\d) API-eq/)} ${figure(/claude: \$(\d+\.\d\d) API-eq/)} ${figure(/No plan in the log \("-"\): \$(\d+\.\d\d)/)}`);
    assert.ok(Math.abs(total - sum(cells)) <= cells.length, `total is ${total - sum(cells)} cents away from the cells`);
    assert.equal(total !== sum(cells), /Cells are rounded to the cent/.test(out));
  }
  assert.equal(totals.size, 1, `views disagree: ${[...totals].join(' | ')}`);

  // The demo's daily cells sum to one cent less than its total; without the note that reads as an arithmetic error.
  const demo = (...args: string[]) => execFileSync(process.execPath, [join(repo, 'scripts/demo.mjs'), ...args], { encoding: 'utf8' });
  assert.match(demo(), /API-eq total \$79\.41[\s\S]*Cells are rounded to the cent/);
  assert.doesNotMatch(demo('by', 'model'), /Cells are rounded/);
});

// The status line is one short line that other tools print verbatim, so its shape must not drift.
test('statusline prints one line with today and any open window', () => {
  const demo = (...args: string[]) => execFileSync(process.execPath, [join(repo, 'scripts/demo.mjs'), ...args], { encoding: 'utf8' });
  const line = demo('statusline');
  assert.match(line, /^\$\d+\.\d\d API-eq today · codex 5h 62% 7d 31%\n$/);
  const json = JSON.parse(demo('statusline', '--json'));
  assert.deepEqual(sorted(json), ['schemaVersion', 'text', 'todayUsd', 'windows']);
  assert.equal(`${json.text}\n`, line);
  assert.match(run('statusline'), /^\$0\.00 API-eq today\n$/);
});

// The hook runs after every turn: it must never fail the session, pile up work, or leave a half-written line.
test('status line hook refreshes at most once a minute and survives a missing binary', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'costlog-hook-'));
  const hook = join(repo, 'hooks/refresh-statusline.sh');
  const file = join(dir, 'statusline.txt');
  const fire = (bin: string) => spawnSync('sh', [hook], { env: { ...env, COSTLOG_CACHE_DIR: dir, COSTLOG_BIN: bin }, encoding: 'utf8' });
  const cli = `${process.execPath} ${join(repo, 'src/cli.ts')}`;
  // The refresh is detached from the hook, so its result arrives a moment after the hook returns.
  const settled = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  };
  const read = () => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const noTmp = () => !readdirSync(dir).some((name) => name.endsWith('.tmp'));

  assert.equal(fire(cli).status, 0);
  await settled(() => /API-eq today/.test(read()));
  assert.match(read(), /^\$\d+\.\d\d API-eq today/);
  await settled(noTmp);

  writeFileSync(file, 'fresh\n');
  fire(cli);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(read(), 'fresh\n');

  utimesSync(file, new Date(0), new Date(0));
  assert.equal(fire('/nonexistent/costlog').status, 0);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await settled(noTmp);
  assert.equal(read(), 'fresh\n');
  assert.ok(noTmp());

  fire(cli);
  await settled(() => /API-eq today/.test(read()));
  assert.match(read(), /API-eq today/);
});

// Ignoring a bad price file would print costs that look valid.
test('--pricing-file prices unknown models and rejects malformed files', () => {
  const before = JSON.parse(run('by', 'model', '--json'));
  const model = before.rows.find((r: { agent: string }) => r.agent === 'codex').group;
  const prices = join(home, 'prices.json');
  writeFileSync(prices, JSON.stringify({ [model]: { input_cost_per_token: 1, output_cost_per_token: 0 } }));
  const after = JSON.parse(run('by', 'model', '--json', '--pricing-file', prices));
  const row = after.rows.find((r: { group: string }) => r.group === model);
  assert.equal(row.apiEquivalentUsd, row.input);

  writeFileSync(prices, JSON.stringify({ [model]: { output_cost_per_token: 'free' } }));
  assert.throws(() => run('--pricing-file', prices), /needs numeric/);
  assert.throws(() => run('--since', 'yesterday'), /invalid date/);
  assert.throws(() => run('by', 'nothing'), /unknown command/);
});
