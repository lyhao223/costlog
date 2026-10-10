// Node 20 type definitions have no node:sqlite; this declares the part costlog uses, and the import is guarded at runtime.
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
    close(): void;
  }
}
