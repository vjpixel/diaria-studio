export const NOW_MS_SQL: string;
export const ACQUIRE_SQL: string;
export const READ_SQL: string;
export const D1_HOOK_TIMEOUT_MS: number;
export const MERGE_GRANT_CONSUMED_D1_TTL_MS: number;

export interface HookD1Client {
  query(sql: string, params: string[]): Promise<{ results: Record<string, unknown>[] }>;
}

export type HookD1Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function mergeLockD1Name(repo: string): string;
export function mergeGrantConsumedD1Name(grant: { grantedBy: string; grantedTo: string; grantedAt: string }): string;
export function combineWithD1LockHolders<T extends string | null | undefined>(
  localHolder: T,
  d1Holders: Array<string | null>,
  callerSessionId: string,
): T | string;
export function readEnvKeys(envFile: string, keys: string[]): Record<string, string>;
export function d1LocksClientForHook(
  repoRoot: string,
  env?: Record<string, string | undefined>,
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>,
): { client: HookD1Client | null; reason: string };
export function loopbackApiBase(env?: Record<string, string | undefined>): string | null;
export function createD1RestClient(cfg: {
  apiBase?: string;
  accountId: string;
  token: string;
  databaseId: string;
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}): HookD1Client;
export function d1ReadLockHolder(client: HookD1Client, name: string): Promise<HookD1Result<string | null>>;
export function d1ClaimOnce(
  client: HookD1Client,
  name: string,
  holder: string,
  ttlMs: number,
): Promise<HookD1Result<"claimed" | "already">>;
