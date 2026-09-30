export function stripHeredocSpans(command: string): string;
export function maskQuotedSpans(segment: unknown, options?: { tokensAnywhere?: boolean }): string;
export function shellWrapperPayload(segment: unknown): string | null;
export function commandSegments(command: unknown, depth?: number): string[];
export function isNpmInstallSegment(segment: string): boolean;
export function npmPrefixArg(segment: string): string | null;
export function cdTarget(segment: string): string | null;
export function nodeModulesEscapesDir(dir: string): string | null;
export function findBlockedNpmInstall(
  command: unknown,
  cwd: string,
  inspect?: (dir: string) => string | null,
): { dir: string; target: string } | null;
export function blockReason(args: { dir: string; target: string }): string;
