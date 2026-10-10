# Log formats and accuracy notes

What was measured while building costlog, on one macOS machine in October 2026. Figures are ratios and percentages; absolute usage is left out on purpose.

## Why costlog exists in this shape

A survey before the first line of code found that reading several agents, working offline and being fast were already covered: ccusage 20.0.28 reads 18 agents and has an offline mode, tokscale 4.18.0 lists more than 50 clients. Two things were not covered and became the scope:

| Gap | Evidence |
|---|---|
| Saying which usage ran on a subscription | Both tools print a plain cost column. Codex logs record `plan_type`. |
| Quota windows without a network call | `ccusage codex blocks` answers that blocks are Claude Code only. `tokscale usage` returns nothing with the network blocked and reports only the signed-in account. Codex logs carry `rate_limits` for every account that ran locally. |

## Accuracy against ccusage

One month of the same logs, ccusage 20.0.28:

| Agent | Input | Output | Cache read | Cache write | Cost |
|---|---|---|---|---|---|
| Claude Code | -0.18% | -0.05% | -0.25% | -0.02% | -0.09% |
| Codex | -0.04% | -0.01% | -0.01% | 0 | +1.16% on models both tools price |

The two largest Codex models match ccusage to within 0.002% of their cost. The whole Codex gap sat in `gpt-6-sol`, `gpt-6.1-sol` and `gpt-6-luna`, where ccusage 20.0.28 applied no Fast-mode multiplier: its fast/standard cost ratio was 2.000 for the models in its override table and 1.000 for these three. OpenAI documents 2x for all three. Reported as [ccusage/ccusage#1852](https://github.com/ccusage/ccusage/issues/1852) and fixed in ccusage the same day (pull request 1855, merged 2026-10-10, after 20.0.28).

ccusage and tokscale disagreed with each other by about 7% in dollars on the same month while agreeing within 0.3% on tokens. The difference comes from how each decides which requests ran in Fast mode and from the long-context tier, so neither is shown to be wrong.

## Pricing rules that matter

- Codex cost roughly doubles when `service_tier = "priority"`. The tier is read from `thread_settings_applied` events in the rollout, then from the top level of `config.toml` for sessions that never record it.
- A request whose prompt crosses the model's long-context threshold (272k tokens for current OpenAI models) is repriced as a whole.
- Claude cache writes have a separate one-hour rate; `usage.cache_creation.ephemeral_1h_input_tokens` gives the split.
- Models reached through Codex with a custom provider (Qwen, GLM, DeepSeek here) have no LiteLLM price. They are reported as unpriced.

## Claude Code

- One response is written once per streamed content block. In the largest local session, usage rows outnumber unique responses 3.7 to 1. Dedupe on `message.id`; `requestId` can be absent.
- About three quarters of the JSONL files sit in nested `subagents` directories, so discovery must recurse.
- No running quota is logged. Rows with `quotaLimits.status = "rejected"` carry `rateLimitType` (`five_hour`) and `resetsAt`, which is the only window signal.
- The subscription plan is never recorded.

## Codex CLI

- Rollout files live in `sessions/` and `archived_sessions/`. Reading `sessions/` alone undercounts a month by about 10%.
- 27 distinct `cli_version` values appeared in three months, so parsing is chosen by field presence, not version string.
- From CLI 0.153 a `token_usage_record` row carries `response_id`, which is the dedupe key. Older files only have `token_count` events; an event whose running `total_tokens` did not change is a repeat.
- Some `token_count` events have `info: null`, and `total_tokens` sometimes decreases within a session, so usage cannot be derived from deltas of the total.
- `token_count.rate_limits` holds `plan_type`, `limit_id`, and `primary`/`secondary` windows with `used_percent`, `window_minutes` and `resets_at`.
- `creator_account_id` exists only from CLI 0.159. Older sessions cannot be told apart by account.
- Known ceiling: a file is read as all records or all counts, so a session that spans the 0.153 change counts only its newer part.

## Copilot CLI

- Tokens appear only in `session.shutdown.modelMetrics`, so an open or crashed session reports nothing.
- `usage.inputTokens` includes cache reads and writes. On every shutdown record checked, `inputTokens - cacheReadTokens - cacheWriteTokens` equals `tokenDetails.input.tokenCount` exactly.
- The one session with two shutdowns had empty metrics on the second and no assistant messages between them, so metrics are treated as per segment and added up. This rests on a single sample.
- Premium-request counts are logged. The subscription plan is not.

## Cursor

- Response rows (`bubbleId:<conversation>:<id>`, `type = 2`) carry `tokenCount` but no time and no model. Both come from the conversation row (`composerData:<id>`: `createdAt`, `modelConfig.modelName`).
- About 5% of responses have a non-zero token count. Some model names match the price table, which would price a small sample as if it were the whole, so Cursor events are marked partial and never priced.
- Only the macOS database path has been verified.

## Gemini CLI

Not supported. In October 2026 a personal Google login was refused with "This client is no longer supported for Gemini Code Assist for individuals" and a pointer to Antigravity, and Homebrew marks the `gemini-cli` formula as deprecated. No session with a model reply could be produced, so there is no real log to verify token fields against.

What the attempt did show: CLI 0.20 wrote one JSON document per session to `~/.gemini/tmp/<project hash>/chats/session-*.json`, and CLI 0.46 writes JSONL to `~/.gemini/tmp/<project name>/chats/session-*.jsonl`, with a header row followed by `$set` patches and message rows.

## Cache

A file's parse result is reused while its size and mtime are unchanged. A cold one-month scan took about 9 s and a warm one about 0.2 s. Two limits:

- The Codex tier taken from `config.toml` is stored with cached events, so changing `service_tier` needs `--no-cache` to reprice old sessions.
- `CACHE_VERSION` in `src/core.ts` must be bumped whenever an adapter's output changes.

## Fixtures

`scripts/anonymize.mjs` redacts every string except an allowlist of enum-like keys, hashes ids so dedupe relationships survive, and refuses to write if a redacted input string of 12 or more characters reappears in an output value. Object keys that look like identifiers are kept as-is, and timestamps are kept, so read a fixture before publishing it.
