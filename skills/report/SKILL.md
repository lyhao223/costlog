---
name: report
description: Report what local coding-agent usage (Claude Code, Codex CLI, Copilot CLI, Cursor) would cost at API list prices, whether a subscription paid off, and Codex quota windows. Use when the user asks about agent spend, token cost, plan value, or how much quota is left.
argument-hint: "[by model | by project | windows] [--since YYYY-MM-DD] [--plan-price claude=200,codex=200]"
allowed-tools: Bash(npx --yes costlog *)
---

Run costlog with the user's arguments and report what it prints. It reads local log files only and makes no network calls.

```bash
npx --yes costlog $ARGUMENTS --json
```

With no arguments it covers the last 30 days by day and agent. Useful forms:

- `by model` or `by project` for a breakdown.
- `windows` for quota windows recorded in the logs.
- `--plan-price claude=200,codex=200` to compare usage with what the user pays per month.
- `doctor` when the output is empty or looks wrong.

When you summarise the result:

- `apiEquivalentUsd` is the list price of the tokens. It is not a bill. On a subscription the user did not pay it.
- `unpricedTokens` are models with no known price. Report them separately; never count them as zero cost.
- Cursor rows are never priced, because Cursor stores token counts for only a small share of responses.
- Quota windows are snapshots from the last local session, not live values. Say how old they are.
- `planValue[].ratio` is API-equivalent cost divided by what the user paid for the period, assuming the plan was active throughout.
- Exit code 3 means no agent logs were found; suggest `npx --yes costlog doctor`.
