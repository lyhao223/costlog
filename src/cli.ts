#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { aggregate, eventCost, scan } from './core.ts';
import { inputRate, loadOverrides, pricedAt } from './pricing.ts';
import type { UsageEvent, UsageWindow } from './types.ts';

const USAGE = `usage: costlog [by model|by project|windows|doctor|statusline]
  --since YYYY-MM-DD   first day, local time (default: 30 days back)
  --until YYYY-MM-DD   last day, inclusive (default: today)
  --plan-price LIST    what you pay per month, e.g. claude=200,codex:pro=200:
                       compares it with the API-equivalent cost of that agent
                       (agent:plan limits it to usage the log ties to that plan)
  --pricing-file PATH  extra prices as JSON, merged over the built-in table:
                       {"model": {"input_cost_per_token": 0.000001, ...}}
  --json               machine-readable output
  --no-cache           re-read every log file
  --all                windows: include snapshots whose window has reset

Exit codes: 0 ok, 1 bad arguments, 3 no agent logs found.`;

function fail(message: string): never {
  console.error(`costlog: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function localMidnight(text: string | undefined, fallback: Date): Date {
  if (!text) return fallback;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) fail(`invalid date "${text}", expected YYYY-MM-DD`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function compact(n: number): string {
  if (n < 1_000) return String(n);
  for (const [unit, size] of [['K', 1e3], ['M', 1e6], ['B', 1e9]] as const) {
    if (n < size * 1_000) return `${(n / size).toFixed(n < size * 100 ? 1 : 0)}${unit}`;
  }
  return `${(n / 1e12).toFixed(1)}T`;
}

function table(head: string[], body: string[][], leftColumns = 2): string {
  const width = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i < leftColumns ? c.padEnd(width[i]) : c.padStart(width[i]))).join('  ').trimEnd();
  return [line(head), width.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}

const clip = (text: string, max: number) => (text.length > max ? `…${text.slice(1 - max)}` : text);
const shortAgent = (agent: string) => agent.replace(/-(code|cli)$/, '');

function windowLabel(w: UsageWindow): string {
  const hours = w.windowMinutes / 60;
  return hours === 0 ? 'n/a' : hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`;
}

function age(iso: string): string {
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  return hours < 1 ? `${Math.max(0, Math.round(hours * 60))}m` : hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

const GROUPS: Record<string, (event: UsageEvent) => string> = {
  model: (e) => e.model,
  project: (e) => (e.cwd ? e.cwd.replace(homedir(), '~') : '(unknown)'),
};

let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      'pricing-file': { type: 'string' },
      'plan-price': { type: 'string' },
      json: { type: 'boolean', default: false },
      'no-cache': { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (error) {
  fail((error as Error).message);
}
const { positionals } = parsed;
const values = parsed.values as Record<string, string | boolean | undefined>;
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const command = positionals[0] ?? 'daily';
const groupBy = command === 'by' ? positionals[1] : command === 'daily' ? 'day' : undefined;
if (!['daily', 'by', 'windows', 'doctor', 'statusline'].includes(command) || (command === 'by' && !(positionals[1] in GROUPS))) {
  fail(`unknown command "${positionals.join(' ')}"`);
}

const today = new Date();
today.setHours(0, 0, 0, 0);
// The status line always covers today, plus a week back so a 7-day window still open is found.
const since =
  command === 'statusline'
    ? new Date(today.getTime() - 7 * 86_400_000)
    : localMidnight(values.since as string | undefined, new Date(today.getTime() - 29 * 86_400_000));
const lastDay = localMidnight(values.until as string | undefined, today);
const until = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1);
if (values['pricing-file']) {
  try {
    loadOverrides(values['pricing-file'] as string);
  } catch (error) {
    fail((error as Error).message);
  }
}

const PLAN_AGENTS: Record<string, string> = { claude: 'claude-code', codex: 'codex', copilot: 'copilot-cli' };
const planPrices: { name: string; agent: string; plan?: string; monthlyUsd: number }[] = [];
for (const part of ((values['plan-price'] as string | undefined) ?? '').split(',').filter(Boolean)) {
  const [name, amount] = part.split('=');
  const [agentName, plan] = name.split(':');
  const monthlyUsd = Number(amount);
  if (agentName === 'cursor') fail('--plan-price cursor: Cursor usage is never priced, so there is nothing to compare');
  if (!(agentName in PLAN_AGENTS)) fail(`--plan-price: unknown agent "${agentName}", expected ${Object.keys(PLAN_AGENTS).join(', ')}`);
  if (!amount || !Number.isFinite(monthlyUsd) || monthlyUsd <= 0) fail(`--plan-price ${name}: expected a monthly price in USD, e.g. ${name}=200`);
  planPrices.push({ name, agent: PLAN_AGENTS[agentName], plan: plan || undefined, monthlyUsd });
}

const result = await scan(since, until, undefined, !values['no-cache']);
const meta = { schemaVersion: 1, since: ymd(since), until: ymd(lastDay) };
const tilde = (path: string) => path.replace(homedir(), '~');

// An empty table with $0.00 reads as "you spent nothing"; say what was looked for instead.
if (command !== 'doctor' && !values.json && result.files === 0) {
  const anyRoot = result.agents.some((a) => a.roots.some((root) => existsSync(root)));
  console.error(anyRoot ? `costlog: no agent log was modified between ${meta.since} and ${meta.until}.` : 'costlog: no agent logs found on this machine.');
  for (const a of result.agents) {
    for (const root of a.roots) console.error(`  ${existsSync(root) ? 'found  ' : 'missing'}  ${shortAgent(a.agent).padEnd(7)}  ${tilde(root)}`);
  }
  console.error(anyRoot ? 'Older sessions are skipped. Try an earlier start: --since YYYY-MM-DD' : 'Logs elsewhere? Set CLAUDE_CONFIG_DIR, CODEX_HOME, COPILOT_HOME or CURSOR_STATE_DB.');
  process.exit(3);
}

if (command === 'statusline') {
  const now = new Date().toISOString();
  const todayUsd = result.events.filter((e) => Date.parse(e.timestamp) >= today.getTime()).reduce((sum, e) => sum + (eventCost(e) ?? 0), 0);
  const open = result.windows.filter((w) => w.resetsAt > now).sort((a, b) => a.windowMinutes - b.windowMinutes);
  const quota = [...new Set(open.map((w) => w.agent))].map(
    (agent) => `${shortAgent(agent)} ${open.filter((w) => w.agent === agent).map((w) => `${windowLabel(w)} ${w.limitHit ? 'hit' : `${w.usedPercent}%`}`).join(' ')}`,
  );
  const text = [`$${todayUsd.toFixed(2)} API-eq today`, ...quota].join(' · ');
  console.log(values.json ? JSON.stringify({ schemaVersion: 1, todayUsd, windows: open, text }, null, 2) : text);
} else if (command === 'doctor') {
  if (values.json) console.log(JSON.stringify({ ...meta, agents: result.agents }, null, 2));
  else {
    for (const a of result.agents) {
      const status = a.notes.length
        ? `not read: ${a.notes.join('; ')}`
        : a.files === 0
          ? 'no log files in range'
          : a.events === 0
            ? 'FILES FOUND, 0 REQUESTS PARSED: log format may have changed'
            : 'ok';
      console.log(`${a.agent}: ${status}`);
      for (const root of a.roots) console.log(`  ${existsSync(root) ? 'found  ' : 'missing'}  ${tilde(root)}`);
      console.log(`  ${a.files} files, ${a.events} requests, ${a.warnings} unreadable lines`);
    }
  }
} else if (command === 'windows') {
  const now = new Date().toISOString();
  const windows = result.windows
    .map((w) => ({ ...w, expired: w.resetsAt <= now }))
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  if (values.json) console.log(JSON.stringify({ ...meta, windows }, null, 2));
  else {
    const live = windows.filter((w) => !w.expired);
    const shown = values.all ? windows : live.length ? live : windows.slice(0, 3);
    const hidden = windows.length - shown.length;
    if (!windows.length) console.log('No quota window is recorded in the logs for this period.');
    else {
      if (!live.length) console.log('No quota window is open right now. Latest snapshots, all reset since:\n');
      // A limit named after its agent adds nothing; keep the column only when some limit says more.
      const namedLimit = shown.some((w) => w.limit && w.limit !== shortAgent(w.agent));
      const columns: [string, (w: (typeof shown)[number]) => string][] = [
        ['agent', (w) => shortAgent(w.agent)],
        ['account', (w) => (w.account === 'unknown' ? '-' : w.account.slice(0, 8))],
        ['plan', (w) => w.plan ?? '-'],
        ...(namedLimit ? [['limit', (w: (typeof shown)[number]) => clip(w.limit ?? '-', 12)] as [string, (w: (typeof shown)[number]) => string]] : []),
        ['window', (w) => windowLabel(w)],
        ['used', (w) => `${w.limitHit ? 'hit' : `${w.usedPercent}%`}${w.expired ? ' (reset)' : ''}`],
        ['resets UTC', (w) => w.resetsAt.slice(5, 16).replace('T', ' ')],
        ['age', (w) => age(w.observedAt)],
      ];
      console.log(table(columns.map(([name]) => name), shown.map((w) => columns.map(([, cell]) => cell(w))), namedLimit ? 4 : 3));
      console.log('\nRows are snapshots from each account\'s last session, not live quota.');
      if (hidden) console.log(`${hidden} snapshots whose window has since reset are hidden; --all shows them.`);
      if (shown.some((w) => w.limitHit)) console.log('"hit": Claude Code logs only the moment a limit rejects a request.');
      if (shown.some((w) => w.agent === 'codex' && w.account === 'unknown')) {
        console.log('"-" account: Codex records the account id only from CLI 0.159.');
      }
    }
    if (!windows.some((w) => w.agent === 'claude-code')) {
      console.log('Claude Code: no limit was hit in this period, and its logs record nothing else.');
    }
  }
} else {
  const all = aggregate(result.events, groupBy === 'day' ? undefined : GROUPS[groupBy!]);
  const rows = all.filter((r) => r.input + r.output + r.cacheRead + r.cacheWrite > 0);
  const cursorResponses = result.events.filter((e) => e.agent === 'cursor');
  const cursorCounted = cursorResponses.filter((e) => e.tokens.input + e.tokens.output > 0).length;
  if (groupBy !== 'day') rows.sort((a, b) => b.apiEquivalentUsd - a.apiEquivalentUsd || b.unpricedTokens - a.unpricedTokens);
  const byPlan: Record<string, number> = {};
  for (const event of result.events) {
    const usd = eventCost(event);
    if (usd) byPlan[event.plan ?? 'none'] = (byPlan[event.plan ?? 'none'] ?? 0) + usd;
  }
  const days = Math.round((until.getTime() - since.getTime()) / 86_400_000);
  // ponytail: a month is taken as 30 days; billing-cycle dates are not in any log.
  const covers = (p: (typeof planPrices)[number], agent: string, plan: string | undefined) => agent === p.agent && (!p.plan || plan === p.plan);
  const planValue = planPrices.map((p) => {
    const apiEquivalentUsd = result.events.filter((e) => covers(p, e.agent, e.plan)).reduce((sum, e) => sum + (eventCost(e) ?? 0), 0);
    const periodUsd = (p.monthlyUsd * days) / 30;
    return { agent: p.agent, plan: p.plan, monthlyUsd: p.monthlyUsd, days, periodUsd, apiEquivalentUsd, ratio: apiEquivalentUsd / periodUsd };
  });
  // Totals are exact and identical in every view; cells are rounded, so the footer says when they differ.
  const cents = (r: { apiEquivalentUsd: number }) => Math.round(r.apiEquivalentUsd * 100);
  const shownUsd = (pick: (r: (typeof rows)[number]) => boolean) => rows.filter(pick).reduce((sum, r) => sum + r.apiEquivalentUsd, 0);
  const totals = {
    apiEquivalentUsd: rows.reduce((sum, r) => sum + r.apiEquivalentUsd, 0),
    unpricedTokens: rows.reduce((sum, r) => sum + r.unpricedTokens, 0),
    byPlan,
  };
  if (values.json) {
    console.log(JSON.stringify({ ...meta, groupBy, pricedAt, rows, totals, planValue, warnings: result.warnings }, null, 2));
  } else if (!rows.length) {
    console.log(`No usage recorded between ${meta.since} and ${meta.until}. Try an earlier --since YYYY-MM-DD.`);
  } else {
    console.log(
      table(
        [groupBy!, 'agent', 'input', 'output', 'cacheR', 'cacheW', 'API-eq $', 'plan'],
        rows.map((r) => [
          clip(r.group, 20),
          shortAgent(r.agent),
          compact(r.input),
          compact(r.output),
          compact(r.cacheRead),
          compact(r.cacheWrite),
          r.unpricedTokens && !r.apiEquivalentUsd ? 'n/a' : (cents(r) / 100).toFixed(2),
          r.plans[0] ?? '-',
        ]),
      ),
    );
    const usd = (n: number) => `$${n.toFixed(2)}`;
    const plans = [...new Set(rows.flatMap((r) => r.plans))].sort();
    const noPlanUsd = shownUsd((r) => !r.plans.length);
    console.log(`\nAPI-eq total ${usd(shownUsd(() => true))}: what these tokens cost at API list prices. Not a bill.`);
    if (plans.length) {
      console.log(`Of that, ran on a plan per the log: ${plans.map((plan) => `${plan} ${usd(shownUsd((r) => r.plans[0] === plan))}`).join(', ')}.`);
      console.log('That usage drew on plan quota and was not billed at this price.');
    }
    if (noPlanUsd) console.log(`No plan in the log ("-"): ${usd(noPlanUsd)}. Claude Code and Copilot never log one.`);
    planPrices.forEach((p, index) => {
      const value = planValue[index];
      const used = shownUsd((r) => covers(p, r.agent, r.plans[0]));
      const ratio = used / value.periodUsd;
      const verdict = ratio >= 1 ? `${ratio.toFixed(1)}x` : ratio < 0.001 ? 'under 0.1%' : `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%`;
      console.log(`${p.name}: ${usd(used)} API-eq, ${usd(value.periodUsd)} paid (${days}d at ${usd(p.monthlyUsd)}/mo): ${verdict}`);
      const mixed = [...new Set(rows.filter((r) => r.agent === p.agent).flatMap((r) => r.plans))];
      if (!p.plan && mixed.length > 1) console.log(`  ${p.name} ran on ${mixed.join(' and ')}; price them apart with ${p.name}:${mixed[0]}=...`);
    });
    if (rows.reduce((sum, r) => sum + cents(r), 0) !== Math.round(shownUsd(() => true) * 100)) {
      console.log('Cells are rounded to the cent; totals are exact, so they can differ by a cent.');
    }
    if (planPrices.length) console.log('Plan lines: API-eq over what you paid, assuming the plan ran the whole period.');
    else console.log('Add --plan-price claude=200,codex=200 to compare this with what you pay.');
    if (groupBy === 'model') {
      const rated = rows.map((r) => [r.group, inputRate(r.group)] as const).filter((x): x is readonly [string, number] => x[1] !== undefined);
      if (rated.length > 1) {
        const [low, high] = [rated.reduce((a, b) => (b[1] < a[1] ? b : a)), rated.reduce((a, b) => (b[1] > a[1] ? b : a))];
        const per = (rate: number) => `$${(rate * 1e6).toFixed(2)}`;
        console.log(`Input price per 1M tokens: ${per(low[1])} (${clip(low[0], 20)}) to ${per(high[1])} (${clip(high[0], 20)}).`);
      }
    }
    if (groupBy === 'day') console.log('A day can mix models with different prices: `costlog by model` splits them.');
    if (totals.unpricedTokens) {
      const where = groupBy === 'model' ? 'shown as n/a' : 'run `costlog by model` to see which';
      console.log(`${compact(totals.unpricedTokens)} tokens have no known price: ${where}.`);
    }
    console.log('cacheR/cacheW: tokens read from and written to the prompt cache.');
    console.log(`Prices: LiteLLM, ${pricedAt}.`);
    if (cursorResponses.length) {
      console.log(`Cursor: ${cursorResponses.length} responses, ${cursorCounted} with token counts, so no cost is shown.`);
      console.log('Its full usage lives on Cursor servers. Rows are dated by conversation start.');
    }
    console.log(`${result.files} files, ${result.events.length} requests, ${result.warnings} unreadable lines.`);
  }
}
