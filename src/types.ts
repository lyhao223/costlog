export type AgentId = 'claude-code' | 'codex' | 'copilot-cli' | 'cursor';

export interface UsageEvent {
  id: string;
  agent: AgentId;
  timestamp: string;
  model: string;
  sessionId?: string;
  cwd?: string;
  // input excludes cached tokens; output includes reasoning
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; reasoning?: number };
  tier?: 'standard' | 'priority';
  // token counts cover only part of the usage, so no cost is derived from them
  partial?: boolean;
  plan?: string;
}

export interface UsageWindow {
  agent: AgentId;
  account: string;
  plan?: string;
  limit?: string;
  label: string;
  windowMinutes: number;
  usedPercent: number;
  limitHit?: boolean;
  resetsAt: string;
  observedAt: string;
}

export interface ParseResult {
  events: UsageEvent[];
  windows: UsageWindow[];
  warnings: number;
  // set when this runtime cannot read the source at all; such a result is never cached
  unsupported?: string;
}

export interface Adapter {
  id: AgentId;
  roots(): string[];
  locate(sinceMs: number): Promise<string[]>;
  parse(file: string): Promise<ParseResult>;
}
