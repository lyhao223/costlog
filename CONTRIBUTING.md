# Contributing

## Ground rules

- A number that might be wrong gets a label or is left out. Report unknown prices as unpriced, partial data as partial, and snapshots as snapshots.
- No network calls in the CLI. `test/trust.test.ts` fails if a command opens a socket.
- No prompt or response text in memory longer than a parse needs it, and none in output or the cache. The same test checks this.
- No runtime dependencies. The CLI uses the Node standard library only.

## Setup

Node 22.18 or newer runs the TypeScript sources directly. `npm install` only fetches the type checker; the CLI itself has no dependencies.

```bash
npm install
npm test
node src/cli.ts doctor
```

## Adding an agent

1. Find where the agent writes usage on disk and which fields carry tokens, model, time and session. Check a real log. Documentation and other tools are often out of date.
2. Make a fixture. `scripts/anonymize.mjs` redacts every string outside a short allowlist, hashes ids, and refuses to write if input text survives.

   ```bash
   node scripts/anonymize.mjs path/to/session.jsonl fixtures/<agent>/<case>.jsonl
   ```

   Read the result before committing it. Add one fixture per log format the agent has used.
3. Add `src/adapters/<agent>.ts` implementing `Adapter` from `src/types.ts`:
   - `roots()` returns the directories or files it reads, with an environment variable override.
   - `locate(sinceMs)` returns the files modified since that time.
   - `parse(file)` returns `UsageEvent` objects. `input` excludes cached tokens. Give each event an id that stays the same across runs, so a re-scan never counts twice.
4. Register it in `src/core.ts` and bump `CACHE_VERSION`.
5. Add tests in `test/adapters.test.ts` with expected values computed independently of the adapter, and plant the agent's log shape in `test/trust.test.ts`.
6. Add a row to the table in `README.md` that says what the log can and cannot tell you.

An adapter never computes money and never guesses a missing field. If the log holds only part of the usage, set `partial: true` and the report shows no cost for it.

## Node versions

The published CLI targets Node 20. Type definitions are pinned to Node 20 so the type checker rejects newer APIs. An API that only exists on a newer Node needs a guarded dynamic import, a local type declaration like `src/node-sqlite.d.ts`, and an `unsupported` result on older runtimes.

## Changing output

`--json` field names are pinned in `test/cli.test.ts`. Adding a field is fine. Renaming or removing one needs a `schemaVersion` bump. Tables must fit 80 columns; the same file checks that with long values.

## Demo image

`docs/demo.gif` is built from the made-up logs in `scripts/demo.mjs`, never from real usage. To rebuild it on macOS with ffmpeg installed:

```bash
node scripts/render-demo.mjs
qlmanage -t -s 1420 -o /tmp docs/demo-1.svg docs/demo-2.svg
cp /tmp/demo-1.svg.png /tmp/f1.png && cp /tmp/demo-2.svg.png /tmp/f2.png
ffmpeg -y -framerate 1/4 -i /tmp/f%d.png -vf "crop=1420:760:0:0,scale=710:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" -loop 0 docs/demo.gif
```

## Commits

One subject line in the form `type(scope): description`, imperative, no trailing period.
