export const MERGE_GRANT_LEDGER_PREFIX: string;
export const MERGE_GRANT_LEDGER_RETENTION_MS: number;

export interface LedgerGrantLike {
  grantedBy: string;
  grantedTo: string;
  grantedAt: string;
  pr?: number;
  repo?: string;
  consumedAt?: string;
}

export function mergeGrantIdentityKey(grant: Partial<LedgerGrantLike> | null | undefined): string | null;
export function mergeGrantLedgerPath(repoRoot: string, granteeSessionId: string): string;
export function readMergeGrantConsumptions(repoRoot: string): Map<string, string>;
export function ledgerConsumedAt(
  ledger: Map<string, string>,
  grant: Partial<LedgerGrantLike> | null | undefined,
): string | undefined;
export function recordMergeGrantConsumption(
  repoRoot: string,
  grant: LedgerGrantLike,
  consumedAt: string,
  now?: number,
): boolean;
export function sessionFileIsLocal(fileName: string, kind: string, localTag: string): boolean;
