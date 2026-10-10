import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, ParseResult, UsageEvent } from '../types.ts';

function database(): string {
  if (process.env.CURSOR_STATE_DB) return process.env.CURSOR_STATE_DB;
  const tail = join('Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', tail);
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), tail);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), tail);
}

// Only these fields leave SQLite; message text stays in the database.
const CONVERSATIONS = `
  select substr(key, 14) as id, json_extract(value, '$.createdAt') as createdAt, json_extract(value, '$.modelConfig.modelName') as model
  from cursorDiskKV where key like 'composerData:%' and json_valid(value)`;
const RESPONSES = `
  select key, json_extract(value, '$.tokenCount.inputTokens') as input, json_extract(value, '$.tokenCount.outputTokens') as output
  from cursorDiskKV where key like 'bubbleId:%' and json_valid(value) and json_extract(value, '$.type') = 2`;

export const cursor: Adapter = {
  id: 'cursor',
  roots: () => [database()],
  async locate(sinceMs) {
    try {
      return (await stat(database())).mtimeMs >= sinceMs ? [database()] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  },

  async parse(file): Promise<ParseResult> {
    let sqlite: typeof import('node:sqlite');
    // Node 22 prints an ExperimentalWarning the first time node:sqlite loads; a report should not start with one.
    const emitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      if (!String(warning).includes('SQLite')) (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      sqlite = await import('node:sqlite');
    } catch {
      process.emitWarning = emitWarning;
      return { events: [], windows: [], warnings: 0, unsupported: 'reading the Cursor database needs Node 22.5 or newer' };
    }
    process.emitWarning = emitWarning;
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    try {
      const conversations = new Map<string, { createdAt: number; model: string }>();
      for (const row of db.prepare(CONVERSATIONS).all() as any[]) {
        if (typeof row.createdAt === 'number') conversations.set(row.id, { createdAt: row.createdAt, model: row.model ?? 'unknown' });
      }
      const events: UsageEvent[] = [];
      let warnings = 0;
      for (const row of db.prepare(RESPONSES).all() as any[]) {
        const [, conversationId, responseId] = String(row.key).split(':');
        const conversation = conversations.get(conversationId);
        if (!conversation || !responseId) {
          warnings++;
          continue;
        }
        events.push({
          id: `cursor:${responseId}`,
          agent: 'cursor',
          // ponytail: Cursor stores no per-response time, so a response is dated by the start of its conversation.
          timestamp: new Date(conversation.createdAt).toISOString(),
          model: conversation.model,
          sessionId: conversationId,
          partial: true,
          tokens: { input: row.input ?? 0, output: row.output ?? 0, cacheRead: 0, cacheWrite: 0 },
        });
      }
      return { events, windows: [], warnings };
    } finally {
      db.close();
    }
  },
};
