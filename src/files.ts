import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

export async function findFiles(root: string, match: (name: string) => boolean, sinceMs: number): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!match(basename(entry))) continue;
    const path = join(root, entry);
    if ((await stat(path)).mtimeMs >= sinceMs) files.push(path);
  }
  return files;
}

export function readLines(file: string): AsyncIterable<string> {
  return createInterface({ input: createReadStream(file), crlfDelay: Infinity });
}
