export function normalizeArgv(argv: string[]): string[];
export function isPublishingInvocation(argv: string[]): boolean;
export function requiresStdin(argv: string[]): boolean;
export function collectTextsToCheck(
  argv: string[],
  deps?: { readFileSync?: (path: string) => string; stdinText?: string },
): string[];
export function evaluateGhInvocation(
  argv: string[],
  deps?: { readFileSync?: (path: string) => string; stdinText?: string },
): { blocked: boolean; secrets?: string[] };
