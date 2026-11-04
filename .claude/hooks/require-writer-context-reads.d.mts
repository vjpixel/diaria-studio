export const REQUIRED_READS: Readonly<Record<string, readonly string[]>>;
export const MAX_DENIES: number;
export function defaultRegistryDir(): string;
export function normalizePath(p: unknown): string;
export function readCovers(readPath: string, required: string): boolean;
export function missingRequiredReads(
  agentType: string,
  readPaths: string[],
  opts?: { root?: string; exists?: (p: string) => boolean },
): string[];
export const REGISTRY_MAX_AGE_MS: number;
export function readRegistry(dir: string, agentId: string): { reads: string[]; denies: number; allowLogged: boolean };
export function pruneRegistry(dir: string, nowMs?: number, maxAgeMs?: number): number;
export function denyReason(missing: string[], root?: string): string;
export type HandleResult =
  | { action: "skip" | "record" }
  | { action: "allow"; capped?: boolean; missing?: string[] }
  | { action: "deny"; missing: string[]; reason: string };
export function handlePayload(
  payload: unknown,
  opts?: {
    dir?: string;
    root?: string;
    exists?: (p: string) => boolean;
    nowMs?: number;
    log?: (
      root: string,
      agent: string,
      level: "info" | "warn" | "error",
      message: string,
      details?: Record<string, unknown>,
    ) => void;
  },
): HandleResult;
